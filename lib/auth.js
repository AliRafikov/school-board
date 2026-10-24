// Пользователи, пароли (scrypt), сессии (cookie), роли, ограничение попыток входа.
const crypto = require('crypto');
const { db, audit } = require('./db');

const ROLES = {
  director: 'Директор',
  it: 'IT-администратор',
  zavuch: 'Завуч',
  viewer: 'Просмотр'
};
// Что разрешено каждой роли
const CAN = {
  users: ['director', 'it'],
  settings: ['director', 'it'],
  media: ['director', 'it', 'zavuch'],
  refresh: ['director', 'it', 'zavuch'],
  screens: ['director', 'it', 'zavuch'],
  audit: ['director', 'it', 'zavuch'],
  schedule: ['director', 'it', 'zavuch'],
  subs: ['director', 'it', 'zavuch'],
  announcements: ['director', 'it', 'zavuch'],
  overview: ['director', 'it', 'zavuch', 'viewer']
};
const can = (user, what) => !!user && CAN[what].includes(user.role);

const SESSION_DAYS = 14;
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
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Пароль должен быть не короче 8 символов';
  if (!/\d/.test(pw) || !/[A-Za-zА-Яа-яЁё]/.test(pw)) return 'В пароле нужны и буквы, и цифры';
  return '';
}
function generatePassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXYZ23456789';
  let s = ''; for (const b of crypto.randomBytes(12)) s += abc[b % abc.length];
  return s;
}

// ---- ограничение попыток входа: 5 неудач → блокировка на 10 минут (по логину и по IP) ----
const fails = new Map();
const LOCK_MS = 10 * 60 * 1000, MAX_FAILS = 5, MAX_FAILS_IP = 40; // по IP порог выше: в школе много людей за одним адресом
function lockedFor(key) {
  const f = fails.get(key);
  return f && f.n >= (key.startsWith('i:') ? MAX_FAILS_IP : MAX_FAILS) && Date.now() - f.at < LOCK_MS ? Math.ceil((LOCK_MS - (Date.now() - f.at)) / 60000) : 0;
}
function noteFail(key) { const f = fails.get(key); fails.set(key, { n: (f && Date.now() - f.at < LOCK_MS ? f.n : 0) + 1, at: Date.now() }); }

// ---- сессии ----
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
function createSession(userId, ip) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,ip) VALUES(?,?,?,?,?)').run(sha(token), userId, now, now + SESSION_DAYS * 864e5, ip || '');
  return token;
}
function parseCookies(h) {
  const o = {}; String(h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function userFromReq(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT u.id,u.login,u.name,u.role,u.must_change,u.active,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sha(token));
  if (!row || !row.active || row.expires_at < Date.now()) return null;
  return { id: row.id, login: row.login, name: row.name, role: row.role, must_change: !!row.must_change };
}
const cookieHeader = (token, secure) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
// закрыть все сессии пользователя, кроме текущей (после смены пароля или роли)
function destroyOtherSessions(userId, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(userId, token ? sha(token) : '');
}
function destroySession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
}

function login(loginName, password, ip) {
  // блокировка по паре «логин + адрес»: чужой адрес не может закрыть вход директору
  const keyL = 'u:' + String(loginName).toLowerCase() + '|' + ip, keyI = 'i:' + ip;
  const wait = Math.max(lockedFor(keyL), lockedFor(keyI));
  if (wait) return { error: `Слишком много попыток. Попробуйте через ${wait} мин.` };
  const u = db.prepare('SELECT * FROM users WHERE login = ?').get(String(loginName));
  const ok = u && u.active && checkPassword(String(password), u.pass_hash);
  if (!u) crypto.scryptSync('x', 'salt', 64); // выравниваем время ответа
  if (!ok) { noteFail(keyL); noteFail(keyI); audit({ source: 'system', action: 'login_failed', target: String(loginName).slice(0, 60), details: ip }); return { error: 'Неверный логин или пароль' }; }
  fails.delete(keyL); fails.delete(keyI);
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

module.exports = { ROLES, can, hashPassword, checkPassword, passwordProblem, generatePassword, login, userFromReq, cookieHeader, clearCookie, destroySession, destroyOtherSessions, ensureFirstUser, parseCookies, sha };
