// Проверка входа и привязки через Telegram без связи с Telegram (запуск: node test/tgbot.test.js)
process.env.DATA_DIR = '/tmp/sb-tg-test-data';
require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
const { db } = require('../lib/db');
const A = require('../lib/auth');
const TGB = require('../lib/tgbot');
const sent = [];
TGB.setSender(async (m, b) => { sent.push([m, b]); return m === 'sendMessage' ? { message_id: 9 } : true; });
TGB.state.running = true; TGB.state.username = 'testbot';
const ok = (c, msg) => { console.log((c ? 'OK   ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

db.prepare('INSERT INTO users(login,name,role,pass_hash,must_change,created_at) VALUES(?,?,?,?,0,?)').run('ivanova', 'Иванова', 'zavuch', A.hashPassword('Pass12345'), Date.now());
const uid = db.prepare("SELECT id FROM users WHERE login='ivanova'").get().id;

(async () => {
  // 1. привязка
  const link = TGB.newCode('link', uid, '1.2.3.4');
  await TGB.onStart({ chat: { id: 1 }, from: { id: 111 }, text: '/start link_' + link });
  ok(db.prepare('SELECT tg_id FROM users WHERE id=?').get(uid).tg_id === '111', 'привязка по ссылке записала Telegram ID');
  await TGB.onStart({ chat: { id: 1 }, from: { id: 111 }, text: '/start link_' + link });
  ok(/устарела/.test(sent.at(-1)[1].text), 'повторное использование ссылки привязки отклонено');

  // 2. вход: подтверждение с нужного Telegram
  const login = TGB.newCode('login', null, '5.6.7.8');
  ok(TGB.findCode(login, 'login').status === 'new', 'код входа создан со статусом new');
  await TGB.onStart({ chat: { id: 1 }, from: { id: 111 }, text: '/start login_' + login });
  const kb = sent.at(-1)[1].reply_markup;
  ok(kb && kb.inline_keyboard[0][0].callback_data === 'ok:' + login, 'в боте показана кнопка подтверждения');
  ok(sent.at(-1)[1].text.includes('5.6.7.8'), 'в сообщении указан адрес, с которого начат вход');
  await TGB.onCallback({ id: 'c1', data: 'ok:' + login, from: { id: 222 }, message: { chat: { id: 1 }, message_id: 9 } });
  ok(TGB.findCode(login, 'login').status === 'waiting', 'чужой Telegram не может подтвердить вход');
  await TGB.onCallback({ id: 'c2', data: 'ok:' + login, from: { id: 111 }, message: { chat: { id: 1 }, message_id: 9 } });
  ok(TGB.findCode(login, 'login').status === 'confirmed', 'свой Telegram подтверждает вход');

  // 3. неизвестный Telegram не может начать вход
  const login2 = TGB.newCode('login', null, '5.6.7.8');
  await TGB.onStart({ chat: { id: 2 }, from: { id: 333 }, text: '/start login_' + login2 });
  ok(/не привязан/.test(sent.at(-1)[1].text) && TGB.findCode(login2, 'login').status === 'new', 'непривязанный Telegram не получает запрос на вход');

  // 4. отказ
  const login3 = TGB.newCode('login', null, '5.6.7.8');
  await TGB.onStart({ chat: { id: 1 }, from: { id: 111 }, text: '/start login_' + login3 });
  await TGB.onCallback({ id: 'c3', data: 'no:' + login3, from: { id: 111 }, message: { chat: { id: 1 }, message_id: 9 } });
  ok(TGB.findCode(login3, 'login').status === 'denied', 'кнопка «Нет» отклоняет вход');

  // 5. отвязка
  await TGB.onUnlink({ chat: { id: 1 }, from: { id: 111 }, text: '/unlink' });
  ok(db.prepare('SELECT tg_id FROM users WHERE id=?').get(uid).tg_id === null, '/unlink отвязывает Telegram');

  // 6. пароль работает как раньше
  ok(A.login('ivanova', 'Pass12345', '1.1.1.1').token !== undefined, 'вход по паролю не сломан');
  console.log(process.exitCode ? 'ЕСТЬ ОШИБКИ' : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
})();

