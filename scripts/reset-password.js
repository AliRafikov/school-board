// Сброс пароля, если забыли.   node scripts/reset-password.js [логин]     (по умолчанию director)
// Печатает новый временный пароль; при входе система потребует его сменить. Закрывает все открытые сессии этого пользователя.
const { db, audit } = require('../lib/db');
const A = require('../lib/auth');
const login = process.argv[2] || 'director';
const u = db.prepare('SELECT id, login, role FROM users WHERE login = ?').get(login);
if (!u) {
  const all = db.prepare('SELECT login, role, active FROM users ORDER BY id').all();
  console.error(`Пользователь «${login}» не найден. Есть: ${all.map(x => x.login + ' (' + x.role + ')').join(', ') || 'никого'}`);
  process.exit(1);
}
const pw = A.generatePassword();
db.prepare('UPDATE users SET pass_hash = ?, must_change = 1, active = 1 WHERE id = ?').run(A.hashPassword(pw), u.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
audit({ source: 'system', action: 'password_reset', target: u.login, details: 'через сервер' });
console.log(`\nНовый временный пароль для «${u.login}»: ${pw}\nВойдите и сразу смените его. (Если вход заблокирован после неудачных попыток, перезапустите программу.)\n`);
