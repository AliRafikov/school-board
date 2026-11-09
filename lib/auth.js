// Пользователи, пароли (scrypt), сессии (cookie), роли, ограничение попыток входа.
const crypto = require('crypto');
const { db, audit } = require('./db');

const ROLES = {
  director: 'Директор',
  it: 'IT-администратор',
  zavuch: 'Завуч',
  helper: 'Помощник',
  viewer: 'Просмотр',
  owner: 'Владелец'
};
// Что разрешено каждой роли.
// Помощник (старшеклассник): сам публикует объявления и постеры, но не включает тревогу и не трогает замены и расписание.
const CAN = {
  users: ['director', 'it'],
  settings: ['director', 'it'],
  media: ['director', 'it', 'zavuch', 'helper'],
  refresh: ['director', 'it', 'zavuch'],
  screens: ['director', 'it', 'zavuch'],
  audit: ['director', 'it', 'zavuch'],
  schedule: ['director', 'it', 'zavuch'],
  subs: ['director', 'it', 'zavuch'],
  announcements: ['director', 'it', 'zavuch', 'helper'],
  urgent: ['director', 'it', 'zavuch'],
  overview: ['director', 'it', 'zavuch', 'helper', 'viewer']
};
// Владелец — единственная такая учётная запись в школе: может всё, включая других директоров.
const can = (user, what) => !!user && (user.role === 'owner' || CAN[what].includes(user.role));

const SESSION_DAYS = 7;
const IDLE_MS = 12 * 3600e3;   // без действий 12 часов — вход закрывается, даже если срок ещё не вышел
const TOUCH_MS = 5 * 60e3;      // время последнего действия пишем не чаще раза в 5 минут
const COOKIE = 'sb_session';

// ---- пароли ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hashHex, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
// Частые пароли, которые не пускаем даже при нужной длине (проверяем в нижнем регистре).
const COMMON_PASSWORDS = new Set([
  '123456789012', '1234567890123', 'qwerty123456', 'password1234', 'password12345',
  'qwertyuiop12', 'admin1234567', 'iloveyou1234', 'privet123456', 'school123456',
  'школа12345678', 'пароль123456', 'директор2026', 'licey1234567'
]);
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Пароль должен быть не короче 12 символов';
  if (!/\d/.test(pw) || !/[A-Za-zА-Яа-яЁё]/.test(pw)) return 'В пароле нужны и буквы, и цифры';
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return 'Этот пароль слишком часто встречается — придумайте другой';
  return '';
}
function generatePassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXYZ23456789';
  let s = ''; for (const b of crypto.randomBytes(12)) s += abc[b % abc.length];
  return s;
}

// ---- ограничение попыток входа: 5 неудач → блокировка на 10 минут (по логину и по IP) ----
const fails = new Map();
// Пороги: «логин + адрес» — 5; по адресу — 150 (школа сидит за одним NAT, поэтому порог высокий:
// иначе один хулиган 40 неудачами закрыл бы вход всем учителям); по одному логину со всех адресов вместе — 30.
const LOCK_MS = 10 * 60 * 1000, MAX_FAILS = 5, MAX_FAILS_IP = 150, MAX_FAILS_LOGIN = 30;
const limitFor = key => key.startsWith('i:') ? MAX_FAILS_IP : key.startsWith('g:') ? MAX_FAILS_LOGIN : MAX_FAILS;
function lockedFor(key) {
  const f = fails.get(key);
  return f && f.n >= limitFor(key) && Date.now() - f.at < LOCK_MS ? Math.ceil((LOCK_MS - (Date.now() - f.at)) / 60000) : 0;
}
// чистим старые записи, чтобы таблица не росла (перебор с тысяч адресов)
function pruneFails() {
  if (fails.size < 5000) return;
  const now = Date.now();
  for (const [k, f] of fails) if (now - f.at >= LOCK_MS) fails.delete(k);
  if (fails.size > 20000) fails.clear();
}
function noteFail(key) { const f = fails.get(key); fails.set(key, { n: (f && Date.now() - f.at < LOCK_MS ? f.n : 0) + 1, at: Date.now() }); }

// ---- сессии ----
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
function createSession(userId, ip) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,ip,last_seen) VALUES(?,?,?,?,?,?)').run(sha(token), userId, now, now + SESSION_DAYS * 864e5, ip || '', now);
  return token;
}
function parseCookies(h) {
  const o = {}; String(h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function userFromReq(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const tokenHash = sha(token);
  const row = db.prepare(`SELECT u.id,u.login,u.name,u.role,u.must_change,u.active,(u.tg_id IS NOT NULL) AS tg,s.expires_at,s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(tokenHash);
  if (!row || !row.active || row.expires_at < Date.now()) return null;
  const now = Date.now();
  // сессия без действий дольше IDLE_MS закрывается: забытый вход на чужом компьютере не живёт неделю
  if (row.last_seen && now - row.last_seen > IDLE_MS) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash); return null; }
  if (!row.last_seen || now - row.last_seen > TOUCH_MS) db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(now, tokenHash);
  return { id: row.id, login: row.login, name: row.name, role: row.role, must_change: !!row.must_change, tg: !!row.tg };
}
const cookieHeader = (token, secure) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
// закрыть все сессии пользователя, кроме текущей (после смены пароля или роли)
function destroyOtherSessions(userId, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(userId, token ? sha(token) : '');
}
// закрыть все сессии пользователя, включая текущую («выйти на всех устройствах»)
function destroyAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
}
function destroySession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
}

function login(loginName, password, ip) {
  // блокировка по паре «логин + адрес»: чужой адрес не может закрыть вход директору
  pruneFails();
  const lname = String(loginName).toLowerCase().slice(0, 60);
  const keyL = 'u:' + lname + '|' + ip, keyI = 'i:' + ip, keyG = 'g:' + lname;
  const wait = Math.max(lockedFor(keyL), lockedFor(keyI), lockedFor(keyG));
  if (wait) return { error: `Слишком много попыток. Попробуйте через ${wait} мин.` };
  const u = db.prepare('SELECT * FROM users WHERE login = ?').get(String(loginName));
  const ok = u && u.active && checkPassword(String(password), u.pass_hash);
  if (!u) crypto.scryptSync('x', 'salt', 64); // выравниваем время ответа
  if (!ok) { noteFail(keyL); noteFail(keyI); noteFail(keyG); audit({ source: 'system', action: 'login_failed', target: String(loginName).slice(0, 60), details: ip }); return { error: 'Неверный логин или пароль' }; }
  fails.delete(keyL); fails.delete(keyI); fails.delete(keyG);
  db.prepare('UPDATE users SET last_login=? WHERE id=?').run(Date.now(), u.id);
  audit({ user: u, action: 'login', target: u.login });
  return { token: createSession(u.id, ip), user: u };
}

// ---- пользователи ----
function ensureFirstUser() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c) return null;
  const pw = process.env.INITIAL_ADMIN_PASSWORD || generatePassword();
  db.prepare('INSERT INTO users(login,name,role,pass_hash,must_change,created_at) VALUES(?,?,?,?,1,?)').run('director', 'Директор', 'director', hashPassword(pw), Date.now());
  audit({ source: 'system', action: 'first_user', target: 'director' });
  return { login: 'director', password: pw };
}

module.exports = { ROLES, can, hashPassword, checkPassword, passwordProblem, generatePassword, login, userFromReq, cookieHeader, clearCookie, createSession, destroySession, destroyOtherSessions, destroyAllSessions, ensureFirstUser, parseCookies, sha };
