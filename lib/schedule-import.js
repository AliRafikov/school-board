// Разбор файла расписания (.xlsx) школы: листы «Расписание», «Звонки», «Замены».
// Excel портит время и номера уроков: «12.10» становится датой 12 октября, «1-6» — 1 июня.
// Здесь эти даты возвращаются обратно в текст. Ничего не пишет в базу — только разбор и предпросмотр.
const { readXlsx } = require('./xlsx-read');

const pad = n => String(n).padStart(2, '0');
const txt = v => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim();

// Время: дата Excel → «DD.MM» (дата 12 октября — это 12.10), число и строка — как есть
function asTime(v) {
  if (v instanceof Date) return `${pad(v.getUTCDate())}.${pad(v.getUTCMonth() + 1)}`;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v).replace('.', ':');
  return txt(v);
}
// Номер урока или диапазон («1-6»): дата 1 июня — это 1-6
function asRange(v) {
  if (v instanceof Date) return `${v.getUTCDate()}-${v.getUTCMonth() + 1}`;
  if (typeof v === 'number') return String(Math.round(v));
  return txt(v);
}
// Кабинет, номер или текст: 109.0 → «109»
function asRoom(v) {
  if (v instanceof Date) return asTime(v);
  if (typeof v === 'number') return String(Math.round(v));
  return txt(v);
}
const normTime = s => { const m = /^(\d{1,2})[.:](\d{2})$/.exec(String(s).trim()); return m ? `${pad(m[1])}:${m[2]}` : ''; };
const cls = s => txt(s).toUpperCase().replace(/\s/g, '');
const grade = c => parseInt(c, 10) || 0;

// «5–7 классы» → [5, 7]; «8 класс» → [8, 8]
function gradeRange(label) {
  const nums = (String(label).match(/\d+/g) || []).map(Number);
  if (!nums.length) return null;
  return [Math.min(...nums), Math.max(...nums)];
}
const inRange = (c, r) => !r || (grade(c) >= r[0] && grade(c) <= r[1]);

// ---------- Звонки ----------
// Строки: Название | Начало | Конец | Классы. Название — номер урока (1, 5…) или «ЗАВТРАК», «ОБЕД».
function parseBells(rows, warnings) {
  const out = [];
  const head = (rows[0] || []).map(c => txt(c).toLowerCase());
  const col = name => head.findIndex(h => h === name);
  const cName = col('название') >= 0 ? col('название') : 0;
  const cStart = col('начало') >= 0 ? col('начало') : 1;
  const cEnd = col('конец') >= 0 ? col('конец') : 2;
  const cCls = col('классы') >= 0 ? col('классы') : 3;
  for (const r of rows.slice(1)) {
    const name = asRange(r[cName]);
    if (!name) continue;
    const start = normTime(asTime(r[cStart])), end = normTime(asTime(r[cEnd]));
    const label = txt(r[cCls]);
    if (!start || !end) { warnings.push(`Звонки: строка «${name}» без правильного времени (${asTime(r[cStart])} – ${asTime(r[cEnd])})`); continue; }
    if (/^\d+$/.test(name)) out.push({ n: Number(name), title: '', start, end, classes: label, meal: 0 });
    else out.push({ n: 0, title: name.toUpperCase(), start, end, classes: label, meal: 1 });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

// ---------- Расписание (матрица): дни по строкам, классы — пара колонок «класс | каб» ----------
const DAY_NAMES = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
function findHead(rows) {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const r = (rows[i] || []).map(c => txt(c).toLowerCase());
    const t = r.indexOf('время');
    if (t >= 0) return { hi: i, ti: t };
    const k = r.findIndex((c, j) => /^\d{1,2}\s*[а-яa-z]$/i.test(c) && /^каб/.test(r[j + 1] || ''));
    if (k >= 1) return { hi: i, ti: k - 1 };
  }
  return null;
}

function parseMatrix(rows, bells, warnings) {
  const h = findHead(rows);
  if (!h) { warnings.push('Лист «Расписание»: не найдена строка с классами (ячейка «Время» или пара «5а | каб»)'); return []; }
  const head = rows[h.hi].map(c => txt(c));
  const cols = [];
  for (let c = h.ti + 1; c < head.length; c++) {
    const name = txt(head[c]);
    if (name && name.toLowerCase() !== 'каб') cols.push({ cls: cls(name), c });
  }
  let day = -1; const out = []; const starts = new Set();
  const lessonRows = [];
  for (const r of rows.slice(h.hi + 1)) {
    const dn = txt(r[h.ti - 1]).toLowerCase();
    if (dn) { const d = DAY_NAMES.findIndex(x => dn.startsWith(x.slice(0, 4))); if (d >= 0) day = d; }
    const m = /(\d{1,2})[.:](\d{2})\s*[-–—]\s*(\d{1,2})[.:](\d{2})/.exec(asTime(r[h.ti]));
    if (!m || day < 0) continue;
    const start = `${pad(m[1])}:${m[2]}`;
    starts.add(start);
    lessonRows.push({ day, start, r });
  }
  // номер урока: по звонкам (с учётом параллелей), иначе по порядку времени
  const sortedStarts = [...starts].sort();
  const numberFor = (c, start) => {
    const cands = bells.filter(b => !b.meal && b.start === start);
    const hit = cands.find(b => inRange(c, gradeRange(b.classes))) || cands.find(b => !b.classes) || cands[0];
    if (hit) return hit.n;
    return sortedStarts.indexOf(start) + 1;
  };
  const noBell = new Set();
  for (const { day: d, start, r } of lessonRows) {
    for (const { cls: c, c: col } of cols.map(x => ({ cls: x.cls, c: x.c }))) {
      const subject = txt(r[col]);
      if (!subject) continue;
      const cands = bells.filter(b => !b.meal && b.start === start);
      if (!cands.length) noBell.add(start);
      out.push({ cls: c, day: d, n: numberFor(c, start), subject, room: asRoom(r[col + 1]), teacher: '' });
    }
  }
  for (const s of noBell) warnings.push(`Расписание: урок в ${s} нет на листе «Звонки», номер урока угадан по порядку`);
  // дубли на одном месте: оставляем первый, предупреждаем
  const seen = new Map(); const uniq = [];
  for (const L of out) {
    const k = `${L.cls}|${L.day}|${L.n}`;
    if (seen.has(k)) { warnings.push(`Расписание: ${L.cls}, ${DAY_NAMES[L.day]}, урок ${L.n} указан дважды (оставлено «${seen.get(k).subject}»)`); continue; }
    seen.set(k, L); uniq.push(L);
  }
  return uniq;
}

// ---------- Замены: блоки с заголовком «Замена кабинетов на 22.10.2026» ----------
const dateISO = t => { const m = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})/.exec(t || ''); return m ? `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(m[2])}-${pad(m[1])}` : ''; };

// «8аб» → 8А и 8Б (один урок на обе параллели); «8а» → 8А; «10аб» → 10А и 10Б
function expandClass(part) {
  const m = /^(\d{1,2})\s*([А-Яа-яA-Za-z]{1,2})$/.exec(part.trim());
  if (!m) return [part.trim().toUpperCase()];
  return [...m[2].toUpperCase()].map(l => m[1] + l);
}
// «1-6» → [1..6]; «1, 3, 4» → [1, 3, 4]; «2» → [2]
function lessonList(str) {
  const out = [];
  for (const part of String(str || '').split(/[,;]/).map(x => x.trim()).filter(Boolean)) {
    const r = /^(\d{1,2})\s*[-–—]\s*(\d{1,2})$/.exec(part);
    if (r) { for (let i = +r[1]; i <= +r[2] && i <= 20; i++) out.push(i); }
    else if (/^\d{1,2}$/.test(part)) out.push(+part);
  }
  return out;
}
// Правило: уроки и группы классов сопоставляются по порядку.
//  — один урок на все классы строки: «6 | 10АБ, 9А» → все получают 6-й урок;
//  — одна группа классов на несколько уроков: «1-6 | 10АБ» → 10АБ получает 1–6;
//  — число уроков = число групп: первый урок первой группе, второй второй и т.д.
function parseSubs(rows, warnings) {
  const out = []; let date = '', col = null;
  for (const r of rows) {
    const cells = r.map(c => txt(c));
    const low = cells.map(c => c.toLowerCase());
    if (low.includes('класс') || low.includes('классы')) {
      const f = re => low.findIndex(c => re.test(c));
      col = { n: f(/^урок/), cls: f(/^класс/), subj: f(/^предмет/), room: f(/^каб/), resp: f(/ответств|^учитель/), abs: f(/отсутств/), note: f(/примеч/) };
      continue;
    }
    const title = cells.find(c => /замен/i.test(c) || dateISO(c));
    if (!col || (title && cells.filter(Boolean).length <= 2)) {
      if (title) { date = dateISO(title) || date; col = col && /замен/i.test(title) ? null : col; }
      continue;
    }
    const g = i => (i >= 0 ? cells[i] || '' : '');
    const clsRaw = g(col.cls);
    if (!clsRaw) continue;
    if (!date) { warnings.push(`Замены: нет даты у строки «${clsRaw}» (в заголовке блока должна быть дата вида 22.10.2026)`); continue; }
    const lessonsRaw = col.n >= 0 ? asRange(r[col.n]) : '';
    const lessons = lessonList(lessonsRaw);
    if (!lessons.length) { warnings.push(`Замены: строка «${clsRaw}» без номера урока`); continue; }
    const groups = clsRaw.split(/[,;]/).map(x => x.trim()).filter(Boolean).map(part => ({
      classes: expandClass(part.replace(/\([^)]*\)/g, '')),
      note: ((/\(([^)]*)\)/.exec(part) || [])[1] || '')
    }));
    let pairs;
    if (lessons.length === 1) pairs = groups.map(gr => ({ gr, n: lessons[0] }));
    else if (groups.length === 1) pairs = lessons.map(n => ({ gr: groups[0], n }));
    else if (groups.length === lessons.length) pairs = groups.map((gr, k) => ({ gr, n: lessons[k] }));
    else { warnings.push(`Замены: «${clsRaw}» — уроков ${lessons.length}, групп классов ${groups.length}. Строка пропущена, проверьте в файле`); continue; }
    const subject = g(col.subj), teacher = g(col.resp), room = asRoom(r[col.room]), absent = g(col.abs), rowNote = g(col.note);
    if (!subject && !teacher && !room) continue; // строка без изменения (только «отсутствует» или примечание) — не замена
    for (const { gr, n } of pairs) {
      for (const cls of gr.classes) out.push({ date, lessons: String(n), cls, subject, room, teacher, absent, note: [gr.note, rowNote].filter(Boolean).join(', ') });
    }
  }
  return out;
}

// Файл завуча с заменами: лист «Замены» (или первый лист) → строки замен
function parseSubsFile(buf) {
  const wb = readXlsx(buf);
  const warnings = [];
  const names = Object.keys(wb);
  const name = names.find(n => /замен/i.test(n)) || names[0];
  if (!name) return { subs: [], warnings: ['В файле нет листов'], sheet: '' };
  const subs = parseSubs(wb[name], warnings);
  if (!subs.length && !warnings.length) warnings.push(`Лист «${name}»: не нашли строк замен. Нужны колонки «Урок», «Класс», «Предмет», «Кабинет», «Ответственный учитель» и дата в заголовке блока`);
  return { subs, warnings, sheet: name };
}

// ---------- Общий разбор файла ----------
const SHEET = (wb, name) => { const k = Object.keys(wb).find(n => n.trim().toLowerCase() === name.toLowerCase()); return k ? wb[k] : null; };

function parseWorkbook(buf) {
  const wb = readXlsx(buf);
  const warnings = [];
  const bRows = SHEET(wb, 'Звонки');
  const bells = bRows ? parseBells(bRows, warnings) : [];
  if (!bRows) warnings.push('Нет листа «Звонки»: завтрак и обед не будут показаны, номера уроков угадываются');
  const sRows = SHEET(wb, 'Расписание');
  const lessons = sRows ? parseMatrix(sRows, bells, warnings) : [];
  if (!sRows) warnings.push('Нет листа «Расписание»: уроки не загружены');
  const aRows = SHEET(wb, 'Замены');
  const subs = aRows ? parseSubs(aRows, warnings) : [];
  return { bells, lessons, subs, warnings };
}

// Сравнение с текущими данными: что добавится, уберётся или поменяется
function diffWith(current, next) {
  const cur = new Map(current.lessons.map(l => [`${l.cls}|${l.day}|${l.n}`, l]));
  const nxt = new Map(next.lessons.map(l => [`${l.cls}|${l.day}|${l.n}`, l]));
  const changes = [];
  for (const [k, n] of nxt) {
    const c = cur.get(k);
    if (!c) changes.push({ type: 'added', cls: n.cls, day: n.day, n: n.n, now: n.subject + (n.room ? `, к.${n.room}` : '') });
    else if (c.subject !== n.subject || c.room !== n.room) changes.push({ type: 'changed', cls: n.cls, day: n.day, n: n.n, was: c.subject + (c.room ? `, к.${c.room}` : ''), now: n.subject + (n.room ? `, к.${n.room}` : ''), key: k, fresh: { subject: n.subject, room: n.room } });
  }
  for (const [k, c] of cur) if (!nxt.has(k)) changes.push({ type: 'removed', cls: c.cls, day: c.day, n: c.n, was: c.subject });
  const bKey = b => (b.meal ? 'm:' + b.title : 'n:' + b.n + ':' + b.classes);
  const bc = new Map(current.bells.map(b => [bKey(b), b]));
  const bellChanges = [];
  for (const b of next.bells) { const o = bc.get(bKey(b)); if (o && (o.start !== b.start || o.end !== b.end)) bellChanges.push({ key: bKey(b), was: `${o.start}–${o.end}`, now: `${b.start}–${b.end}`, title: b.meal ? b.title : `урок ${b.n}`, classes: b.classes }); }
  return { changes, bellChanges, hadBefore: current.lessons.length > 0 };
}

module.exports = { parseSubsFile, parseSubs, lessonList, expandClass, parseWorkbook, diffWith, gradeRange, DAY_NAMES, pad, normTime, bKeyOf: b => (b.meal ? 'm:' + b.title : 'n:' + b.n + ':' + b.classes) };
