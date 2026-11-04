// Проверка уведомлений об экранах (запуск: node test/tgnotify.test.js). Без связи с Telegram.
process.env.DATA_DIR = '/tmp/sb-tgnotify-test';
require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
const TGB = require('../lib/tgbot');
let fails = 0; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };

// уведомления об экранах: одно сообщение при отключении и одно при возврате, без повторов
(async () => {
  const { db: d2 } = require('../lib/db');
  const texts = []; TGB.setSender(async (m, b) => { if (m === 'sendMessage') texts.push(b.text); return true; });
  d2.prepare("DELETE FROM users WHERE login='zav2'").run();
  d2.prepare("INSERT INTO users(login,name,role,pass_hash,must_change,created_at,tg_id) VALUES('zav2','Завуч',  'it','x',0,?,'555')").run(Date.now());
  d2.prepare("INSERT OR REPLACE INTO screens(id,name,last_seen,first_seen,token_hash) VALUES('scr1','Холл',?,?,'h')").run(Date.now() - 20 * 60e3, Date.now());
  await TGB.checkScreens(); await TGB.checkScreens(); // второй вызов не должен повторять
  ok(texts.filter(t => t.includes('не выходит на связь')).length === 1, 'отключённый экран сообщён один раз');
  d2.prepare("UPDATE screens SET last_seen=? WHERE id='scr1'").run(Date.now());
  await TGB.checkScreens();
  ok(texts.some(t => t.includes('снова на связи')), 'возврат экрана сообщён');
  d2.prepare("DELETE FROM users WHERE login='zav2'").run();
})();

process.on("exit", () => process.exitCode = fails ? 1 : 0);
