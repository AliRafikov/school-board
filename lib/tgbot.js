// Telegram-бот: привязка аккаунта сотрудника и подтверждение входа на сайт.
// Без внешних пакетов: long polling через fetch. Работает только если задан TG_BOT_TOKEN;
// без токена всё остаётся как раньше (вход по паролю).
const crypto = require('crypto');
const { db, audit } = require('./db');
const URG = require('./urgent');

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
  if (/^(m:|u:|uy:|sy$)/.test(String(cq.data || ''))) return onMenuCallback(cq);
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
const todayMsk = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

function menuKeyboard(role) {
  const rows = [];
  if (URGENT_ROLES.includes(role)) rows.push([{ text: '🚨 Срочное сообщение', callback_data: 'm:urg' }]);
  if (VIEW_ROLES.includes(role)) rows.push([{ text: '📺 Экраны', callback_data: 'm:scr' }, { text: '📋 Замены сегодня', callback_data: 'm:sub' }]);
  if (URGENT_ROLES.includes(role) && URG.status().active) rows.push([{ text: '⏹ Отбой', callback_data: 'm:stop' }]);
  return { inline_keyboard: rows };
}
async function showMenu(chat, u) {
  const st = URG.status();
  const head = st.active ? `⚠️ Сейчас на экранах: «${st.title}».\n\n` : '';
  return say(chat, `${head}Меню, «${u.name}». Выберите действие.`, { reply_markup: menuKeyboard(u.role) });
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
  console.log(`[tg] бот @${me.username} запущен`);
}

module.exports = { state, start, newCode, findCode, dropCode, userByTg, linkUrl, loginUrl, sha,
  onStart, onUnlink, onCallback, onMenuCallback, checkScreens, setSender: f => { state.sender = f; } };
