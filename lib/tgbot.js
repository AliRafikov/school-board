// Telegram-бот: привязка аккаунта сотрудника и подтверждение входа на сайт.
// Без внешних пакетов: long polling через fetch. Работает только если задан TG_BOT_TOKEN;
// без токена всё остаётся как раньше (вход по паролю).
const crypto = require('crypto');
const { db, audit, getSetting } = require('./db');
const URG = require('./urgent');
const SC = require('./schedule');
const M = require('./media');
const S = require('./sync');

const TOKEN = process.env.TG_BOT_TOKEN || '';
const API = `https://api.telegram.org/bot${TOKEN}/`;
const TTL = { link: 10 * 60e3, login: 2 * 60e3 }; // ссылка привязки — 10 минут, вход — 2 минуты

const state = { enabled: !!TOKEN, running: false, username: '', sender: null };
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

// Вызов Telegram Bot API. В тестах подменяется через setSender.
async function call(method, body) {
  if (state.sender) return state.sender(method, body);
  const r = await fetch(API + method, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(40e3)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || 'Ошибка Telegram');
  return j.result;
}
const say = (chat_id, text, extra = {}) => call('sendMessage', { chat_id, text, ...extra });
const edit = (chat_id, message_id, text, reply_markup) => call('editMessageText', { chat_id, message_id, text, ...(reply_markup ? { reply_markup } : {}) }).catch(() => {});

// ---- одноразовые коды (в базе хранится только их хэш) ----
function newCode(kind, userId, ip) {
  const raw = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  db.prepare('DELETE FROM tg_codes WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO tg_codes(code_hash,kind,user_id,tg_id,status,ip,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(sha(raw), kind, userId || null, null, 'new', ip || '', now, now + TTL[kind]);
  return raw;
}
function findCode(raw, kind) {
  const row = db.prepare('SELECT * FROM tg_codes WHERE code_hash=?').get(sha(String(raw || '')));
  if (!row || row.kind !== kind || row.expires_at < Date.now()) return null;
  return row;
}
const dropCode = hash => db.prepare('DELETE FROM tg_codes WHERE code_hash=?').run(hash);
const userByTg = tg => db.prepare('SELECT id,name,login,role FROM users WHERE tg_id=? AND active=1').get(String(tg));

const linkUrl = raw => `https://t.me/${state.username}?start=link_${raw}`;
const loginUrl = raw => `https://t.me/${state.username}?start=login_${raw}`;

// ---- обработчики сообщений ----
async function onStart(msg) {
  const chat = msg.chat.id, from = String(msg.from.id);
  const arg = (msg.text || '').split(/\s+/)[1] || '';
  if (arg.startsWith('link_')) return onLink(chat, from, arg.slice(5));
  if (arg.startsWith('login_')) return onLogin(chat, from, arg.slice(6), msg);
  const u = userByTg(from);
  if (!u) return say(chat, 'Этот бот нужен для входа в админку школы. Привяжите аккаунт в админке: кнопка «Telegram» у вашей учётной записи.');
  return showMenu(chat, u);
}

async function onLink(chat, from, raw) {
  const row = findCode(raw, 'link');
  if (!row || row.status !== 'new') return say(chat, 'Ссылка устарела. Создайте новую в админке.');
  const taken = db.prepare('SELECT name FROM users WHERE tg_id=? AND id<>?').get(from, row.user_id);
  if (taken) return say(chat, 'Этот Telegram уже привязан к другой учётной записи.');
  const u = db.prepare('SELECT id,name,login FROM users WHERE id=? AND active=1').get(row.user_id);
  if (!u) { dropCode(row.code_hash); return say(chat, 'Учётная запись отключена.'); }
  db.prepare('UPDATE users SET tg_id=? WHERE id=?').run(from, u.id);
  dropCode(row.code_hash);
  audit({ source: 'telegram', user: u, action: 'tg_linked', target: u.login });
  return say(chat, `Готово: Telegram привязан к учётной записи «${u.name}».`);
}

async function onLogin(chat, from, raw, msg) {
  const row = findCode(raw, 'login');
  if (!row || row.status !== 'new') return say(chat, 'Ссылка устарела. Нажмите «Войти через Telegram» на сайте ещё раз.');
  const u = userByTg(from);
  if (!u) return say(chat, 'Этот Telegram не привязан к учётной записи. Привяжите его в админке.');
  db.prepare("UPDATE tg_codes SET status='waiting', user_id=?, tg_id=? WHERE code_hash=?").run(u.id, from, row.code_hash);
  return say(chat, `Вход на сайт школы.\nАдрес: ${row.ip || 'неизвестен'}\nВход для «${u.name}». Подтвердить?`, {
    reply_markup: { inline_keyboard: [[{ text: 'Да, это я', callback_data: 'ok:' + raw }, { text: 'Нет', callback_data: 'no:' + raw }]] }
  });
}

async function onUnlink(msg) {
  const from = String(msg.from.id);
  const u = userByTg(from);
  if (!u) return say(msg.chat.id, 'Telegram и так не привязан.');
  db.prepare('UPDATE users SET tg_id=NULL WHERE id=?').run(u.id);
  audit({ source: 'telegram', user: u, action: 'tg_unlinked', target: u.login });
  return say(msg.chat.id, 'Telegram отвязан от учётной записи.');
}

async function onCallback(cq) {
  if (/^(sa:|mp:)/.test(String(cq.data || ''))) return onFlowCallback(cq);
  if (/^(m:|u:|uy:|sy$|hc$)/.test(String(cq.data || ''))) return onMenuCallback(cq);
  const [act, raw] = String(cq.data || '').split(':');
  const from = String(cq.from.id);
  const answer = text => call('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
  const row = findCode(raw, 'login');
  // подтверждать может только тот Telegram, с которого начали вход
  if (!row || row.status !== 'waiting' || row.tg_id !== from) return answer('Запрос устарел');
  const chat = cq.message.chat.id, mid = cq.message.message_id;
  if (act === 'no') {
    db.prepare("UPDATE tg_codes SET status='denied' WHERE code_hash=?").run(row.code_hash);
    await answer('Отменено');
    return edit(chat, mid, 'Вход отменён. Если это были не вы, смените пароль на сайте.');
  }
  if (act === 'ok') {
    db.prepare("UPDATE tg_codes SET status='confirmed' WHERE code_hash=?").run(row.code_hash);
    await answer('Подтверждено');
    return edit(chat, mid, 'Вход подтверждён. Вернитесь на сайт.');
  }
}

// ---- меню действий (кнопки в боте) ----
// срочные сообщения — только директор и завуч; экраны и замены — все руководящие роли
const URGENT_ROLES = ['director', 'zavuch'];
const VIEW_ROLES = ['director', 'zavuch', 'it'];
const SUBS_ROLES = VIEW_ROLES;                                  // замены добавляют те же роли, что и в админке
const MEDIA_ROLES = ['director', 'zavuch', 'it', 'helper'];     // фото → постер: ещё и помощник
const todayMsk = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

function menuKeyboard(role) {
  const rows = [];
  if (URGENT_ROLES.includes(role)) rows.push([{ text: '🚨 Срочное сообщение', callback_data: 'm:urg' }]);
  if (SUBS_ROLES.includes(role)) rows.push([{ text: '➕ Добавить замену', callback_data: 'sa:start' }]);
  if (VIEW_ROLES.includes(role)) rows.push([{ text: '📺 Экраны', callback_data: 'm:scr' }, { text: '📋 Замены сегодня', callback_data: 'm:sub' }]);
  if (URGENT_ROLES.includes(role) && URG.status().active) rows.push([{ text: '⏹ Отбой', callback_data: 'm:stop' }]);
  if (URGENT_ROLES.includes(role) && URG.clearActive()) rows.push([{ text: '🧹 Убрать зелёный отбой', callback_data: 'hc' }]);
  return { inline_keyboard: rows };
}
async function showMenu(chat, u) {
  const st = URG.status();
  const head = st.active ? `⚠️ Сейчас на экранах: «${st.title}».\n\n` : '';
  const kb = menuKeyboard(u.role);
  const tip = MEDIA_ROLES.includes(u.role) ? '\n\n📷 Чтобы поставить постер на экран, просто пришлите фото в этот чат. Подпись к фото станет названием.' : '';
  return say(chat, `${head}Меню, «${u.name}». ${kb.inline_keyboard.length ? 'Выберите действие.' : 'Здесь пока нет кнопок для вашей роли.'}${tip}`, kb.inline_keyboard.length ? { reply_markup: kb } : {});
}

const presetById = id => URG.PRESETS.find(x => x.id === id);
const back = { text: '« Назад', callback_data: 'm:back' };

async function onMenuCallback(cq) {
  const data = String(cq.data || '');
  const from = String(cq.from.id);
  const answer = text => call('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
  const chat = cq.message.chat.id, mid = cq.message.message_id;
  const u = userByTg(from);
  if (!u) return answer('Telegram не привязан');
  const canUrgent = URGENT_ROLES.includes(u.role), canView = VIEW_ROLES.includes(u.role);
  const show = (text, markup) => edit(chat, mid, text, markup);

  if (data === 'm:back') { await answer(''); return show(`Меню, «${u.name}». Выберите действие.`, menuKeyboard(u.role)); }

  if (data === 'm:urg') {
    if (!canUrgent) return answer('Нет прав');
    await answer('');
    const rows = URG.PRESETS.map(p => [{ text: p.title, callback_data: 'u:' + p.id }]);
    if (URG.status().active) rows.push([{ text: '⏹ Отбой', callback_data: 'm:stop' }]);
    rows.push([back]);
    return show('Какое сообщение включить на всех экранах?', { inline_keyboard: rows });
  }
  if (data.startsWith('u:')) {
    if (!canUrgent) return answer('Нет прав');
    const p = presetById(data.slice(2)); if (!p) return answer('Неизвестная тревога');
    await answer('');
    return show(`Включить на всех экранах: «${p.title}»?\n\n${p.note}`, { inline_keyboard: [
      [{ text: 'Да, включить', callback_data: 'uy:' + p.id }], [back]] });
  }
  if (data.startsWith('uy:')) {
    if (!canUrgent) return answer('Нет прав');
    const p = presetById(data.slice(3)); if (!p) return answer('Неизвестная тревога');
    URG.start(p, u, 'telegram');
    await answer('Включено');
    return show(`🚨 Включено на всех экранах: «${p.title}».`, { inline_keyboard: [[{ text: '⏹ Отбой', callback_data: 'm:stop' }]] });
  }
  if (data === 'm:stop') {
    if (!canUrgent) return answer('Нет прав');
    await answer('');
    return show('Отправить отбой на все экраны?', { inline_keyboard: [[{ text: 'Да, отбой', callback_data: 'sy' }], [back]] });
  }
  if (data === 'hc') {
    if (!canUrgent) return answer('Нет прав');
    URG.hideClear(u, 'telegram');
    await answer('Убрано');
    return show(`Меню, «${u.name}». Выберите действие.`, menuKeyboard(u.role));
  }
  if (data === 'sy') {
    if (!canUrgent) return answer('Нет прав');
    URG.stop(u, 'telegram');
    await answer('Отбой отправлен');
    return show('✅ Отбой отправлен на экраны.', menuKeyboard(u.role));
  }
  if (data === 'm:scr') {
    if (!canView) return answer('Нет прав');
    await answer('');
    const now = Date.now();
    const rows = db.prepare('SELECT id, name, last_seen FROM screens WHERE token_hash IS NOT NULL ORDER BY name, id').all();
    const lines = rows.map(r => {
      const off = now - r.last_seen > OFFLINE_AFTER;
      return `${off ? '🔴' : '🟢'} ${r.name || r.id.slice(0, 6)}${off ? ' — нет связи с ' + hhmm(r.last_seen) : ''}`;
    });
    return show(lines.length ? 'Экраны:\n' + lines.join('\n') : 'Экраны ещё не привязаны.', { inline_keyboard: [[back]] });
  }
  if (data === 'm:sub') {
    if (!canView) return answer('Нет прав');
    await answer('');
    const rows = db.prepare('SELECT lessons, cls, subject, room, teacher, absent FROM subs WHERE date = ? ORDER BY cls, lessons').all(todayMsk());
    const lines = rows.map(r => `${r.lessons ? r.lessons + ' ур. ' : ''}${r.cls}: ${r.subject}${r.room ? ', каб. ' + r.room : ''}${r.teacher ? ', ' + r.teacher : ''}${r.absent ? ' (вместо ' + r.absent + ')' : ''}`);
    return show(lines.length ? 'Замены на сегодня:\n' + lines.join('\n') : 'На сегодня замен нет.', { inline_keyboard: [[back]] });
  }
  return answer('');
}

// ---- уведомления IT-администратору (с привязанным Telegram) ----
// Уведомления об экранах получает только IT-администратор. Экран считается сломанным, если нет связи 15 минут:
// короткие пропадания (перезагрузка, сеть) не тревожат никого.
const ALERT_ROLES = ['it'];
const OFFLINE_AFTER = 15 * 60e3;
function alertRecipients() {
  return db.prepare(`SELECT tg_id FROM users WHERE tg_id IS NOT NULL AND active=1 AND role IN (${ALERT_ROLES.map(() => '?').join(',')})`).all(...ALERT_ROLES).map(r => r.tg_id);
}
async function notify(text) {
  for (const id of alertRecipients()) await say(id, text).catch(e => console.error('[tg] уведомление:', e.message));
}
const hhmm = t => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
function alertSet(key) { db.prepare('INSERT OR REPLACE INTO tg_alerts(key,at) VALUES(?,?)').run(key, Date.now()); }
function alertHas(key) { return !!db.prepare('SELECT 1 FROM tg_alerts WHERE key=?').get(key); }
function alertClear(key) { db.prepare('DELETE FROM tg_alerts WHERE key=?').run(key); }

// проверяет экраны и сообщает, когда экран отключился или снова на связи
async function checkScreens() {
  const now = Date.now();
  const screens = db.prepare('SELECT id, name, last_seen FROM screens WHERE token_hash IS NOT NULL').all();
  for (const s of screens) {
    const title = s.name || s.id.slice(0, 6);
    const key = 'screen_off:' + s.id;
    const offline = now - s.last_seen > OFFLINE_AFTER;
    if (offline && !alertHas(key)) {
      alertSet(key);
      await notify(`⚠️ Экран «${title}» не выходит на связь с ${hhmm(s.last_seen)}.`);
    } else if (!offline && alertHas(key)) {
      alertClear(key);
      await notify(`✅ Экран «${title}» снова на связи.`);
    }
  }
}

// ---- добавление замены по шагам: дата → классы → урок → кабинет и учитель ----
const flows = new Map();                       // Telegram-пользователь → {step, data, at}
const FLOW_TTL = 15 * 60e3;
const getFlow = from => { const f = flows.get(from); if (f && Date.now() - f.at < FLOW_TTL) return f; flows.delete(from); return null; };
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isSun = iso => new Date(iso + 'T12:00:00Z').getUTCDay() === 0;
const ddmm = iso => iso.slice(8) + '.' + iso.slice(5, 7);
const WD3 = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const classList = () => db.prepare('SELECT DISTINCT cls FROM lessons').all().map(r => r.cls)
  .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b, 'ru'));
const cancelBtn = { text: '✖ Отмена', callback_data: 'sa:no' };

// «205, Петрова» → кабинет и учитель; «отменён» → урок отменён; «Петрова, математика, 205» → учитель, предмет, кабинет
function parseSubText(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^отмен/i.test(t)) return { subject: 'отменён', room: '', teacher: '' };
  const parts = t.split(/[,;]/).map(x => x.trim()).filter(Boolean);
  const isRoom = x => /^\d{1,4}[а-яa-z]?(\s*\/\s*\d{1,4})?$/i.test(x) || /^(сз|спортзал|спортивный зал)$/i.test(x);
  const room = parts.filter(isRoom).join('/').replace(/\s/g, '');
  const rest = parts.filter(x => !isRoom(x));
  const out = { room, teacher: rest[0] || '', subject: rest.slice(1).join(', ') };
  return out.room || out.teacher || out.subject ? out : null;
}
const subSummary = d => `Замена на ${ddmm(d.date)}\nКлассы: ${d.classes.join(', ')}\nУрок: ${d.lessons}\n${[d.subject && 'Предмет: ' + d.subject, d.room && 'Кабинет: ' + d.room, d.teacher && 'Учитель: ' + d.teacher].filter(Boolean).join('\n')}`;

function classKeyboard(sel) {
  const list = classList(), rows = [];
  for (let i = 0; i < list.length; i += 4) rows.push(list.slice(i, i + 4).map(c => ({ text: (sel.includes(c) ? '✓ ' : '') + c, callback_data: 'sa:c:' + c })));
  rows.push([{ text: '✅ Готово' + (sel.length ? ` (${sel.length})` : ''), callback_data: 'sa:cd' }, cancelBtn]);
  return { inline_keyboard: rows };
}

async function onFlowCallback(cq) {
  const data = String(cq.data || ''), from = String(cq.from.id), chat = cq.message.chat.id, mid = cq.message.message_id;
  const answer = text => call('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
  const show = (text, markup) => edit(chat, mid, text, markup);
  const u = userByTg(from);
  if (!u) return answer('Telegram не привязан');
  if (data.startsWith('mp:')) return onMediaCallback(cq, u, answer, show);
  if (!SUBS_ROLES.includes(u.role)) return answer('Нет прав');
  await answer('');

  if (data === 'sa:start') {
    const today = todayMsk();
    let next = addDays(today, 1); if (isSun(next)) next = addDays(next, 1);
    const days = [today, next].filter(d => !isSun(d));
    flows.set(from, { step: 'date', at: Date.now(), data: { classes: [] } });
    return show('На какую дату замена?', { inline_keyboard: [days.map(d => ({ text: `${d === today ? 'Сегодня' : WD3[new Date(d + 'T12:00:00Z').getUTCDay()]} ${ddmm(d)}`, callback_data: 'sa:d:' + d })), [cancelBtn]] });
  }
  if (data === 'sa:no') { flows.delete(from); return show(`Меню, «${u.name}». Выберите действие.`, menuKeyboard(u.role)); }
  const f = getFlow(from);
  if (!f) return show('Время вышло, начнём заново.', { inline_keyboard: [[{ text: '➕ Добавить замену', callback_data: 'sa:start' }]] });
  f.at = Date.now();

  if (data.startsWith('sa:d:')) {
    const d = data.slice(5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isSun(d)) return show('Воскресенье — выходной. Выберите другую дату.', { inline_keyboard: [[cancelBtn]] });
    f.data.date = d; f.step = 'cls';
    if (!classList().length) return show('Расписание ещё не загружено, классов нет. Загрузите его в админке.', { inline_keyboard: [[cancelBtn]] });
    return show(`Замена на ${ddmm(d)}. Выберите классы (можно несколько) и нажмите «Готово».`, classKeyboard(f.data.classes));
  }
  if (data.startsWith('sa:c:')) {
    const c = data.slice(5), sel = f.data.classes, i = sel.indexOf(c);
    if (i >= 0) sel.splice(i, 1); else if (classList().includes(c)) sel.push(c);
    return show(`Замена на ${ddmm(f.data.date)}. Выберите классы (можно несколько) и нажмите «Готово».`, classKeyboard(sel));
  }
  if (data === 'sa:cd') {
    if (!f.data.classes.length) return show('Выберите хотя бы один класс.', classKeyboard(f.data.classes));
    f.step = 'lesson';
    const nums = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ text: String(n), callback_data: 'sa:l:' + n }));
    return show(`Классы: ${f.data.classes.join(', ')}. Какой урок?`, { inline_keyboard: [nums.slice(0, 4), nums.slice(4), [cancelBtn]] });
  }
  if (data.startsWith('sa:l:')) {
    const n = Number(data.slice(5));
    if (!(n >= 1 && n <= 12)) return;
    f.data.lessons = String(n); f.step = 'text';
    return show(`${f.data.classes.join(', ')}, ${n} урок.\n\nНапишите одним сообщением кабинет и учителя, например:\n205, Петрова\nЕсли урока не будет — напишите «отменён».`, { inline_keyboard: [[cancelBtn]] });
  }
  if (data === 'sa:ok') {
    if (f.step !== 'confirm') return;
    const d = f.data;
    try {
      SC.addSubs({ date: d.date, lessons: d.lessons, classes: d.classes.join(', '), subject: d.subject, room: d.room, teacher: d.teacher }, u, 'telegram');
      flows.delete(from);
      return show('✅ Замена добавлена, экраны покажут её в течение 15 секунд.\n\n' + subSummary(d), { inline_keyboard: [[{ text: '➕ Ещё одну', callback_data: 'sa:start' }]] });
    } catch (e) { return show('Не получилось: ' + e.message, { inline_keyboard: [[cancelBtn]] }); }
  }
}

// текст в ответ на шаг «кабинет и учитель»; возвращает true, если сообщение обработано
async function onFlowText(msg) {
  const from = String(msg.from.id), f = getFlow(from);
  if (!f || f.step !== 'text') return false;
  const u = userByTg(from);
  if (!u || !SUBS_ROLES.includes(u.role)) return false;
  const p = parseSubText(msg.text);
  if (!p) { await say(msg.chat.id, 'Не понял. Напишите кабинет и учителя через запятую, например: 205, Петрова. Или «отменён».'); return true; }
  Object.assign(f.data, p); f.step = 'confirm'; f.at = Date.now();
  await say(msg.chat.id, subSummary(f.data) + '\n\nДобавить?', { reply_markup: { inline_keyboard: [[{ text: '✅ Добавить', callback_data: 'sa:ok' }, cancelBtn]] } });
  return true;
}

// ---- фото → постер на экране (помощник публикует сам, завуч может убрать одной кнопкой) ----
async function fetchFile(file_path) {
  if (state.fileFetcher) return state.fileFetcher(file_path);
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file_path}`, { signal: AbortSignal.timeout(40e3) });
  if (!r.ok) throw new Error('Не удалось скачать файл из Telegram');
  return Buffer.from(await r.arrayBuffer());
}
const PLACE_RU = { screen: 'на весь экран', center: 'в центре экрана', banner: 'баннером с QR' };
const mediaKb = (id, place) => ({ inline_keyboard: [[
  ...(place === 'screen' ? [{ text: 'В центр экрана', callback_data: `mp:pl:${id}:center` }] : [{ text: 'На весь экран', callback_data: `mp:pl:${id}:screen` }]),
  { text: '🗑 Убрать', callback_data: 'mp:del:' + id }]] });

async function onMedia(msg) {
  const chat = msg.chat.id, u = userByTg(String(msg.from.id));
  if (!u) return say(chat, 'Сначала привяжите Telegram в админке: кнопка «Telegram» у вашей учётной записи.');
  if (!MEDIA_ROLES.includes(u.role)) return say(chat, 'У вашей роли нет права добавлять постеры.');
  let fileId, name = '';
  if (msg.photo && msg.photo.length) fileId = msg.photo[msg.photo.length - 1].file_id;
  else if (msg.document && /^image\/(jpeg|png)$/.test(msg.document.mime_type || '')) { fileId = msg.document.file_id; name = msg.document.file_name || ''; }
  else return say(chat, 'Пришлите картинку: фото или файл JPG/PNG.');
  try {
    const info = await call('getFile', { file_id: fileId });
    const buf = await fetchFile(info.file_path);
    const title = String(msg.caption || '').trim().slice(0, 120) || name.replace(/\.[^.]+$/, '') || 'Фото из Telegram ' + ddmm(todayMsk());
    const row = await M.saveMedia({ buf, title, place: 'screen', user: u, source: 'telegram' });
    return say(chat, `✅ «${row.title}» уже на экране ${PLACE_RU[row.place]}, ${row.duration} с. Если не то, уберите кнопкой ниже.`, { reply_markup: mediaKb(row.id, row.place) });
  } catch (e) {
    return say(chat, e instanceof M.MediaError ? e.message : 'Не получилось сохранить файл. Попробуйте ещё раз или загрузите в админке.');
  }
}

async function onMediaCallback(cq, u, answer, show) {
  const [, act, id, place] = String(cq.data).split(':');
  const row = db.prepare('SELECT * FROM media WHERE id=?').get(Number(id));
  if (!row) { await answer('Уже убрано'); return show('Этот постер уже убран.', undefined); }
  // помощник трогает только свои файлы; директор, завуч и IT — любые
  if (u.role === 'helper' && row.created_by !== u.name) return answer('Нет прав');
  if (!MEDIA_ROLES.includes(u.role)) return answer('Нет прав');
  await answer('');
  if (act === 'del') { M.deleteMedia(row.id, u, 'telegram'); return show(`🗑 «${row.title}» убран с экранов.`, undefined); }
  if (act === 'pl' && M.PLACES.includes(place)) {
    db.prepare('UPDATE media SET place=? WHERE id=?').run(place, row.id);
    audit({ source: 'telegram', user: u, action: 'media_updated', target: row.title, details: 'place' });
    S.bump();
    return show(`✅ «${row.title}» теперь ${PLACE_RU[place]}.`, mediaKb(row.id, place));
  }
}

// ---- напоминания ----
// тревога висит давно → директор и завуч; нет замен на завтра → завуч; скоро истекает постер или объявление → завуч и помощник
const URGENT_LONG_MS = 30 * 60e3;
const recipientsOf = roles => db.prepare(`SELECT tg_id FROM users WHERE tg_id IS NOT NULL AND active=1 AND role IN (${roles.map(() => '?').join(',')})`).all(...roles).map(r => r.tg_id);
async function sendTo(roles, text, extra) { for (const id of recipientsOf(roles)) await say(id, text, extra).catch(e => console.error('[tg] напоминание:', e.message)); }
async function once(key, roles, text, extra) { if (alertHas(key)) return; alertSet(key); await sendTo(roles, text, extra); }

async function checkReminders(now = Date.now()) {
  const msk = new Date(now + 3 * 3600e3), hour = msk.getUTCHours(), today = msk.toISOString().slice(0, 10), tomorrow = addDays(today, 1);
  db.prepare("DELETE FROM tg_alerts WHERE at < ? AND key NOT LIKE 'screen_off:%'").run(now - 14 * 864e5);
  const st = URG.status();
  if (st.active && st.since && now - st.since > URGENT_LONG_MS)
    await once('urgent_long:' + st.since, URGENT_ROLES, `⏰ «${st.title}» висит на экранах уже ${Math.round((now - st.since) / 60e3)} мин. Если опасность прошла, отправьте отбой.`, { reply_markup: { inline_keyboard: [[{ text: '⏹ Отбой', callback_data: 'm:stop' }]] } });
  if (hour < 9 || hour >= 20) return; // ночью и рано утром не беспокоим
  if (hour >= 16 && !isSun(tomorrow) && db.prepare('SELECT 1 FROM lessons LIMIT 1').get() && !db.prepare('SELECT 1 FROM subs WHERE date=? LIMIT 1').get(tomorrow)) {
    const hf = getSetting('holiday_from'), ht = getSetting('holiday_to');
    if (!(hf && ht && hf <= tomorrow && tomorrow <= ht))
      await once('subs_tomorrow:' + tomorrow, ['zavuch'], `📋 На завтра (${ddmm(tomorrow)}) замен пока нет. Если они будут, добавьте их, и экраны покажут замены с утра.`, { reply_markup: { inline_keyboard: [[{ text: '➕ Добавить замену', callback_data: 'sa:start' }]] } });
  }
  for (const r of db.prepare('SELECT id, title FROM media WHERE active=1 AND date_to=?').all(tomorrow))
    await once(`exp_m:${r.id}:${tomorrow}`, ['zavuch', 'helper'], `📅 Постер «${r.title}» завтра перестанет показываться на экранах. Нужно дольше — продлите дату «Показывать по» в админке.`);
  for (const r of db.prepare('SELECT id, title FROM announcements WHERE active=1 AND date_to=?').all(tomorrow))
    await once(`exp_a:${r.id}:${tomorrow}`, ['zavuch', 'helper'], `📅 Объявление «${r.title.slice(0, 80)}» завтра перестанет показываться. Нужно дольше — продлите в админке.`);
}

// ---- цикл получения обновлений ----
let offset = 0;
async function loop() {
  while (state.running) {
    try {
      const ups = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const up of ups) {
        offset = up.update_id + 1;
        try {
          const m = up.message;
          if (m && m.text && m.text.startsWith('/start')) await onStart(m);
          else if (m && m.text && m.text.startsWith('/unlink')) await onUnlink(m);
          else if (m && m.text && m.text.startsWith('/menu')) { const u = userByTg(String(m.from.id)); if (u) await showMenu(m.chat.id, u); else await say(m.chat.id, 'Сначала привяжите Telegram в админке.'); }
          else if (m && m.text && m.text.startsWith('/cancel')) { flows.delete(String(m.from.id)); await say(m.chat.id, 'Отменено.'); }
          else if (m && (m.photo || m.document)) await onMedia(m);
          else if (m && m.text && !m.text.startsWith('/')) await onFlowText(m);
          else if (up.callback_query) await onCallback(up.callback_query);
        } catch (e) { console.error('[tg] обработка:', e.message); }
      }
    } catch (e) {
      console.error('[tg] связь с Telegram:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function start() {
  if (!state.enabled || state.running) return;
  const me = await call('getMe', {});
  state.username = me.username;
  state.running = true;
  loop();
  setInterval(() => checkScreens().catch(e => console.error('[tg] экраны:', e.message)), 60e3);
  setInterval(() => checkReminders().catch(e => console.error('[tg] напоминания:', e.message)), 60e3);
  console.log(`[tg] бот @${me.username} запущен`);
}

module.exports = { state, start, newCode, findCode, dropCode, userByTg, linkUrl, loginUrl, sha,
  onStart, onUnlink, onCallback, onMenuCallback, checkScreens, checkReminders, onFlowText, onMedia, parseSubText, setSender: (f, files) => { state.sender = f; state.fileFetcher = files || null; } };
