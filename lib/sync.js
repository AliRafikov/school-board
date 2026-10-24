// Состояние для экранов и страницы учеников: собирается из базы данных.
// Кэш пересобирается, когда меняется номер версии данных (data_rev) или прошла минута (для подсветки по времени).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('./db');

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });

const tzName = () => getSetting('tz');
const changeTtlH = () => Number(getSetting('change_ttl_hours')) || 24;

function todayISO(tz = tzName()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); // YYYY-MM-DD
}
const shiftISO = (iso, days) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const bump = () => setSetting('data_rev', String(Date.now()));

let cache = null, lastBuildAt = null, lastInfo = '';

function build() {
  const now = Date.now(), tz = tzName(), today = todayISO(tz), ttl = changeTtlH() * 3600e3;
  const fresh = t => t && now - t < ttl;

  // уроки
  const lessonRows = db.prepare('SELECT * FROM lessons ORDER BY cls, day, n').all();
  const schedule = {};
  for (const L of lessonRows) {
    const was = fresh(L.changed_at) && (L.was_subject !== null || L.was_room !== null || L.was_teacher !== null)
      ? { subject: L.was_subject || '', teacher: L.was_teacher || '', room: L.was_room || '' } : undefined;
    ((schedule[L.cls] ||= {})[L.day] ||= []).push({ n: L.n, subject: L.subject, teacher: L.teacher, room: L.room, ...(was ? { was } : {}) });
  }
  const classes = Object.keys(schedule).sort((a, b) => (parseInt(a, 10) || 99) - (parseInt(b, 10) || 99) || a.localeCompare(b));

  // звонки и перемены
  const bellRows = db.prepare('SELECT * FROM bells ORDER BY start_t, id').all();
  // звонки на сегодня: постоянные, а на даты (если заданы) — своё время или отмена урока
  const excToday = db.prepare('SELECT * FROM bell_exceptions WHERE date_from <= ? AND date_to >= ?').all(today, today);
  const excBy = new Map(excToday.map(e => [e.bell_id, e]));
  const bells = bellRows.map(b => {
    const base = { id: b.id, n: b.n, title: b.title, meal: !!b.meal, label: b.classes, start: b.start_t, end: b.end_t,
      ...(fresh(b.changed_at) && (b.was_start || b.was_end) ? { was: { start: b.was_start || b.start_t, end: b.was_end || b.end_t } } : {}) };
    const e = excBy.get(b.id);
    if (!e) return base;
    if (e.cancelled) return { ...base, cancelled: true, was: { start: b.start_t, end: b.end_t } };
    return { ...base, start: e.start_t, end: e.end_t, was: { start: b.start_t, end: b.end_t } };
  });
  // сдвиг звонков на сегодня: со указанного урока все звонки (и перемены после него) сдвигаются на N минут
  const toM = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
  const fmtM = mins => { const h = Math.floor(mins / 60) % 24, m = mins % 60; return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'); };
  const shiftOn = getSetting('shift_date') === today ? { from: Number(getSetting('shift_from')) || 0, minutes: Number(getSetting('shift_minutes')) || 0 } : null;
  let shiftNote = '';
  if (shiftOn && shiftOn.minutes > 0) {
    const anchor = bells.find(b => !b.meal && b.n === shiftOn.from && !b.cancelled);
    if (anchor) {
      const cutoff = toM(anchor.start);
      for (const b of bells) {
        if (b.cancelled || toM(b.start) < cutoff) continue;
        b.was = b.was || { start: b.start, end: b.end };
        b.start = fmtM(toM(b.start) + shiftOn.minutes); b.end = fmtM(toM(b.end) + shiftOn.minutes);
      }
      shiftNote = `Звонки сдвинуты на ${shiftOn.minutes} мин`;
    }
  }
  const changedNote = excToday.length
    ? `Звонки изменены на ${excToday.map(e => e.date_from).sort()[0].split('-').reverse().slice(0, 2).join('.')}${excToday.map(e => e.date_to).sort().pop() !== excToday[0].date_from ? '–' + excToday.map(e => e.date_to).sort().pop().split('-').reverse().slice(0, 2).join('.') : ''}`
    : '';
  const bellsNote = [shiftNote, changedNote].filter(Boolean).join(' · ');

  // замены: одна строка на класс, на экране группируются по одинаковым остальным полям
  const subRows = db.prepare('SELECT * FROM subs WHERE date >= ? ORDER BY date, lessons, subject, id').all(shiftISO(today, -1));
  const groups = new Map();
  for (const s of subRows) {
    const k = [s.date, s.lessons, s.subject, s.room, s.teacher, s.absent, s.note].join('|');
    if (!groups.has(k)) groups.set(k, { date: s.date, lessons: s.lessons, subject: s.subject, room: s.room, teacher: s.teacher, absent: s.absent, note: s.note, classes: [] });
    groups.get(k).classes.push({ cls: s.cls, note: '' });
  }
  const substitutions = [...groups.values()];

  // замены накладываются на расписание своей даты: подменённый урок подсвечивается красным
  const byKey = new Map(lessonRows.map(L => [`${L.cls}|${L.day}|${L.n}`, L]));
  const overlay = {};
  for (const x of subRows) {
    const wd = (new Date(x.date + 'T12:00:00Z').getUTCDay() + 6) % 7; // Пн = 0
    if (wd > 5) continue;
    for (const n of lessonNums(x.lessons)) {
      if (/^урок отменён$/i.test(x.subject || '')) { ((overlay[x.date] ||= {})[x.cls] ||= {})[n] = { n, subject: '', teacher: '', room: '', note: x.note || '', cancelled: true }; continue; }
      const base = byKey.get(`${x.cls}|${wd}|${n}`);
      const subject = x.subject || (base && base.subject) || '';
      if (!subject) continue;
      const teacher = x.teacher || (base && base.teacher) || '';
      const room = x.room || (base && base.room) || '';
      const changed = !base || base.subject !== subject || base.teacher !== teacher || base.room !== room;
      const was = base && changed ? { subject: base.subject, teacher: base.teacher, room: base.room } : undefined;
      ((overlay[x.date] ||= {})[x.cls] ||= {})[n] = { n, subject, teacher, room, note: x.note || '', ...(was ? { was } : {}) };
    }
  }

  // постеры, ролики, объявления
  const media = db.prepare('SELECT * FROM media WHERE active=1 ORDER BY sort, id').all().map(m => ({
    id: 'm' + m.id, kind: m.kind, title: m.title, duration: m.duration, from: m.date_from, to: m.date_to,
    priority: m.priority, breakOnly: !!m.break_only, place: m.place || 'screen', url: '/media/' + m.file, fullscreen: (m.place || 'screen') === 'screen'
  }));
  const ann = db.prepare('SELECT * FROM announcements WHERE active=1 ORDER BY id').all().map(a => ({
    id: 'a' + a.id, kind: 'text', title: a.title, duration: a.duration, from: a.date_from, to: a.date_to,
    priority: a.priority, breakOnly: false, place: 'center', url: '', fullscreen: false
  }));
  const carousel = [...media, ...ann];

  const body = {
    schedule, classes, bells, bellsNote, substitutions, overlay, carousel,
    boardSeconds: Number(getSetting('board_seconds')) || 45,
    schoolName: getSetting('school_name'),
    refreshEpoch: Number(getSetting('refresh_epoch')) || 0,
    clear: (() => { const until = Number(getSetting('clear_until')) || 0; return until > Date.now() ? { title: getSetting('clear_title') || '', source: getSetting('clear_source') || '', since: Number(getSetting('clear_since')) || 0, until } : null; })(),
    urgent: (() => { const title = getSetting('urgent_title') || ''; return title ? { title, source: getSetting('urgent_source') || '', note: getSetting('urgent_note') || '', since: Number(getSetting('urgent_since')) || 0 } : null; })(),
    empty: lessonRows.length === 0,
    displayMode: getSetting('display_mode') || 'auto',
    theme: getSetting('theme') || 'auto',
    nightFrom: getSetting('night_from') || '21:00',
    nightTo: getSetting('night_to') || '07:00'
  };
  const version = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  lastBuildAt = now;
  lastInfo = `уроков: ${lessonRows.length}, звонков: ${bells.length}, замен на сегодня и дальше: ${substitutions.length}, файлов и объявлений: ${carousel.length}`;
  return { version, updatedAt: now, ...body, tz, today, tomorrow: shiftISO(today, 1) };
}

// «1-6», «1,2», «5» → [1..6], [1,2], [5]
function lessonNums(str) {
  const out = new Set();
  for (const part of String(str || '').split(/[,;]/).map(x => x.trim()).filter(Boolean)) {
    const m = /^(\d{1,2})\s*[-–—]\s*(\d{1,2})$/.exec(part);
    if (m) { for (let i = +m[1]; i <= +m[2] && i <= 20; i++) out.add(i); }
    else if (/^\d{1,2}$/.test(part)) out.add(+part);
  }
  return [...out];
}

function invalidate() { cache = null; }

function getState() {
  const rev = getSetting('data_rev');
  const minute = Math.floor(Date.now() / 60000);
  if (!cache || cache.rev !== rev || cache.minute !== minute) cache = { rev, minute, state: build() };
  const s = cache.state;
  return { ...s, serverTime: Date.now() };
}

module.exports = {
  DATA, MEDIA, todayISO, shiftISO, bump, invalidate,
  getState,
  // совместимость с прежним интерфейсом сервера
  sync: async () => { invalidate(); getState(); return status(); },
  status: () => status(),
  mode: () => 'local'
};

function status() {
  const s = cache ? cache.state : null;
  return { lastError: null, lastOk: lastBuildAt, lastInfo, syncing: false, version: s && s.version, updatedAt: s && s.updatedAt };
}
