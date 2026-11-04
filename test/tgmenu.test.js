// Проверка меню бота: права по ролям, включение и отбой срочного сообщения (запуск: node test/tgmenu.test.js)
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'sb-tgmenu-test-' + process.pid);
require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
const { db } = require('../lib/db');
const TGB = require('../lib/tgbot');
const { getSetting } = require('../lib/db');
let fails = 0; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };

const sent = [];
TGB.setSender(async (m, b) => { sent.push({ m, b }); return m === 'sendMessage' ? { message_id: 7 } : true; });
TGB.state.running = true; TGB.state.username = 'testbot';
const addUser = (login, role, tg) => db.prepare('INSERT INTO users(login,name,role,pass_hash,must_change,created_at,tg_id) VALUES(?,?,?,?,0,?,?)').run(login, login, role, 'x', Date.now(), tg);
addUser('zav', 'zavuch', '901'); addUser('itman', 'it', '902');
const cb = (data, from) => ({ id: 'q' + Math.random(), data, from: { id: from }, message: { chat: { id: 1 }, message_id: 7 } });
const buttons = b => (b && b.inline_keyboard ? b.inline_keyboard.flat().map(x => x.callback_data) : []);

(async () => {
  // меню при /start
  await TGB.onStart({ chat: { id: 1 }, from: { id: 901 }, text: '/start' });
  ok(buttons(sent.at(-1).b.reply_markup).includes('m:urg'), 'завуч видит «Срочное сообщение»');
  await TGB.onStart({ chat: { id: 1 }, from: { id: 902 }, text: '/start' });
  const itBtns = buttons(sent.at(-1).b.reply_markup);
  ok(!itBtns.includes('m:urg') && itBtns.includes('m:scr'), 'IT-администратор видит экраны, но не срочные');

  // IT не может включить тревогу, даже если нажмёт кнопку напрямую
  await TGB.onCallback(cb('uy:missile', '902'));
  ok(!getSetting('urgent_title'), 'IT-администратор не может включить срочное сообщение');

  // завуч: выбрал тревогу, подтвердил
  await TGB.onCallback(cb('u:missile', '901'));
  ok(/Включить на всех экранах/.test(sent.filter(x => x.m === 'editMessageText').at(-1).b.text), 'подтверждение открыто перед включением');
  await TGB.onCallback(cb('uy:missile', '901'));
  ok(getSetting('urgent_title') === 'Ракетная опасность', 'завуч включил тревогу из бота');
  const aud = db.prepare("SELECT source, action FROM audit WHERE action='urgent_started' ORDER BY id DESC LIMIT 1").get();
  ok(aud && aud.source === 'telegram', 'в журнале видно, что включено из Telegram');

  // отбой с подтверждением
  await TGB.onCallback(cb('sy', '901'));
  ok(getSetting('urgent_title') === '', 'отбой выключил тревогу');
  ok(db.prepare("SELECT COUNT(*) c FROM audit WHERE action='urgent_stopped' AND source='telegram'").get().c === 1, 'отбой записан в журнал');

  // экраны и замены доступны IT
  await TGB.onCallback(cb('m:scr', '902'));
  ok(/Экраны|Экраны ещё/.test(sent.at(-1).b.text), 'IT-администратор открывает список экранов');
  await TGB.onCallback(cb('m:sub', '902'));
  ok(/замен/.test(sent.at(-1).b.text), 'IT-администратор открывает замены на сегодня');

  // чужой Telegram не получает доступ
  await TGB.onCallback(cb('m:urg', '999'));
  ok(sent.at(-1).m === 'answerCallbackQuery' && sent.at(-1).b.text === 'Telegram не привязан', 'неизвестному Telegram отвечают отказом');

  console.log(fails ? 'ЕСТЬ ОШИБКИ' : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exitCode = fails ? 1 : 0;
})();
