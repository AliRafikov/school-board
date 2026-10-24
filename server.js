// HTTP-сервер: публичные страницы и /api/state, вход, админка. Внешних зависимостей нет (sharp — по желанию).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./lib/sync');
const SC = require('./lib/schedule');
const A = require('./lib/auth');
const { db, DATA, getSetting, setSetting, allSettings, audit } = require('./lib/db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';                       // на сервере: 127.0.0.1 (снаружи доступ только через Caddy)
const PUBLIC = path.join(__dirname, 'public');
const MAX_IMAGE = 15 * 1024 * 1024, MAX_VIDEO = 30 * 1024 * 1024, MAX_PDF = 30 * 1024 * 1024;
let sharp = null; try { sharp = require('sharp'); } catch { /* сжатие картинок включится, если установить sharp */ }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' };

function json(res, code, obj, extra = {}) {
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...SEC, ...extra });
  res.end(JSON.stringify(obj));
}
const fail = (res, code, msg) => json(res, code, { error: msg });

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(Object.assign(new Error('Слишком большой запрос'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const b = await readBody(req);
  try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch { throw Object.assign(new Error('Некорректный JSON'), { code: 400 }); }
}

function serveFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, SEC); return res.end('Not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': cache, 'Accept-Ranges': 'bytes', ...SEC, ...(path.extname(file) === '.html' ? { 'Content-Security-Policy': CSP } : {}) };
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || ''); // Safari/tvOS запрашивает видео частями
    if (range) {
      const start = range[1] ? parseInt(range[1], 10) : 0;
      const end = range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

// Адрес клиента. За Caddy (локальный адрес) берём последнее значение X-Forwarded-For — его дописывает Caddy.
// Первое значение задаёт сам клиент, поэтому его нельзя доверять.
const ip = req => {
  const sock = req.socket.remoteAddress || '';
  if (sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1') {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return sock;
};
const isHttps = req => req.headers['x-forwarded-proto'] === 'https';
const SCREEN_TTL = 14 * 864e5; // экран без связи 14 дней (и без имени) забываем
// строгая политика для страниц: скрипты только со своего сайта, встроенных скриптов нет
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";
// ограничение частоты «экран на связи»: не больше 120 запросов в минуту с одного адреса (школа — много экранов за одним адресом)
const pingHits = new Map();
function pingAllowed(addr) {
  if (pingHits.size > 5000) pingHits.clear();
  const now = Date.now(), hits = (pingHits.get(addr) || []).filter(t => now - t < 60e3);
  if (hits.length >= 120) { pingHits.set(addr, hits); return false; }
  hits.push(now); pingHits.set(addr, hits); return true;
}

// ---------- загрузка медиа ----------
function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', ext: '.jpg' };
  if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', ext: '.png' };
  if (buf.slice(0, 5).toString() === '%PDF-') return { kind: 'pdf', ext: '.pdf' };
  if (buf.length > 12 && buf.slice(4, 8).toString() === 'ftyp') return { kind: 'video', ext: '.mp4' };
  return null;
}
async function compressImage(buf, ext) {
  if (!sharp || buf.length <= 500 * 1024) return { buf, ext };
  let q = 82, out = buf;
  for (let i = 0; i < 5; i++) {
    out = await sharp(buf).rotate().resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (out.length <= 500 * 1024) break; q -= 12;
  }
  return { buf: out, ext: '.jpg' };
}

const mediaRow = m => ({ id: m.id, kind: m.kind, title: m.title, url: '/media/' + m.file, duration: m.duration, date_from: m.date_from, date_to: m.date_to,
  priority: m.priority, place: m.place || 'screen', break_only: !!m.break_only, active: !!m.active, size: m.size, created_by: m.created_by, created_at: m.created_at });

const PLACES = ['screen', 'center', 'banner'];
const validDate = d => d === '' || /^\d{4}-\d{2}-\d{2}$/.test(d);
// Готовые срочные варианты: один клик — и сообщение на экранах. Текст инструкции можно поправить здесь.
const URGENT_PRESETS = [
  { id: 'missile', title: 'Ракетная опасность', end: 'Отбой ракетной опасности', source: 'МЧС России', note: 'Пройдите в укрытие. Следуйте указаниям учителей и администрации.' },
  { id: 'drone', title: 'Угроза атаки БПЛА', end: 'Отбой угрозы атаки БПЛА', source: 'МЧС России', note: 'Пройдите в укрытие. Следуйте указаниям учителей и администрации.' },
  { id: 'air', title: 'Воздушная тревога: всем в укрытие', end: 'Отбой воздушной тревоги', source: 'МЧС России', note: 'Следуйте указаниям учителей и администрации.' },
];
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const roleLabel = r => A.ROLES[r] || r;

// ---------- API админки ----------
async function adminApi(req, res, p, url, user) {
  const m = req.method;
  const need = what => { if (!A.can(user, what)) { fail(res, 403, 'Недостаточно прав'); return false; } return true; };
  if (user.must_change && p !== '/api/auth/password') return fail(res, 403, 'Сначала смените пароль');

  if (p === '/api/admin/overview' && m === 'GET') {
    if (!need('overview')) return;
    const now = Date.now();
    const tzNow = getSetting('tz') || 'Europe/Moscow', todayNow = S.todayISO(tzNow);
    const urgentNow = getSetting('urgent_title') || '';
    const clearUntil = Number(getSetting('clear_until')) || 0;
    const shiftNow = getSetting('shift_date') === todayNow && Number(getSetting('shift_minutes')) > 0;
    return json(res, 200, {
      mode: S.mode(), sync: S.status(), screen_theme: getSetting('theme') || 'auto',
      status: {
        urgent: urgentNow ? { title: urgentNow, source: getSetting('urgent_source') || '', since: Number(getSetting('urgent_since')) || 0 } : null,
        clear: clearUntil > now ? { title: getSetting('clear_title') || '', until: clearUntil } : null,
        shift: shiftNow ? { from: Number(getSetting('shift_from')), minutes: Number(getSetting('shift_minutes')) } : null,
        subs_today: db.prepare('SELECT COUNT(DISTINCT date || lessons || subject || cls) c FROM subs WHERE date = ?').get(todayNow).c,
        screens_offline: db.prepare('SELECT id, name, last_seen FROM screens WHERE last_seen <= ? AND last_seen > ? ORDER BY last_seen ASC').all(now - 3 * 60e3, now - SCREEN_TTL)
      },
      runs: db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 8').all(),
      counts: {
        users: db.prepare('SELECT COUNT(*) c FROM users WHERE active=1').get().c,
        media: db.prepare('SELECT COUNT(*) c FROM media WHERE active=1').get().c,
        lessons: db.prepare('SELECT COUNT(*) c FROM lessons').get().c,
        bells: db.prepare('SELECT COUNT(*) c FROM bells').get().c,
        subs: db.prepare('SELECT COUNT(DISTINCT date || lessons || subject || cls) c FROM subs WHERE date >= ?').get(S.shiftISO(S.todayISO(), -1)).c,
        screens: db.prepare('SELECT COUNT(*) c FROM screens WHERE last_seen > ?').get(now - 3 * 60e3).c,
        screens_total: db.prepare('SELECT COUNT(*) c FROM screens WHERE last_seen > ?').get(now - SCREEN_TTL).c
      },
      recent: db.prepare("SELECT * FROM audit WHERE action NOT IN ('login','login_failed','logout') ORDER BY id DESC LIMIT 8").all()
    });
  }

  if (p === '/api/admin/audit' && m === 'GET') {
    if (!need('audit')) return;
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50), offset = clampInt(url.searchParams.get('offset'), 0, 1e6, 0);
    const where = [], args = [];
    const src = url.searchParams.get('source'); if (['sheet', 'admin', 'system'].includes(src)) { where.push('source = ?'); args.push(src); }
    const q = (url.searchParams.get('q') || '').trim(); if (q) { where.push('(target LIKE ? OR was LIKE ? OR now LIKE ? OR user_name LIKE ? OR action LIKE ?)'); const l = `%${q}%`; args.push(l, l, l, l, l); }
    if (url.searchParams.get('hide_logins') === '1') where.push("action NOT IN ('login','login_failed','logout')");
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    return json(res, 200, { total: db.prepare(`SELECT COUNT(*) c FROM audit ${w}`).get(...args).c, rows: db.prepare(`SELECT * FROM audit ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) });
  }

  // --- расписание: импорт xlsx, уроки, звонки ---
  if (p === '/api/admin/schedule' && m === 'GET') {
    if (!need('schedule')) return;
    const lessons = db.prepare('SELECT cls, day, n, subject, teacher, room FROM lessons ORDER BY cls, day, n').all();
    const bells = db.prepare('SELECT id, n, title, start_t AS start, end_t AS end, classes, meal FROM bells ORDER BY start_t, id').all();
    const classes = [...new Set(lessons.map(l => l.cls))].sort((a, b) => (parseInt(a, 10) || 99) - (parseInt(b, 10) || 99) || a.localeCompare(b));
    return json(res, 200, { exceptions: SC.listBellExceptions(), lessons, bells, classes, days: SC.DAYS });
  }
  if (p === '/api/admin/schedule/import' && m === 'POST') {
    if (!need('schedule')) return;
    const buf = await readBody(req, 20 * 1024 * 1024);
    if (!buf.length) return fail(res, 400, 'Файл пустой');
    try { return json(res, 200, SC.previewImport(buf, user)); }
    catch (e) { if (e.code === 400) return fail(res, 400, e.message); return fail(res, 400, 'Не удалось прочитать файл: ' + e.message + '. Нужен файл .xlsx (Excel).'); }
  }
  if (p === '/api/admin/schedule/import/commit' && m === 'POST') {
    if (!need('schedule')) return;
    const b = await readJSON(req);
    return json(res, 200, SC.commitImport(String(b.token || ''), !!b.mark, user));
  }
  if (p === '/api/admin/schedule/bell-exceptions' && m === 'POST') {
    if (!need('schedule')) return;
    return json(res, 201, SC.addBellException(await readJSON(req), user));
  }
  const bx = /^\/api\/admin\/schedule\/bell-exceptions\/(\d+)$/.exec(p);
  if (bx && m === 'DELETE') {
    if (!need('schedule')) return;
    return json(res, 200, SC.deleteBellException(Number(bx[1]), user));
  }

  // --- замены ---
  if (p === '/api/admin/subs/import' && m === 'POST') {
    if (!need('subs')) return;
    const buf = await readBody(req, 20 * 1024 * 1024);
    if (!buf.length) return fail(res, 400, 'Файл пустой');
    try { return json(res, 200, SC.previewSubsFile(buf, user)); }
    catch (e) { if (e.code === 400) return fail(res, 400, e.message); return fail(res, 400, 'Не удалось прочитать файл: ' + e.message + '. Нужен файл .xlsx (Excel).'); }
  }
  if (p === '/api/admin/subs/import/commit' && m === 'POST') {
    if (!need('subs')) return;
    const b = await readJSON(req);
    return json(res, 200, SC.commitSubsFile(String(b.token || ''), user));
  }
  if (p === '/api/admin/subs/day' && m === 'PUT') {
    if (!need('subs')) return;
    return json(res, 200, SC.saveSubsDay(await readJSON(req), user));
  }
  if (p === '/api/admin/subs' && m === 'GET') {
    if (!need('subs')) return;
    return json(res, 200, db.prepare('SELECT * FROM subs ORDER BY date DESC, lessons, id DESC LIMIT 400').all());
  }
  if (p === '/api/admin/subs' && m === 'POST') {
    if (!need('subs')) return;
    return json(res, 201, SC.addSubs(await readJSON(req), user));
  }
  if (p === '/api/admin/subs' && m === 'DELETE') {
    if (!need('subs')) return;
    const b = await readJSON(req);
    return json(res, 200, SC.deleteSubs(b.ids, user));
  }

  // --- объявления ---
  if (p === '/api/admin/announcements' && m === 'GET') {
    if (!need('announcements')) return;
    return json(res, 200, db.prepare('SELECT * FROM announcements ORDER BY id DESC').all().map(a => ({ ...a, active: !!a.active })));
  }
  if (p === '/api/admin/announcements' && m === 'POST') {
    if (!need('announcements')) return;
    return json(res, 201, SC.saveAnnouncement(0, await readJSON(req), user));
  }
  const an = /^\/api\/admin\/announcements\/(\d+)$/.exec(p);
  if (an && m === 'PATCH') {
    if (!need('announcements')) return;
    return json(res, 200, SC.saveAnnouncement(Number(an[1]), await readJSON(req), user));
  }
  if (an && m === 'DELETE') {
    if (!need('announcements')) return;
    return json(res, 200, SC.deleteAnnouncement(Number(an[1]), user));
  }
  if (p === '/api/admin/refresh-screens' && m === 'POST') {
    if (!need('screens')) return;
    setSetting('refresh_epoch', Date.now());
    S.bump();
    audit({ user, action: 'screens_refresh', target: 'Все экраны' });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/admin/screens' && m === 'GET') {
    if (!need('screens')) return;
    return json(res, 200, db.prepare('SELECT * FROM screens ORDER BY last_seen DESC').all());
  }
  const sc = /^\/api\/admin\/screens\/([\w-]+)$/.exec(p);
  if (sc && m === 'PATCH') {
    if (!need('screens')) return;
    const b = await readJSON(req);
    db.prepare('UPDATE screens SET name=? WHERE id=?').run(String(b.name || '').slice(0, 60), sc[1]);
    audit({ user, action: 'screen_renamed', target: sc[1], now: b.name });
    return json(res, 200, { ok: true });
  }

  // --- настройки ---
  if (p === '/api/admin/shift') {
    if (!need('schedule')) return;
    const tz = getSetting('tz') || 'Europe/Moscow', today = S.todayISO(tz);
    if (m === 'GET') {
      const on = getSetting('shift_date') === today && Number(getSetting('shift_minutes')) > 0;
      return json(res, 200, on ? { date: today, from: Number(getSetting('shift_from')), minutes: Number(getSetting('shift_minutes')) } : null);
    }
    if (m === 'PUT') {
      const b = await readJSON(req);
      if (b.reset) {
        setSetting('shift_date', ''); setSetting('shift_minutes', '0');
        audit({ user, action: 'shift_reset', target: 'сегодня' });
        S.bump(); return json(res, 200, { ok: true, active: false });
      }
      const from = Math.trunc(Number(b.from)), minutes = Math.trunc(Number(b.minutes));
      if (!(from >= 1 && from <= 30) || !(minutes >= 1 && minutes <= 120)) return fail(res, 400, 'Укажите урок и число минут (от 1 до 120)');
      if (!db.prepare('SELECT 1 FROM bells WHERE n=? AND meal=0').get(from)) return fail(res, 400, 'Такого урока нет в расписании звонков');
      setSetting('shift_date', today); setSetting('shift_from', String(from)); setSetting('shift_minutes', String(minutes));
      audit({ user, action: 'shift_started', target: `с ${from} урока на ${minutes} мин`, details: today });
      S.bump(); return json(res, 200, { ok: true, active: true });
    }
  }
  if (p === '/api/admin/urgent') {
    if (!need('announcements')) return;
    if (m === 'GET') {
      const title = getSetting('urgent_title') || '';
      const clearUntil = Number(getSetting('clear_until')) || 0;
      return json(res, 200, { active: !!title, item: title ? { title, source: getSetting('urgent_source') || '', note: getSetting('urgent_note') || '', since: Number(getSetting('urgent_since')) || 0 } : null,
        clear: clearUntil > Date.now() ? { title: getSetting('clear_title') || '', until: clearUntil } : null, presets: URGENT_PRESETS });
    }
    if (m === 'PUT') {
      const b = await readJSON(req);
      const prev = getSetting('urgent_title') || '';
      if (b.hide_clear) {
        // убираем зелёный отбой с экранов сразу, не дожидаясь пяти минут
        const until = Number(getSetting('clear_until')) || 0;
        if (until > Date.now()) {
          setSetting('clear_until', '0');
          audit({ user, action: 'clear_hidden', target: getSetting('clear_title') || 'отбой' });
          S.bump();
        }
        return json(res, 200, { ok: true, active: false });
      }
      if (!b.preset && !String(b.title || '').trim()) {
        const prevSource = getSetting('urgent_source') || '';
        if (prev) {
          const low = prev.charAt(0).toLowerCase() + prev.slice(1);
          const t = Date.now();
          setSetting('clear_title', getSetting('urgent_end') || ('Отбой: ' + low)); setSetting('clear_source', prevSource); setSetting('clear_since', String(t)); setSetting('clear_until', String(t + 5 * 60e3));
        }
        setSetting('urgent_title', ''); setSetting('urgent_since', '0');
        audit({ user, action: 'urgent_stopped', target: prev });
        S.bump(); return json(res, 200, { ok: true, active: false });
      }
      let item;
      if (b.preset) { item = URGENT_PRESETS.find(x => x.id === String(b.preset)); if (!item) return fail(res, 400, 'Неизвестный вариант'); }
      else item = { title: String(b.title).trim().slice(0, 120), source: String(b.source || '').trim().slice(0, 80), note: String(b.note || '').trim().slice(0, 200) };
      setSetting('urgent_end', item.end || '');
      const since = Date.now();
      setSetting('urgent_title', item.title); setSetting('urgent_source', item.source); setSetting('urgent_note', item.note); setSetting('urgent_since', String(since));
      audit({ user, action: 'urgent_started', target: item.title, details: item.source || '' });
      S.bump(); return json(res, 200, { ok: true, active: true, since });
    }
  }
  if (p === '/api/admin/settings') {
    const themeOnly = m === 'PUT' && !A.can(user, 'settings') && A.can(user, 'screens'); // завуч меняет только тему экрана
    if (!themeOnly && !need('settings')) return;
    if (m === 'GET') return json(res, 200, allSettings());
    if (m === 'PUT') {
      const b = await readJSON(req), before = allSettings(), upd = {};
      if (themeOnly && Object.keys(b).some(k => k !== 'theme')) return fail(res, 403, 'Недостаточно прав');
      if ('tz' in b) { try { new Intl.DateTimeFormat('en', { timeZone: String(b.tz) }); } catch { return fail(res, 400, 'Неизвестный часовой пояс'); } upd.tz = String(b.tz); }
      if ('change_ttl_hours' in b) upd.change_ttl_hours = clampInt(b.change_ttl_hours, 1, 168, 24);
      if ('board_seconds' in b) upd.board_seconds = clampInt(b.board_seconds, 10, 600, 45);
      if ('display_mode' in b) { if (!['auto', 'static', 'active'].includes(b.display_mode)) return fail(res, 400, 'Неизвестный режим экрана'); upd.display_mode = b.display_mode; }
      if ('theme' in b) { if (!['auto', 'light', 'dark'].includes(b.theme)) return fail(res, 400, 'Неизвестная тема'); upd.theme = b.theme; }
      for (const k of ['night_from', 'night_to']) if (k in b) { if (!/^\d{2}:\d{2}$/.test(String(b[k]))) return fail(res, 400, 'Время ночи в формате ЧЧ:ММ'); upd[k] = String(b[k]); }
      if ('school_name' in b) upd.school_name = String(b.school_name).trim().slice(0, 80) || before.school_name;
      for (const [k, v] of Object.entries(upd)) if (String(v) !== String(before[k])) { setSetting(k, v); audit({ user, action: 'settings_changed', target: k, was: before[k], now: v }); }
      S.bump();
      return json(res, 200, allSettings());
    }
  }

  // --- пользователи ---
  if (p === '/api/admin/users' && m === 'GET') {
    if (!need('users')) return;
    return json(res, 200, { roles: A.ROLES, users: db.prepare('SELECT id,login,name,role,active,must_change,created_at,last_login FROM users ORDER BY id').all() });
  }
  if (p === '/api/admin/users' && m === 'POST') {
    if (!need('users')) return;
    const b = await readJSON(req);
    const login = String(b.login || '').trim(), name = String(b.name || '').trim();
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(login)) return fail(res, 400, 'Логин: 3–32 символа, латиница, цифры, точка, дефис, подчёркивание');
    if (!name) return fail(res, 400, 'Укажите имя');
    if (!A.ROLES[b.role]) return fail(res, 400, 'Неизвестная роль');
    if (b.role === 'director' && user.role !== 'director') return fail(res, 403, 'Директора может создать только директор');
    if (db.prepare('SELECT 1 FROM users WHERE login=?').get(login)) return fail(res, 409, 'Такой логин уже есть');
    const pw = b.password ? String(b.password) : A.generatePassword();
    if (b.password) { const pr = A.passwordProblem(pw); if (pr) return fail(res, 400, pr); }
    const r = db.prepare('INSERT INTO users(login,name,role,pass_hash,must_change,created_at) VALUES(?,?,?,?,1,?)').run(login, name, b.role, A.hashPassword(pw), Date.now());
    audit({ user, action: 'user_created', target: login, now: `${name}, ${roleLabel(b.role)}` });
    return json(res, 201, { id: Number(r.lastInsertRowid), login, temp_password: pw });
  }
  const um = /^\/api\/admin\/users\/(\d+)$/.exec(p);
  if (um && m === 'PATCH') {
    if (!need('users')) return;
    const id = Number(um[1]), target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!target) return fail(res, 404, 'Пользователь не найден');
    // директора меняет только он сам: иначе двое директоров могли бы отключить или перехватить друг друга
    if (target.role === 'director' && target.id !== user.id) return fail(res, 403, 'Другого директора может менять только он сам');
    const b = await readJSON(req);
    const activeDirectors = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role='director' AND active=1").get().c;
    let out = {};
    if ('role' in b && b.role !== target.role) {
      if (!A.ROLES[b.role]) return fail(res, 400, 'Неизвестная роль');
      if (b.role === 'director' && user.role !== 'director') return fail(res, 403, 'Назначить директора может только директор');
      if (target.role === 'director' && target.active && activeDirectors() <= 1) return fail(res, 400, 'Нельзя снять роль с единственного директора');
      db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, id);
      if (id !== user.id) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); // новая роль — новый вход
      audit({ user, action: 'user_role_changed', target: target.login, was: roleLabel(target.role), now: roleLabel(b.role) });
    }
    if ('name' in b && String(b.name).trim() && b.name !== target.name) { db.prepare('UPDATE users SET name=? WHERE id=?').run(String(b.name).trim(), id); audit({ user, action: 'user_renamed', target: target.login, was: target.name, now: b.name }); }
    if ('active' in b && !!b.active !== !!target.active) {
      if (id === user.id) return fail(res, 400, 'Нельзя отключить самого себя');
      if (!b.active && target.role === 'director' && activeDirectors() <= 1) return fail(res, 400, 'Нельзя отключить единственного директора');
      db.prepare('UPDATE users SET active=? WHERE id=?').run(b.active ? 1 : 0, id);
      if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      audit({ user, action: b.active ? 'user_enabled' : 'user_disabled', target: target.login });
    }
    if (b.reset_password) {
      const pw = A.generatePassword();
      db.prepare('UPDATE users SET pass_hash=?, must_change=1 WHERE id=?').run(A.hashPassword(pw), id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      audit({ user, action: 'password_reset', target: target.login });
      out.temp_password = pw;
    }
    return json(res, 200, { ok: true, ...out });
  }

  // --- медиа ---
  if (p === '/api/admin/media' && m === 'GET') {
    if (!need('media')) return;
    return json(res, 200, db.prepare('SELECT * FROM media ORDER BY sort, id').all().map(mediaRow));
  }
  if (p === '/api/admin/media/upload' && m === 'POST') {
    if (!need('media')) return;
    let buf;
    try { buf = await readBody(req, MAX_VIDEO + 1024); } catch (e) { return fail(res, 413, 'Файл слишком большой (видео — до 30 МБ)'); }
    const info = sniff(buf);
    if (!info) return fail(res, 400, 'Поддерживаются JPG, PNG, PDF и MP4');
    const limit = info.kind === 'video' ? MAX_VIDEO : info.kind === 'pdf' ? MAX_PDF : MAX_IMAGE;
    if (buf.length > limit) return fail(res, 413, `Файл больше ${Math.round(limit / 1048576)} МБ`);
    let { ext } = info; let data = buf;
    if (info.kind === 'image') ({ buf: data, ext } = await compressImage(buf, ext));
    const file = crypto.randomBytes(10).toString('hex') + ext;
    fs.writeFileSync(path.join(S.MEDIA, file), data);
    const title = decodeURIComponent(String(req.headers['x-file-title'] || '')).slice(0, 120) || decodeURIComponent(String(req.headers['x-file-name'] || 'Без названия')).replace(/\.[^.]+$/, '').slice(0, 120);
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM media').get().m;
    // длительность ролика берёт браузер админки при загрузке (X-Duration); если не смог — 30 с
    const reqDur = Math.round(Number(req.headers['x-duration']));
    const dur = info.kind === 'video' ? (reqDur >= 1 ? Math.max(3, Math.min(600, reqDur)) : 30) : 10;
    const r = db.prepare('INSERT INTO media(file,kind,title,duration,sort,size,created_by,created_at,place) VALUES(?,?,?,?,?,?,?,?,?)').run(file, info.kind, title, dur, maxSort + 1, data.length, user.name, Date.now(), PLACES.includes(String(req.headers['x-place'])) ? String(req.headers['x-place']) : 'screen');
    audit({ user, action: 'media_uploaded', target: title, now: `${({ image: 'картинка', video: 'видео', pdf: 'презентация' })[info.kind]}, ${Math.round(data.length / 1024)} КБ` });
    S.bump();
    return json(res, 201, mediaRow(db.prepare('SELECT * FROM media WHERE id=?').get(Number(r.lastInsertRowid))));
  }
  if (p === '/api/admin/media/reorder' && m === 'POST') {
    if (!need('media')) return;
    const b = await readJSON(req);
    if (!Array.isArray(b.ids)) return fail(res, 400, 'Нужен список ids');
    b.ids.forEach((id, i) => db.prepare('UPDATE media SET sort=? WHERE id=?').run(i + 1, Number(id)));
    audit({ user, action: 'media_reordered', target: 'Медиатека' });
    S.bump();
    return json(res, 200, { ok: true });
  }
  const mm = /^\/api\/admin\/media\/(\d+)$/.exec(p);
  if (mm) {
    if (!need('media')) return;
    const id = Number(mm[1]), row = db.prepare('SELECT * FROM media WHERE id=?').get(id);
    if (!row) return fail(res, 404, 'Файл не найден');
    if (m === 'PATCH') {
      const b = await readJSON(req);
      const df = 'date_from' in b ? String(b.date_from) : row.date_from, dt = 'date_to' in b ? String(b.date_to) : row.date_to;
      if (!validDate(df) || !validDate(dt)) return fail(res, 400, 'Дата в формате ГГГГ-ММ-ДД');
      if (df && dt && df > dt) return fail(res, 400, 'Дата «с» позже даты «по»');
      const upd = { title: 'title' in b ? String(b.title).trim().slice(0, 120) : row.title, duration: 'duration' in b ? clampInt(b.duration, 3, 600, row.duration) : row.duration,
        priority: 'priority' in b ? clampInt(b.priority, 1, 5, row.priority) : row.priority, break_only: 'break_only' in b ? (b.break_only ? 1 : 0) : row.break_only, place: 'place' in b && PLACES.includes(b.place) ? b.place : row.place, active: 'active' in b ? (b.active ? 1 : 0) : row.active };
      db.prepare('UPDATE media SET title=?,duration=?,date_from=?,date_to=?,priority=?,break_only=?,active=?,place=? WHERE id=?').run(upd.title, upd.duration, df, dt, upd.priority, upd.break_only, upd.active, upd.place, id);
      audit({ user, action: 'media_updated', target: upd.title || row.title, details: Object.keys(b).join(', ') });
      S.bump();
      return json(res, 200, mediaRow(db.prepare('SELECT * FROM media WHERE id=?').get(id)));
    }
    if (m === 'DELETE') {
      db.prepare('DELETE FROM media WHERE id=?').run(id);
      try { fs.unlinkSync(path.join(S.MEDIA, row.file)); } catch { /* файла уже нет */ }
      audit({ user, action: 'media_deleted', target: row.title });
      S.bump();
      return json(res, 200, { ok: true });
    }
  }
  return fail(res, 404, 'Нет такого метода');
}

// ---------- основной обработчик ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);

    // публичное
    if (p === '/api/weather' && req.method === 'GET') return json(res, 200, (await require('./lib/weather').weather()) || {});
  if (p === '/api/state') {
      const s = S.getState();
      const logo = ['logo.svg', 'logo.png'].find(f => fs.existsSync(path.join(PUBLIC, 'brand', f)));
      return json(res, 200, { ...s, logo: logo ? '/brand/' + logo : '', logoDark: fs.existsSync(path.join(PUBLIC, 'brand', 'logo-dark.png')) ? '/brand/logo-dark.png' : '' });
    }
    if (p === '/api/health') return json(res, 200, { ok: true, version: S.getState().version });
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p === '/api/ping' && req.method === 'POST') { // экран сообщает, что он жив
      const b = await readJSON(req); const id = String(b.id || '').replace(/[^\w-]/g, '').slice(0, 40);
      if (!id) return fail(res, 400, 'id');
      if (!pingAllowed(ip(req))) return fail(res, 429, 'Слишком часто');
      if (db.prepare('SELECT COUNT(*) c FROM screens').get().c >= 300 && !db.prepare('SELECT 1 FROM screens WHERE id=?').get(id)) return fail(res, 507, 'Слишком много экранов');
      const now = Date.now();
      db.prepare(`INSERT INTO screens(id,last_seen,ip,ua,version,first_seen) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, ip=excluded.ip, ua=excluded.ua, version=excluded.version`)
        .run(id, now, ip(req), String(req.headers['user-agent'] || '').slice(0, 160), String(b.version || '').slice(0, 20), now);
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/media/')) return serveFile(req, res, path.join(S.MEDIA, path.basename(p)), 'public, max-age=31536000, immutable');

    // вход / выход
    if (p === '/api/auth/login' && req.method === 'POST') {
      const b = await readJSON(req);
      const r = A.login(String(b.login || ''), String(b.password || ''), ip(req));
      if (r.error) return fail(res, 401, r.error);
      return json(res, 200, { ok: true, must_change: !!r.user.must_change }, { 'Set-Cookie': A.cookieHeader(r.token, isHttps(req)) });
    }
    if (p.startsWith('/api/auth/') || p.startsWith('/api/admin/')) {
      const user = A.userFromReq(req);
      if (p === '/api/auth/me') return user ? json(res, 200, { ...user, role_label: roleLabel(user.role), can: Object.fromEntries(['users', 'settings', 'media', 'schedule', 'subs', 'announcements', 'screens', 'audit'].map(k => [k, A.can(user, k)])) }) : fail(res, 401, 'Нужно войти');
      if (!user) return fail(res, 401, 'Нужно войти');
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'sb') return fail(res, 403, 'Запрос отклонён');
      if (p === '/api/auth/logout' && req.method === 'POST') { audit({ user, action: 'logout', target: user.login }); A.destroySession(req); return json(res, 200, { ok: true }, { 'Set-Cookie': A.clearCookie() }); }
      if (p === '/api/auth/password' && req.method === 'POST') {
        const b = await readJSON(req);
        const row = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
        if (!A.checkPassword(String(b.old || ''), row.pass_hash)) return fail(res, 400, 'Текущий пароль указан неверно');
        const pr = A.passwordProblem(String(b.new || '')); if (pr) return fail(res, 400, pr);
        if (b.new === b.old) return fail(res, 400, 'Новый пароль должен отличаться от старого');
        db.prepare('UPDATE users SET pass_hash=?, must_change=0 WHERE id=?').run(A.hashPassword(String(b.new)), user.id);
        A.destroyOtherSessions(user.id, req); // остальные входы с паролем, который поменяли, закрываем
        audit({ user, action: 'password_changed', target: user.login });
        return json(res, 200, { ok: true });
      }
      if (p.startsWith('/api/admin/')) return await adminApi(req, res, p, url, user);
      return fail(res, 404, 'Нет такого метода');
    }
    if (p.startsWith('/api/')) return fail(res, 404, 'Нет такого метода');

    // страницы
    let rel = p === '/' ? '/index.html' : p === '/tv' ? '/tv.html' : (p === '/admin' || p === '/admin/') ? '/admin.html' : p;
    const f = path.normalize(path.join(PUBLIC, rel));
    if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    serveFile(req, res, f, 'no-cache');
  } catch (e) {
    if (!res.headersSent) fail(res, typeof e.code === 'number' ? e.code : 500, typeof e.code === 'number' ? e.message : 'Внутренняя ошибка');
    if (!e.code) console.error('[server]', e);
  }
});

(async () => {
  const first = A.ensureFirstUser();
  if (first) {
    console.log('\n==============================================================');
    console.log(' Создан первый пользователь для входа в админку (/admin):');
    console.log(`   логин: ${first.login}\n   пароль: ${first.password}`);
    console.log(' Пароль нужно будет сменить при первом входе. Запишите его сейчас.');
    console.log('==============================================================\n');
  }
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  S.getState(); // прогреваем кэш расписания
  setInterval(() => {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare("DELETE FROM screens WHERE last_seen < ? AND (name IS NULL OR name = '')").run(Date.now() - SCREEN_TTL);
  }, 3600e3);
  server.listen(PORT, HOST, () => console.log(`Панель: http://localhost:${PORT}/  (ТВ: /tv, админка: /admin)${sharp ? ', сжатие картинок включено' : ''}`));
})();
