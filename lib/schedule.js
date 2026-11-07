// Запись расписания в базу: импорт xlsx (с подтверждением), правки уроков, звонков, замен и объявлений.
// Каждое действие пишется в журнал. Подсветка изменений ставится только там, где изменение сделано явно
// (в админке) или подтверждено при импорте.
const crypto = require('crypto');
const { db, audit } = require('./db');
const { bump } = require('./sync');
const { parseWorkbook, parseSubsFile, diffWith, bKeyOf, lessonList, expandClass } = require('./schedule-import');

const now = () => Date.now();
// воскресенье — выходной: замены и изменения звонков на него не ставим
const isSunday = iso => new Date(iso + 'T12:00:00Z').getUTCDay() === 0;
const NO_SUNDAY = 'Воскресенье — выходной: замены и изменения звонков на него не ставятся';
const who = user => user;

// ---------- импорт: предпросмотр → подтверждение ----------
const previews = new Map(); // token → { parsed, diff, at, user }
function prunePreviews() { for (const [k, v] of previews) if (now() - v.at > 20 * 60e3) previews.delete(k); }

function currentSnapshot() {
  return {
    lessons: db.prepare('SELECT cls, day, n, subject, teacher, room FROM lessons').all(),
    bells: db.prepare('SELECT n, title, start_t AS start, end_t AS end, classes, meal FROM bells').all()
  };
}

function previewImport(buf, user) {
  prunePreviews();
  const parsed = parseWorkbook(buf);
  if (!parsed.lessons.length && !parsed.bells.length) throw Object.assign(new Error('В файле не нашли ни расписания, ни звонков. Проверьте названия листов: «Расписание», «Звонки», «Замены».'), { code: 400 });
  const cur = currentSnapshot();
  // учитель в матрице не указан: сохраняем уже введённых учителей
  const teacherOf = new Map(db.prepare('SELECT cls, day, n, teacher FROM lessons').all().map(l => [`${l.cls}|${l.day}|${l.n}`, l.teacher]));
  for (const L of parsed.lessons) if (!L.teacher) L.teacher = teacherOf.get(`${L.cls}|${L.day}|${L.n}`) || '';
  const diff = diffWith(cur, parsed);
  const token = crypto.randomBytes(12).toString('hex');
  previews.set(token, { parsed, at: now(), user: user && user.id });
  return {
    token,
    counts: { lessons: parsed.lessons.length, classes: new Set(parsed.lessons.map(l => l.cls)).size, bells: parsed.bells.length, meals: parsed.bells.filter(b => b.meal).length, subs: parsed.subs.length },
    warnings: parsed.warnings,
    first_load: !diff.hadBefore,
    changes: diff.changes.slice(0, 400), changes_total: diff.changes.length,
    bell_changes: diff.bellChanges
  };
}

function commitImport(token, markChanges, user) {
  const p = previews.get(String(token));
  if (!p) throw Object.assign(new Error('Предпросмотр устарел. Загрузите файл ещё раз.'), { code: 400 });
  previews.delete(String(token));
  const { parsed } = p;
  const cur = currentSnapshot();
  const diff = diffWith(cur, parsed);
  const mark = !!markChanges && diff.hadBefore;
  const t = now();
  db.exec('BEGIN');
  let droppedExc = [];
  try {
    // уроки
    const oldL = new Map(db.prepare('SELECT * FROM lessons').all().map(l => [`${l.cls}|${l.day}|${l.n}`, l]));
    db.exec('DELETE FROM lessons');
    const ins = db.prepare('INSERT INTO lessons(cls,day,n,subject,teacher,room,was_subject,was_teacher,was_room,changed_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (const L of parsed.lessons) {
      const o = oldL.get(`${L.cls}|${L.day}|${L.n}`);
      const changed = mark && o && (o.subject !== L.subject || o.room !== L.room);
      const keepWas = o && o.changed_at && !changed; // прежнюю подсветку сохраняем
      ins.run(L.cls, L.day, L.n, L.subject, L.teacher, L.room,
        changed ? o.subject : (keepWas ? o.was_subject : null), changed ? o.teacher : (keepWas ? o.was_teacher : null),
        changed ? o.room : (keepWas ? o.was_room : null), changed ? t : (keepWas ? o.changed_at : null));
    }
    // звонки
    // исключения звонков на даты (перенос, отмена) запоминаем по ключу звонка и возвращаем на тот же звонок после импорта
    const oldB = new Map(db.prepare('SELECT * FROM bells').all().map(b => [bKeyOf({ n: b.n, meal: b.meal, title: b.title, classes: b.classes }), b]));
    const oldExc = db.prepare('SELECT e.*, b.n, b.title, b.meal, b.classes FROM bell_exceptions e JOIN bells b ON b.id=e.bell_id').all();
    db.exec('DELETE FROM bell_exceptions');
    db.exec('DELETE FROM bells');
    const insB = db.prepare('INSERT INTO bells(n,title,start_t,end_t,classes,meal,sort,was_start,was_end,changed_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const newIdByKey = new Map();
    parsed.bells.forEach((b, i) => {
      const o = oldB.get(bKeyOf(b));
      const changed = mark && o && (o.start_t !== b.start || o.end_t !== b.end);
      const info = insB.run(b.n, b.title, b.start, b.end, b.classes, b.meal, i,
        changed ? o.start_t : null, changed ? o.end_t : null, changed ? t : null);
      newIdByKey.set(bKeyOf(b), Number(info.lastInsertRowid));
    });
    const insE = db.prepare('INSERT INTO bell_exceptions(bell_id,date_from,date_to,start_t,end_t,cancelled,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)');
    for (const e of oldExc) {
      const newId = newIdByKey.get(bKeyOf({ n: e.n, meal: e.meal, title: e.title, classes: e.classes }));
      if (newId) insE.run(newId, e.date_from, e.date_to, e.start_t, e.end_t, e.cancelled, e.created_by, e.created_at);
      else droppedExc.push(`${e.meal ? e.title : 'урок ' + e.n}, ${e.date_from}`);
    }
    // замены из файла заменяют прежние замены, введённые из того же файла; введённые вручную остаются
    if (parsed.subs.length) {
      db.prepare("DELETE FROM subs WHERE created_by = 'Импорт xlsx'").run();
      const insS = db.prepare('INSERT INTO subs(date,lessons,cls,subject,room,teacher,absent,note,group_key,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for (const s of parsed.subs) insS.run(s.date, s.lessons, s.cls, s.subject, s.room, s.teacher, s.absent, s.note, '', 'Импорт xlsx', t);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  const mode = mark ? ' (с подсветкой изменений)' : '';
  audit({ user, action: 'schedule_imported', target: 'Файл расписания', now: `уроков ${parsed.lessons.length}, звонков ${parsed.bells.length}, замен ${parsed.subs.length}${mode}`, details: droppedExc.length ? `пропали исключения звонков (${droppedExc.length}): ${droppedExc.join('; ')}` : '' });
  if (mark) {
    for (const c of diff.changes) {
      if (c.type === 'changed') audit({ user, action: 'lesson_changed', target: `${c.cls}, ${['Пн','Вт','Ср','Чт','Пт','Сб'][c.day]}, урок ${c.n}`, was: c.was, now: c.now, details: 'из файла' });
      else if (c.type === 'added') audit({ user, action: 'lesson_added', target: `${c.cls}, ${['Пн','Вт','Ср','Чт','Пт','Сб'][c.day]}, урок ${c.n}`, now: c.now, details: 'из файла' });
      else audit({ user, action: 'lesson_removed', target: `${c.cls}, ${['Пн','Вт','Ср','Чт','Пт','Сб'][c.day]}, урок ${c.n}`, was: c.was, details: 'из файла' });
    }
  }
  bump();
  return { ok: true, lessons: parsed.lessons.length, bells: parsed.bells.length, subs: parsed.subs.length, marked: mark ? diff.changes.length : 0, bell_exceptions_dropped: droppedExc };
}

// ---------- уроки ----------
const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

// ---------- звонки ----------
// Звонки на дату или промежуток дат: новое время или отмена урока (для всех классов)
const shortD = iso => iso.split('-').reverse().slice(0, 2).join('.');
function addBellException(b, user) {
  const bell = db.prepare('SELECT * FROM bells WHERE id=?').get(Number(b.bell_id));
  if (!bell) throw Object.assign(new Error('Выберите звонок'), { code: 400 });
  const from = String(b.date_from || '').trim(), to = String(b.date_to || '').trim() || from;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw Object.assign(new Error('Укажите даты: с какой по какую'), { code: 400 });
  if (isSunday(from) || isSunday(to)) throw Object.assign(new Error(NO_SUNDAY), { code: 400 });
  const cancelled = b.cancelled === true || b.cancelled === '1' || b.cancelled === 'true';
  let start = null, end = null;
  if (!cancelled) {
    start = String(b.start || '').trim(); end = String(b.end || '').trim();
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start >= end) throw Object.assign(new Error('Время в формате ЧЧ:ММ, конец позже начала'), { code: 400 });
  }
  const label = bell.meal ? bell.title : `урок ${bell.n}`;
  const info = db.prepare('INSERT INTO bell_exceptions(bell_id,date_from,date_to,start_t,end_t,cancelled,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(bell.id, from, to, start, end, cancelled ? 1 : 0, user.name, now());
  audit({ user, action: 'bell_exception_added', target: `${label}; ${shortD(from)}${to !== from ? '–' + shortD(to) : ''}`, now: cancelled ? 'урок отменён' : `${start}–${end}` });
  bump();
  return { ok: true, id: Number(info.lastInsertRowid) };
}
function deleteBellException(id, user) {
  const old = db.prepare('SELECT e.*, b.n, b.title, b.meal FROM bell_exceptions e JOIN bells b ON b.id=e.bell_id WHERE e.id=?').get(id);
  if (!old) return { ok: true };
  db.prepare('DELETE FROM bell_exceptions WHERE id=?').run(id);
  audit({ user, action: 'bell_exception_removed', target: `${old.meal ? old.title : 'урок ' + old.n}; ${shortD(old.date_from)}` });
  bump();
  return { ok: true };
}
function listBellExceptions() {
  return db.prepare('SELECT e.id, e.bell_id, e.date_from, e.date_to, e.start_t AS start, e.end_t AS end, e.cancelled, b.n, b.title, b.meal FROM bell_exceptions e JOIN bells b ON b.id=e.bell_id ORDER BY e.date_from, e.id')
    .all().map(x => ({ ...x, cancelled: !!x.cancelled, meal: !!x.meal }));
}

// Замены файлом завуча: предпросмотр → подтверждение. Меняются только даты из файла.
const shortDate = iso => iso.split('-').reverse().slice(0, 2).join('.');
function previewSubsFile(buf, user) {
  const parsed = parseSubsFile(buf);
  const { warnings, sheet } = parsed;
  // строки на воскресенье из файла пропускаем с предупреждением
  const subs = parsed.subs.filter(x => !isSunday(x.date));
  const sundayRows = parsed.subs.length - subs.length;
  if (sundayRows) warnings.push(`Строки на воскресенье пропущены: ${sundayRows} шт. Воскресенье — выходной`);
  if (!subs.length) throw Object.assign(new Error(warnings[0] || 'В файле не нашли замен'), { code: 400 });
  const dates = [...new Set(subs.map(x => x.date))].sort();
  const token = crypto.randomBytes(12).toString('hex');
  prunePreviews();
  previews.set(token, { kind: 'subs', subs, dates, at: now(), user: user && user.id });
  return { token, sheet, dates, warnings, counts: { rows: subs.length, classes: new Set(subs.map(x => x.cls)).size }, rows: subs.slice(0, 400) };
}
function commitSubsFile(token, user) {
  prunePreviews();
  const p = previews.get(String(token));
  if (!p || p.kind !== 'subs') throw Object.assign(new Error('Проверка устарела, загрузите файл ещё раз'), { code: 400 });
  previews.delete(String(token));
  const by = `Файл завуча (${user.name})`;
  db.exec('BEGIN');
  try {
    for (const d of p.dates) db.prepare("DELETE FROM subs WHERE date=? AND created_by LIKE 'Файл завуча%'").run(d);
    const ins = db.prepare('INSERT INTO subs(date,lessons,cls,subject,room,teacher,absent,note,group_key,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for (const x of p.subs) ins.run(x.date, x.lessons, x.cls, x.subject, x.room, x.teacher, x.absent, x.note, '', by, now());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit({ user, action: 'subs_imported', target: p.dates.map(shortDate).join(', '), now: `${p.subs.length} строк` });
  bump();
  return { ok: true, saved: p.subs.length };
}

// Изменения уроков на одну дату (таблица «Замены → Изменения на дату»).
// items: [{cls, n, subject, room, teacher}] — только изменённые ячейки.
// Предмет «отменён» = урок отменён для класса. Пустая ячейка ничего не меняет.
function saveSubsDay(b, user) {
  const date = String(b.date || '');
  const dt = new Date(date + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(dt) || dt.toISOString().slice(0, 10) !== date) throw Object.assign(new Error('Укажите дату'), { code: 400 });
  if (isSunday(date)) throw Object.assign(new Error(NO_SUNDAY), { code: 400 });
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw Object.assign(new Error('Ничего не изменено'), { code: 400 });
  if (items.length > 400) throw Object.assign(new Error('Слишком много изменений за раз'), { code: 400 });
  let saved = 0;
  const ins = db.prepare('INSERT INTO subs(date,lessons,cls,subject,room,teacher,absent,note,group_key,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const it of items) {
      const cls = String(it.cls || '').toUpperCase().replace(/\s/g, '').slice(0, 6);
      const n = Number(it.n);
      if (!cls || !(n >= 1 && n <= 20)) throw Object.assign(new Error('Проверьте класс и номер урока'), { code: 400 });
      let subject = String(it.subject || '').trim().slice(0, 120);
      const room = String(it.room || '').trim().slice(0, 40), teacher = String(it.teacher || '').trim().slice(0, 80);
      if (!subject && !room && !teacher) continue;
      if (/^(урок\s+)?отмен[её]н$/i.test(subject)) subject = 'урок отменён';
      db.prepare('DELETE FROM subs WHERE date=? AND cls=? AND lessons=?').run(date, cls, String(n));
      ins.run(date, String(n), cls, subject, room, teacher, '', '', '', user.name, now());
      saved++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit({ user, action: 'substitution_added', target: `${shortDate(date)}: ячеек ${saved}`, details: date });
  bump();
  return { ok: true, saved };
}

// ---------- замены ----------
function addSubs(b, user, source = 'admin') {
  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error('Укажите дату замены'), { code: 400 });
  if (isSunday(date)) throw Object.assign(new Error(NO_SUNDAY), { code: 400 });
  // классы: «8аб» — 8А и 8Б одной группой; через запятую — отдельные группы
  const groups = String(b.classes || '').split(/[,;]/).map(x => x.trim()).filter(Boolean).map(part => expandClass(part.replace(/\s/g, '')));
  if (!groups.length) throw Object.assign(new Error('Укажите классы, например: 8А, 8Б'), { code: 400 });
  if (!String(b.lessons || '').trim()) throw Object.assign(new Error('Укажите урок: номер или диапазон, например 3 или 1-6'), { code: 400 });
  let subject = String(b.subject || '').trim().slice(0, 120);
  if (/^(урок\s+)?отмен[её]н$/i.test(subject)) subject = 'урок отменён'; // «отменён» = урок отменён, как и в таблице изменений на дату
  if (!subject && !String(b.teacher || '').trim() && !String(b.room || '').trim()) throw Object.assign(new Error('Укажите учителя, кабинет или предмет замены'), { code: 400 });
  const lessonsStr = String(b.lessons || '').trim().slice(0, 20);
  // те же правила пар, что и для файла завуча: «1-3» на три класса — по порядку; один урок — всем; один класс — все уроки ему
  const lessons = lessonsStr ? lessonList(lessonsStr) : [];
  if (lessonsStr && !lessons.length) throw Object.assign(new Error('Номер урока: например 3 или 1-3'), { code: 400 });
  let pairs = [];
  if (!lessons.length) pairs = groups.flatMap(g => g.map(cls => ({ cls, n: '' })));
  else if (lessons.length === 1) pairs = groups.flatMap(g => g.map(cls => ({ cls, n: String(lessons[0]) })));
  else if (groups.length === 1) pairs = lessons.flatMap(n => groups[0].map(cls => ({ cls, n: String(n) })));
  else if (groups.length === lessons.length) pairs = groups.flatMap((g, k) => g.map(cls => ({ cls, n: String(lessons[k]) })));
  else throw Object.assign(new Error(`Уроков ${lessons.length}, а групп классов ${groups.length}. Укажите так, чтобы совпало: например «1-3» и три класса через запятую`), { code: 400 });
  const row = { subject, room: String(b.room || '').trim().slice(0, 40), teacher: String(b.teacher || '').trim().slice(0, 80), absent: String(b.absent || '').trim().slice(0, 80), note: String(b.note || '').trim().slice(0, 120) };
  const ins = db.prepare('INSERT INTO subs(date,lessons,cls,subject,room,teacher,absent,note,group_key,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try { for (const x of pairs) ins.run(date, x.n, x.cls, row.subject, row.room, row.teacher, row.absent, row.note, '', user.name, now()); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  const classes = [...new Set(pairs.map(x => x.cls))];
  audit({ source, user, action: 'substitution_added', target: `${classes.join(', ')}; ${lessonsStr || '—'} ур.`, now: [row.subject, row.room && 'к.' + row.room, row.teacher, row.absent && 'вместо ' + row.absent].filter(Boolean).join(', '), details: date });
  bump();
  return { ok: true, count: pairs.length };
}
function deleteSubs(ids, user) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
  if (!list.length) return { ok: true };
  const rows = db.prepare(`SELECT * FROM subs WHERE id IN (${list.map(() => '?').join(',')})`).all(...list);
  db.prepare(`DELETE FROM subs WHERE id IN (${list.map(() => '?').join(',')})`).run(...list);
  if (rows.length) audit({ user, action: 'substitution_removed', target: `${[...new Set(rows.map(r => r.cls))].join(', ')}; ${rows[0].lessons || '—'} ур.`, was: [rows[0].subject, rows[0].room && 'к.' + rows[0].room, rows[0].absent && 'вместо ' + rows[0].absent].filter(Boolean).join(', '), details: rows[0].date });
  bump();
  return { ok: true };
}

// ---------- объявления ----------
function saveAnnouncement(id, b, user) {
  const title = String(b.title || '').trim().slice(0, 300);
  if (!title) throw Object.assign(new Error('Напишите текст объявления'), { code: 400 });
  const duration = Math.min(600, Math.max(3, parseInt(b.duration, 10) || 10));
  const priority = Math.min(5, Math.max(1, parseInt(b.priority, 10) || 1));
  const from = String(b.date_from || ''), to = String(b.date_to || '');
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) throw Object.assign(new Error('Даты в формате ГГГГ-ММ-ДД'), { code: 400 });
  const active = b.active === false ? 0 : 1;
  if (id) {
    const old = db.prepare('SELECT * FROM announcements WHERE id=?').get(id);
    if (!old) throw Object.assign(new Error('Объявление не найдено'), { code: 404 });
    db.prepare('UPDATE announcements SET title=?,duration=?,priority=?,date_from=?,date_to=?,active=? WHERE id=?').run(title, duration, priority, from, to, active, id);
    audit({ user, action: 'announcement_changed', target: title.slice(0, 60), was: old.title.slice(0, 60), now: title.slice(0, 60) });
  } else {
    const info = db.prepare('INSERT INTO announcements(title,duration,priority,date_from,date_to,active,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(title, duration, priority, from, to, active, user.name, now());
    audit({ user, action: 'announcement_added', target: title.slice(0, 60) });
    bump();
    return { ok: true, id: Number(info.lastInsertRowid) };
  }
  bump();
  return { ok: true, id };
}
function deleteAnnouncement(id, user) {
  const old = db.prepare('SELECT * FROM announcements WHERE id=?').get(id);
  if (!old) return { ok: true };
  db.prepare('DELETE FROM announcements WHERE id=?').run(id);
  audit({ user, action: 'announcement_removed', target: old.title.slice(0, 60) });
  bump();
  return { ok: true };
}

module.exports = { previewSubsFile, commitSubsFile, saveSubsDay, addBellException, deleteBellException, listBellExceptions, previewImport, commitImport, addSubs, deleteSubs, saveAnnouncement, deleteAnnouncement, DAYS };
