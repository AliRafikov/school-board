// База данных SQLite (встроенный node:sqlite, один файл data/app.db).
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'app.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('director','it','zavuch','helper','viewer')),
  pass_hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT
);
-- Журнал: кто, что, когда. source: admin (действие в админке), system
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  source TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  target TEXT,
  was TEXT,
  now TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  ms INTEGER,
  reason TEXT,
  message TEXT,
  changes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video','pdf')),
  title TEXT NOT NULL DEFAULT '',
  duration INTEGER NOT NULL DEFAULT 10,
  date_from TEXT NOT NULL DEFAULT '',
  date_to TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 1,
  break_only INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- Расписание уроков: одна строка на класс, день (0 = понедельник), номер урока
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cls TEXT NOT NULL, day INTEGER NOT NULL, n INTEGER NOT NULL,
  subject TEXT NOT NULL DEFAULT '', teacher TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '',
  was_subject TEXT, was_teacher TEXT, was_room TEXT, changed_at INTEGER,
  UNIQUE(cls, day, n)
);
-- Звонки: уроки (n > 0) и перемены вроде завтрака и обеда (meal = 1, title задан)
CREATE TABLE IF NOT EXISTS bells (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  n INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '',
  start_t TEXT NOT NULL, end_t TEXT NOT NULL, classes TEXT NOT NULL DEFAULT '',
  meal INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
  was_start TEXT, was_end TEXT, changed_at INTEGER
);
-- Замены: по одной строке на класс; группируются при показе по дате, уроку, предмету и кабинету
CREATE TABLE IF NOT EXISTS subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL, lessons TEXT NOT NULL DEFAULT '', cls TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '', teacher TEXT NOT NULL DEFAULT '',
  absent TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', group_key TEXT NOT NULL DEFAULT '',
  created_by TEXT, created_at INTEGER NOT NULL
);
-- Текстовые объявления для центра экрана
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 10,
  date_from TEXT NOT NULL DEFAULT '', date_to TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS screens (
  id TEXT PRIMARY KEY,
  name TEXT,
  last_seen INTEGER NOT NULL,
  ip TEXT,
  ua TEXT,
  version TEXT,
  first_seen INTEGER NOT NULL
);
`);

try { db.exec("ALTER TABLE media ADD COLUMN place TEXT NOT NULL DEFAULT 'screen'"); } catch { /* колонка уже есть */ }
// привязка экрана: хэш секретного токена (в cookie на телевизоре), когда привязан
try { db.exec('ALTER TABLE screens ADD COLUMN token_hash TEXT'); } catch { /* колонка уже есть */ }
try { db.exec('ALTER TABLE screens ADD COLUMN paired_at INTEGER'); } catch { /* колонка уже есть */ }

db.exec(`CREATE TABLE IF NOT EXISTS bell_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bell_id INTEGER NOT NULL, date_from TEXT NOT NULL, date_to TEXT NOT NULL,
  start_t TEXT, end_t TEXT, cancelled INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0
)`);

// Telegram: привязка аккаунта (необязательно) и одноразовые коды привязки и входа
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'tg_id')) db.exec('ALTER TABLE users ADD COLUMN tg_id TEXT');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_tg_id ON users(tg_id) WHERE tg_id IS NOT NULL`);

// Роль «Помощник»: в старых базах список ролей в CHECK короче. SQLite не умеет менять ограничение,
// поэтому таблицу пересоздаём (пользователи, пароли и привязки Telegram переносятся как есть).
{
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (row && !String(row.sql).includes("'helper'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec(`CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('director','it','zavuch','helper','viewer')),
        pass_hash TEXT NOT NULL,
        must_change INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_login INTEGER,
        tg_id TEXT
      )`);
      db.exec('INSERT INTO users_new(id,login,name,role,pass_hash,must_change,active,created_at,last_login,tg_id) SELECT id,login,name,role,pass_hash,must_change,active,created_at,last_login,tg_id FROM users');
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_tg_id ON users(tg_id) WHERE tg_id IS NOT NULL');
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* уже откатилось */ } throw e; }
    finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
}
db.exec(`CREATE TABLE IF NOT EXISTS tg_codes (
  code_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('link','login')),
  user_id INTEGER, tg_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  ip TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
)`);

// уведомления бота: что уже сообщили (экран отключился / вернулся), чтобы не слать одно и то же каждую минуту
db.exec(`CREATE TABLE IF NOT EXISTS tg_alerts (key TEXT PRIMARY KEY, at INTEGER NOT NULL)`);

const DEFAULTS = {
  tz: process.env.TZ_NAME || 'Europe/Moscow',
  change_ttl_hours: '24',
  theme: 'light',               // тема днём: light — светлая, dark — тёмная
  night_mode: 'screen',         // что ночью: same — как днём, dark — тёмное расписание, screen — чёрный экран с временем и логотипом
  night_from: '21:00',          // ночь: с какого времени
  night_to: '07:00',            // и до какого (может идти через полночь)
  display_mode: 'auto',         // auto: на уроках статично; static: всегда статично; active: всегда активно
  board_seconds: '45',          // сколько секунд на экране «расписание/замены» между показами роликов
  data_rev: '0',                // номер версии данных: растёт при каждом изменении расписания
  refresh_epoch: '0',           // «Обновить все экраны»: экраны перезагружаются, когда число меняется
  school_name: 'Лицей-интернат №24',
  // оформление экрана: пустой цвет — стандартный; размер таблицы уроков в процентах; что показывать
  look_bg: '', look_panel: '', look_text: '', look_accent: '',
  look_font: '100', look_weather: '1', look_bells: '1', look_banners: '1',
  // каникулы: в эти даты вместо расписания экраны и публичная страница показывают название и дату возвращения
  holiday_from: '', holiday_to: '', holiday_title: ''
};

const getSetting = k => {
  const r = db.prepare('SELECT v FROM settings WHERE k = ?').get(k);
  return r ? r.v : DEFAULTS[k];
};
const setSetting = (k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
// Одноразовый перенос старой темы: раньше «auto» значило «светлая днём, ночью чёрный экран»,
// а «light»/«dark» ночного режима не имели вовсе.
if (!db.prepare("SELECT 1 FROM settings WHERE k = 'night_mode'").get()) {
  const old = db.prepare("SELECT v FROM settings WHERE k = 'theme'").get();
  if (old) {
    if (old.v === 'auto') { setSetting('theme', 'light'); setSetting('night_mode', 'screen'); }
    else setSetting('night_mode', 'same');
  }
}
const allSettings = () =>Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, getSetting(k)]));

function audit({ source = 'admin', user = null, action, target = '', was = null, now = null, details = '' }) {
  db.prepare('INSERT INTO audit(at,source,user_id,user_name,action,target,was,now,details) VALUES(?,?,?,?,?,?,?,?,?)').run(
    Date.now(), source, user ? user.id : null, user ? user.name : 'Система',
    action, target, was == null ? null : String(was), now == null ? null : String(now), details || '');
}

// одноразовая чистка: замены и изменения звонков на воскресенье (выходной). Больше не ставятся, старые убираем один раз.
if (getSetting('cleanup_sunday_v1') !== '1') {
  const s = db.prepare("DELETE FROM subs WHERE strftime('%w', date) = '0'").run().changes;
  const e = db.prepare("DELETE FROM bell_exceptions WHERE strftime('%w', date_from) = '0' OR strftime('%w', date_to) = '0'").run().changes;
  setSetting('cleanup_sunday_v1', '1');
  if (s || e) audit({ source: 'system', action: 'sunday_cleanup', target: 'Воскресные записи', now: `замен ${s}, изменений звонков ${e}` });
}

module.exports = { db, DATA, getSetting, setSetting, allSettings, audit, DEFAULTS };
