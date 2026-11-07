// Проверка новых функций бота: замена по шагам, фото → постер, напоминания (запуск: node test/tgflow.test.js)
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'sb-tgflow-test-' + process.pid);
require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
const { db, setSetting } = require('../lib/db');
const TGB = require('../lib/tgbot');
const URG = require('../lib/urgent');
let fails = 0; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };

const sent = [];
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
TGB.setSender(async (m, b) => { sent.push({ m, b }); return m === 'sendMessage' ? { message_id: 7 } : m === 'getFile' ? { file_path: 'photos/p.jpg' } : true; }, async () => JPEG);
TGB.state.running = true; TGB.state.username = 'testbot';
const addUser = (login, name, role, tg) => db.prepare('INSERT INTO users(login,name,role,pass_hash,must_change,created_at,tg_id) VALUES(?,?,?,?,0,?,?)').run(login, name, role, 'x', Date.now(), tg);
addUser('zav', 'Завуч Тест', 'zavuch', '901'); addUser('help', 'Помощник Тест', 'helper', '903'); addUser('help2', 'Другой Помощник', 'helper', '904'); addUser('viewer', 'Зритель', 'viewer', '905');
db.prepare("INSERT INTO lessons(cls,day,n,subject) VALUES('8А',0,1,'Математика'),('8Б',0,1,'Математика'),('10А',0,1,'Физика')").run();
const cb = (data, from) => ({ id: 'q' + Math.random(), data, from: { id: from }, message: { chat: { id: 1 }, message_id: 7 } });
const buttons = b => (b && b.inline_keyboard ? b.inline_keyboard.flat().map(x => x.callback_data) : []);
const last = () => sent.at(-1);
const txt = m => String((m.b && m.b.text) || '');

(async () => {
  // разбор текста
  const P = TGB.parseSubText;
  ok(JSON.stringify(P('205, Петрова')) === JSON.stringify({ room: '205', teacher: 'Петрова', subject: '' }), 'разбор: кабинет и учитель');
  ok(P('Петрова, математика, 205').subject === 'математика' && P('Петрова, математика, 205').room === '205', 'разбор: учитель, предмет, кабинет в любом порядке');
  ok(P('Отменён').subject === 'отменён', 'разбор: «отменён»');
  ok(P('   ') === null, 'разбор: пустой текст не принимается');

  // меню: завуч видит замену, помощник — только подсказку про фото, без кнопок
  await TGB.onStart({ chat: { id: 1 }, from: { id: 901 }, text: '/start' });
  ok(buttons(last().b.reply_markup).includes('sa:start'), 'завуч видит «Добавить замену»');
  await TGB.onStart({ chat: { id: 1 }, from: { id: 903 }, text: '/start' });
  ok(!last().b.reply_markup && txt(last()).includes('пришлите фото'), 'помощнику в меню — подсказка про фото, кнопок нет');

  // помощник и зритель не могут добавлять замену
  await TGB.onCallback(cb('sa:start', '903'));
  ok(last().m === 'answerCallbackQuery' && last().b.text === 'Нет прав', 'помощник не может добавить замену');

  // замена по шагам
  await TGB.onCallback(cb('sa:start', '901'));
  const dateBtn = buttons(last().b.reply_markup).find(x => x.startsWith('sa:d:'));
  ok(!!dateBtn, 'бот предлагает даты');
  await TGB.onCallback(cb(dateBtn, '901'));
  ok(buttons(last().b.reply_markup).includes('sa:c:8А') && buttons(last().b.reply_markup).includes('sa:c:10А'), 'бот показывает классы из расписания');
  await TGB.onCallback(cb('sa:c:8А', '901')); await TGB.onCallback(cb('sa:c:8Б', '901'));
  ok(JSON.stringify(last().b.reply_markup).includes('✓ 8А'), 'выбранный класс отмечен');
  await TGB.onCallback(cb('sa:cd', '901'));
  await TGB.onCallback(cb('sa:l:3', '901'));
  ok(txt(last()).includes('кабинет и учителя'), 'бот просит кабинет и учителя');
  const handled = await TGB.onFlowText({ chat: { id: 1 }, from: { id: 901 }, text: '205, Петрова' });
  ok(handled && txt(last()).includes('Классы: 8А, 8Б') && txt(last()).includes('Кабинет: 205'), 'бот показывает итог перед записью');
  ok(db.prepare('SELECT COUNT(*) c FROM subs').get().c === 0, 'до подтверждения замена не записана');
  await TGB.onCallback(cb('sa:ok', '901'));
  const subs = db.prepare('SELECT cls,lessons,room,teacher FROM subs ORDER BY cls').all();
  ok(subs.length === 2 && subs[0].cls === '8А' && subs[0].lessons === '3' && subs[0].room === '205' && subs[0].teacher === 'Петрова', 'замена записана для обоих классов');
  ok(db.prepare("SELECT source FROM audit WHERE action='substitution_added'").get().source === 'telegram', 'в журнале источник — Telegram');
  ok(!(await TGB.onFlowText({ chat: { id: 1 }, from: { id: 901 }, text: 'просто текст' })), 'после записи лишний текст игнорируется');
  // «отменён» — это отмена урока, а не замена с названием «Отменён»
  await TGB.onCallback(cb('sa:start', '901')); await TGB.onCallback(cb(buttons(last().b.reply_markup).find(x => x.startsWith('sa:d:')), '901'));
  await TGB.onCallback(cb('sa:c:10А', '901')); await TGB.onCallback(cb('sa:cd', '901')); await TGB.onCallback(cb('sa:l:5', '901'));
  await TGB.onFlowText({ chat: { id: 1 }, from: { id: 901 }, text: 'Отменён' }); await TGB.onCallback(cb('sa:ok', '901'));
  ok(db.prepare("SELECT subject FROM subs WHERE cls='10А'").get().subject === 'урок отменён', '«отменён» записывается как отмена урока');

  // фото → постер
  await TGB.onMedia({ chat: { id: 1 }, from: { id: 903 }, photo: [{ file_id: 'small' }, { file_id: 'big' }], caption: 'Родительское собрание' });
  const m1 = db.prepare('SELECT * FROM media').get();
  ok(m1 && m1.title === 'Родительское собрание' && m1.place === 'screen' && m1.created_by === 'Помощник Тест', 'фото от помощника сразу стало постером с подписью как названием');
  ok(db.prepare("SELECT source FROM audit WHERE action='media_uploaded'").get().source === 'telegram', 'загрузка записана в журнал как Telegram');
  await TGB.onMedia({ chat: { id: 1 }, from: { id: 905 }, photo: [{ file_id: 'x' }] });
  ok(db.prepare('SELECT COUNT(*) c FROM media').get().c === 1 && txt(last()).includes('нет права'), 'роль «Просмотр» постер не добавит');
  await TGB.onMedia({ chat: { id: 1 }, from: { id: 999 }, photo: [{ file_id: 'x' }] });
  ok(db.prepare('SELECT COUNT(*) c FROM media').get().c === 1, 'непривязанный Telegram постер не добавит');

  // права на постер: чужой помощник не убирает, свой и завуч — могут
  await TGB.onCallback(cb(`mp:del:${m1.id}`, '904'));
  ok(db.prepare('SELECT COUNT(*) c FROM media').get().c === 1, 'чужой помощник не может убрать постер');
  await TGB.onCallback(cb(`mp:pl:${m1.id}:center`, '903'));
  ok(db.prepare('SELECT place FROM media').get().place === 'center', 'автор переносит постер в центр экрана');
  await TGB.onCallback(cb(`mp:del:${m1.id}`, '903'));
  ok(db.prepare('SELECT COUNT(*) c FROM media').get().c === 0, 'автор убирает свой постер');
  await TGB.onMedia({ chat: { id: 1 }, from: { id: 903 }, photo: [{ file_id: 'a' }] });
  await TGB.onCallback(cb(`mp:del:${db.prepare('SELECT id FROM media').get().id}`, '901'));
  ok(db.prepare('SELECT COUNT(*) c FROM media').get().c === 0, 'завуч убирает любой постер');

  // напоминания (фиксированное время: вторник 16:30 по Москве)
  const NOW = Date.UTC(2026, 10, 10, 13, 30);
  db.prepare("INSERT INTO media(file,kind,title,created_at,date_to) VALUES('f.jpg','image','Конкурс',?,'2026-11-11')").run(Date.now());
  db.prepare("INSERT INTO announcements(title,created_at,date_to) VALUES('Сбор макулатуры',?,'2026-11-11')").run(Date.now());
  URG.start({ title: 'Тест тревога', source: '', note: '', end: '' }, { id: 1, name: 'Завуч Тест' }, 'telegram');
  setSetting('urgent_since', String(NOW - 40 * 60e3));
  const before = sent.length;
  await TGB.checkReminders(NOW);
  const msgs = sent.slice(before).filter(x => x.m === 'sendMessage');
  const to = id => msgs.filter(x => String(x.b.chat_id) === id).map(x => txt(x));
  ok(to('901').some(t => t.includes('висит на экранах уже 40 мин')), 'завуч получил напоминание про долгую тревогу');
  ok(to('901').some(t => t.includes('замен пока нет')), 'завуч получил напоминание: на завтра нет замен');
  ok(to('901').some(t => t.includes('«Конкурс»')) && to('903').some(t => t.includes('«Конкурс»')), 'завуч и помощник получили: постер истекает завтра');
  ok(to('903').some(t => t.includes('Сбор макулатуры')), 'помощник получил: объявление истекает завтра');
  ok(!to('903').some(t => t.includes('замен пока нет') || t.includes('висит на экранах')), 'помощнику не приходят напоминания про замены и тревогу');
  ok(to('905').length === 0, 'роль «Просмотр» напоминаний не получает');
  const n1 = sent.length; await TGB.checkReminders(NOW);
  ok(sent.length === n1, 'повторная проверка те же напоминания не дублирует');
  const n2 = sent.length; await TGB.checkReminders(Date.UTC(2026, 10, 10, 20, 30)); // 23:30 по Москве
  ok(sent.filter((x, i) => i >= n2 && x.m === 'sendMessage').length === 0, 'ночью напоминания не отправляются');

  console.log(fails ? `\nПровалено: ${fails}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
