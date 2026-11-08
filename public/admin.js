// Админка: одностраничное приложение без зависимостей.
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDT = t => t ? new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const ago = t => { if (!t) return 'никогда'; const s = Math.round((Date.now() - t) / 1000); if (s < 60) return 'только что'; if (s < 3600) return Math.floor(s / 60) + ' мин назад'; if (s < 86400) return Math.floor(s / 3600) + ' ч назад'; return fmtDT(t); };

let me = null, view = 'overview', sub = '', brand = { logo: '', school: '' };

// тема админки: по умолчанию как в системе; выбор запоминается в этом браузере
const THEMES = [['light', 'Светлая'], ['dark', 'Тёмная'], ['auto', 'Системная']];
const getTheme = () => { try { return localStorage.getItem('sbAdminTheme') || 'auto'; } catch { return 'auto'; } };
function setTheme(t) {
  try { localStorage.setItem('sbAdminTheme', t); } catch { /* режим без хранилища */ }
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
}
setTheme(getTheme());

// значки разделов (в одном стиле, цвет берётся от текста)
const svgIc = d => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  urgent: svgIc('<path d="M12 3.2 2.6 19.8h18.8L12 3.2z"/><path d="M12 9.6v4.6M12 17.2v.01"/>'),
  overview: svgIc('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  schedule: svgIc('<rect x="3" y="4" width="18" height="17" rx="2.5"/><path d="M3 9.5h18M8 2.5v3M16 2.5v3"/>'),
  calls: svgIc('<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  subs: svgIc('<path d="M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8"/>'),
  ann: svgIc('<path d="M4 10v4a1 1 0 0 0 1 1h2l5 4V5L7 9H5a1 1 0 0 0-1 1z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>'),
  look: svgIc('<path d="M12 2.5a9.5 9.5 0 0 0 0 19c1.2 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6h1.9a4.7 4.7 0 0 0 4.7-4.7C21.5 6 17.4 2.5 12 2.5z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7.5" r="1.2"/><circle cx="15" cy="8" r="1.2"/>'),
  system: svgIc('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/>'),
};

async function api(method, path, body, headers = {}) {
  const h = { 'X-Requested-With': 'sb', ...headers };
  let payload;
  if (body instanceof Blob) payload = body; else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(path, { method, headers: h, body: payload, credentials: 'same-origin' });
  let j = null; try { j = await r.json(); } catch { /* пустой ответ */ }
  if (r.status === 401 && path !== '/api/auth/login') { me = null; render(); throw new Error('Нужно войти'); }
  if (!r.ok) throw Object.assign(new Error((j && j.error) || 'Ошибка ' + r.status), { status: r.status });
  return j;
}
// дата + n дней (ГГГГ-ММ-ДД)
const addDaysIso = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Подсветка несохранённых правок: у строки или карточки появляется класс dirty, а кнопка «Сохранить» меняет подпись.
// Так не получится уйти со страницы и потерять изменения, не заметив, что они не сохранены.
function markDirty(root, itemSel, btnSel) {
  const on = e => {
    if (!e.target.matches('input, select, textarea')) return;
    const it = e.target.closest(itemSel); if (!it) return;
    it.classList.add('dirty');
    const b = it.querySelector(btnSel); if (b) b.textContent = 'Сохранить изменения';
  };
  root.addEventListener('input', on); root.addEventListener('change', on);
}
const clearDirty = (it, btnSel) => { it.classList.remove('dirty'); const b = it.querySelector(btnSel); if (b) b.textContent = 'Сохранить'; };
const msg = (el, text, kind = 'err') => { el.innerHTML = text ? `<div class="msg ${kind}" role="${kind === 'err' ? 'alert' : 'status'}">${esc(text)}</div>` : ''; };

const ACTIONS = {
  screen_paired: 'Экран привязан', screen_unpaired: 'Экран отвязан',
  login: 'Вход', login_tg: 'Вход через Telegram', tg_linked: 'Telegram привязан', tg_unlinked: 'Telegram отвязан', tg_link_created: 'Создана ссылка для Telegram', login_failed: 'Неудачный вход', logout: 'Выход', logout_all: 'Выход на всех устройствах', password_changed: 'Смена пароля', password_reset: 'Сброс пароля',
  user_created: 'Создан пользователь', user_role_changed: 'Изменена роль', user_renamed: 'Изменено имя', user_enabled: 'Пользователь включён', user_disabled: 'Пользователь отключён',
  settings_changed: 'Изменена настройка', media_uploaded: 'Загружен файл', media_updated: 'Изменён файл', media_deleted: 'Удалён файл', media_reordered: 'Изменён порядок файлов',
  sync_manual: 'Ручная синхронизация', screens_refresh: 'Обновление всех экранов', screen_renamed: 'Переименован экран', first_user: 'Создан первый пользователь',
  lesson_changed: 'Изменён урок', lesson_added: 'Добавлен урок', lesson_removed: 'Убран урок', bell_changed: 'Изменён звонок',
  urgent_started: 'Срочное сообщение', urgent_stopped: 'Отбой отправлен на экраны', clear_hidden: 'Отбой убран с экранов', shift_started: 'Сдвиг звонков', shift_reset: 'Сдвиг звонков снят', substitution_added: 'Новая замена', bell_exception_added: 'Звонки на даты', bell_exception_removed: 'Звонки на даты: убрано', substitution_removed: 'Замена убрана', schedule_imported: 'Загружен файл расписания',
  announcement_added: 'Новое объявление', announcement_changed: 'Изменено объявление', announcement_removed: 'Удалено объявление'
};
const FIELD_LABELS = { title: 'название', duration: 'длительность', priority: 'приоритет', date_from: 'дата «с»', date_to: 'дата «по»', break_only: 'только на переменах', active: 'включён', place: 'место показа' };
const detailsRu = r => r.action === 'media_updated' ? 'изменено: ' + String(r.details).split(', ').map(k => FIELD_LABELS[k] || k).join(', ') : r.details;
const SETTING_LABELS = { tz: 'Часовой пояс', change_ttl_hours: 'Сколько часов подсвечивать изменения', board_seconds: 'Секунд на экране с расписанием', school_name: 'Название школы', display_mode: 'Режим экрана' };

// ---------- Telegram: вход и привязка ----------
// Вход: сайт создаёт код, сотрудник подтверждает в боте, страница ждёт ответа и входит
async function tgLogin(box) {
  box.innerHTML = '<p class="muted small" style="text-align:center">Открываем Telegram…</p>';
  try {
    const r = await api('POST', '/api/auth/tg/start', {});
    box.innerHTML = `<p class="small" style="text-align:center;margin:6px 0">Откройте бот и нажмите «Да, это я».</p>
      <a class="btn primary" style="width:100%;text-align:center;display:block" href="${esc(r.link)}" target="_blank" rel="noopener">Открыть Telegram</a>
      <p class="muted small" style="text-align:center">Ссылка действует 2 минуты.</p>`;
    const until = Date.now() + r.expires_in * 1000;
    const timer = setInterval(async () => {
      if (Date.now() > until) { clearInterval(timer); box.innerHTML = '<p class="small" style="text-align:center">Время вышло. Попробуйте ещё раз.</p>'; return; }
      try {
        const s = await api('GET', '/api/auth/tg/status?code=' + encodeURIComponent(r.code));
        if (s.status === 'ok') { clearInterval(timer); await boot(); }
        else if (s.status === 'denied') { clearInterval(timer); box.innerHTML = '<p class="small" style="text-align:center">Вход отменён в боте.</p>'; }
        else if (s.status === 'expired') { clearInterval(timer); box.innerHTML = '<p class="small" style="text-align:center">Код устарел. Попробуйте ещё раз.</p>'; }
      } catch (er) { clearInterval(timer); msg(box, er.message); }
    }, 2000);
  } catch (er) { msg(box, er.message); }
}
// кнопка «Войти через Telegram» показывается, только если бот запущен на сервере
function loadTgLogin() {
  api('GET', '/api/auth/tg/config').then(c => {
    const box = document.getElementById('tgbox');
    if (!c.enabled || !box) return;
    box.innerHTML = '<div class="muted small" style="text-align:center;margin:10px 0 6px">или</div><button type="button" class="btn" id="tgbtn" style="width:100%">Войти через Telegram</button><div id="tgmsg" style="margin-top:8px"></div>';
    document.getElementById('tgbtn').onclick = () => tgLogin(document.getElementById('tgmsg'));
  }).catch(() => { /* бот недоступен: остаётся вход по паролю */ });
}
// ссылка привязки: открывается в Telegram на телефоне сотрудника
function tgLinkMsg(el, link) {
  el.innerHTML = `<div class="msg ok" role="status">Откройте ссылку в Telegram на телефоне этого сотрудника. Она действует 10 минут:<br><a href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a></div>`;
}
// блок в профиле: привязать или отвязать свой Telegram
function wireTg(el, linked, id) {
  el.innerHTML = `<div><h2>Вход через Telegram</h2><p class="muted small" style="margin:4px 0 10px">${linked
    ? 'Telegram привязан. Вход на сайт можно подтверждать в боте. Пароль тоже остаётся.'
    : 'Необязательно. Если привязать Telegram, вход на сайт можно подтверждать в боте. Пароль при этом остаётся.'}</p></div>
    <button class="btn sm ${linked ? 'danger' : 'primary'}" type="button" id="tgAct">${linked ? 'Отвязать Telegram' : 'Привязать Telegram'}</button><div id="tgMsg" style="margin-top:10px"></div>`;
  const out = el.querySelector('#tgMsg');
  el.querySelector('#tgAct').onclick = async () => {
    try {
      if (linked) { await api('POST', `/api/admin/users/${id}/tg-unlink`, {}); }
      else { const r = await api('POST', `/api/admin/users/${id}/tg-link`, {}); tgLinkMsg(out, r.link); return; }
      me = await api('GET', '/api/auth/me'); render();
    } catch (er) { msg(out, er.message); }
  };
}

// ---------- экран входа ----------
function renderLogin() {
  $app.innerHTML = `<div class="login"><form class="login-card" id="lf">
    <div class="logo-row">${brand.logo ? `<img src="${esc(brand.logo)}" alt="">` : ''}<h1>${esc(brand.school || 'Информационная панель')}</h1></div>
    <p class="muted" style="margin:0">Вход для сотрудников</p>
    <label class="f">Логин<input type="text" id="lg" autocomplete="username" autocapitalize="none" required autofocus></label>
    <label class="f">Пароль<input type="password" id="pw" autocomplete="current-password" required></label>
    <div id="lm"></div>
    <button class="btn primary" type="submit">Войти</button>
    <div id="tgbox"></div></form></div>`;
  loadTgLogin();
  document.getElementById('lf').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); btn.disabled = true;
    try { await api('POST', '/api/auth/login', { login: document.getElementById('lg').value.trim(), password: document.getElementById('pw').value }); await boot(); }
    catch (err) { msg(document.getElementById('lm'), err.message); btn.disabled = false; }
  };
}

// ---------- смена пароля ----------
function renderPasswordForm(forced) {
  const form = `<form class="card" id="pf" style="max-width:420px;display:grid;gap:12px">
    ${forced ? '<div class="msg warn">Для безопасности замените временный пароль на свой.</div>' : ''}
    <label class="f">Текущий пароль<input type="password" id="p0" autocomplete="current-password" required></label>
    <label class="f">Новый пароль (от 8 символов, буквы и цифры)<input type="password" id="p1" autocomplete="new-password" required minlength="8"></label>
    <label class="f">Новый пароль ещё раз<input type="password" id="p2" autocomplete="new-password" required></label>
    <div id="pm"></div><button class="btn primary" type="submit">Сохранить пароль</button></form>`;
  const wire = () => {
    document.getElementById('pf').onsubmit = async e => {
      e.preventDefault(); const m = document.getElementById('pm');
      const a = document.getElementById('p1').value;
      if (a !== document.getElementById('p2').value) return msg(m, 'Пароли не совпадают');
      try { await api('POST', '/api/auth/password', { old: document.getElementById('p0').value, new: a }); me.must_change = false; msg(m, 'Пароль сохранён', 'ok'); if (forced) setTimeout(boot, 600); }
      catch (err) { msg(m, err.message); }
    };
  };
  return { form, wire };
}

// ---------- каркас ----------
// Порядок — по частоте работы: замены и срочное чаще всего, расписание и система реже.
// «Звонки» живут внутри «Расписания», «Оформление» — внутри «Системы».
const NAV = [['overview', 'Обзор', () => true], ['subs', 'Замены', m => m.can.subs], ['urgent', 'Срочное', m => m.can.urgent],
  ['ann', 'Объявления', m => m.can.announcements || m.can.media], ['schedule', 'Расписание', m => m.can.schedule], ['system', 'Система', () => true]];
// разделы внутри «Система»: видны по правам роли
const SYS = [['screens', 'Экраны', m => m.can.screens, () => viewScreens()], ['users', 'Пользователи', m => m.can.users, () => viewUsers()],
  ['look', 'Оформление', m => m.can.settings, () => viewLook()], ['settings', 'Настройки', m => m.can.settings, () => viewSettings()],
  ['audit', 'Журнал', m => m.can.audit, () => viewAudit()],
  ['help', 'Справка', () => true, () => viewHelp()], ['profile', 'Мой профиль', () => true, () => viewProfile()]];
const sysAllowed = () => SYS.filter(s => s[2](me));

// меню профиля: одно на всё приложение, закрывается по клику вне его
function setMeMenu(open) {
  const menu = document.getElementById('meMenu'), btn = document.getElementById('meBtn');
  if (!menu || !btn) return;
  menu.hidden = !open; btn.setAttribute('aria-expanded', String(open));
}
document.addEventListener('click', e => { if (!e.target.closest('#meBox')) setMeMenu(false); });

function systemTabs() {
  return `<nav class="chips" aria-label="Разделы системы">${sysAllowed().map(s => `<a class="chip" href="#system/${s[0]}" ${s[0] === sub ? 'aria-current="page"' : ''}>${s[1]}</a>`).join('')}</nav>`;
}

// вкладки внутри «Расписания»: постоянное расписание и звонки
function scheduleTabs() {
  return `<nav class="chips" aria-label="Разделы расписания">${[['', 'Расписание'], ['calls', 'Звонки']].map(([k, l]) => `<a class="chip" href="#schedule${k ? '/' + k : ''}" ${k === sub ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>`;
}

function shell(title, bodyHtml, actionsHtml = '') {
  const sysNav = view === 'system' ? systemTabs() : view === 'schedule' ? scheduleTabs() : '';
  $app.innerHTML = `<div class="shell"><aside class="side">
    <div class="logo-row">${brand.logo ? `<img src="${esc(brand.logo)}" alt="">` : ''}<span>${esc(brand.school)}</span></div>
    <nav class="nav" aria-label="Разделы">${NAV.filter(n => n[2](me)).map(n => `<a href="#${n[0]}" ${n[0] === view ? 'aria-current="page"' : ''}>${ICONS[n[0]] || ''}<span>${n[1]}</span></a>`).join('')}</nav>
    <div class="me" id="meBox">
      <button class="me-btn" id="meBtn" type="button" aria-haspopup="menu" aria-expanded="false">
        <span><b>${esc(me.name)}</b><span class="muted small">${esc(me.role_label)}</span></span><span class="me-caret" aria-hidden="true">▴</span></button>
      <div class="me-menu" id="meMenu" role="menu" hidden>
        <a role="menuitem" href="#system/profile">Мой профиль и пароль</a>
        <div class="seg-label" id="themeLbl">Тема</div>
        <div class="seg" role="group" aria-labelledby="themeLbl">${THEMES.map(([v, l]) => `<button type="button" data-theme-set="${v}" aria-pressed="${getTheme() === v}">${l}</button>`).join('')}</div>
        <button role="menuitem" type="button" id="lo">Выйти</button>
      </div>
    </div>
  </aside><main class="main"><header><h1>${esc(title)}</h1><div class="row">${actionsHtml}</div></header><div id="view">${sysNav}${bodyHtml}</div></main></div>`;
  const menu = document.getElementById('meMenu'), btn = document.getElementById('meBtn');
  btn.onclick = e => { e.stopPropagation(); setMeMenu(menu.hidden); };
  menu.querySelectorAll('[data-theme-set]').forEach(b => b.onclick = () => {
    setTheme(b.dataset.themeSet);
    menu.querySelectorAll('[data-theme-set]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  document.getElementById('lo').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch {} me = null; render(); };
}

// ---------- обзор ----------
async function viewOverview() {
  const o = await api('GET', '/api/admin/overview');
  const s = o.sync, st = o.status;
  const t2 = ts => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const canAnn = me.can.urgent; // включать и снимать срочное сообщение может не каждая роль (помощнику нельзя)
  const offline = st.screens_offline.filter(x => x.id);
  // тему экрана видят и меняют директор, IT и завуч (её значение приходит вместе с обзором)
  const scfg = me.can.screens ? true : null;
  const stheme = scfg ? (o.screen_theme || 'auto') : null;
  const plural = n => (n % 10 === 1 && n % 100 !== 11) ? 'экран' : ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) ? 'экрана' : 'экранов';
  // главная плашка: тревога, отбой или спокойно. Одна кнопка по делу, без пунктов «нет»
  const hero = st.urgent
    ? `<section class="hero hero-alarm"><div><h2 class="hero-t">${esc(st.urgent.title)}</h2><p class="hero-s">${st.urgent.source ? esc(st.urgent.source) + ' · ' : ''}с ${t2(st.urgent.since)}</p></div>${canAnn ? '<button class="btn hero-btn" id="oAlarmOff" type="button">Отправить отбой</button>' : ''}</section>`
    : st.clear
      ? `<section class="hero hero-ok"><div><h2 class="hero-t">Отбой на экранах</h2><p class="hero-s">Зелёная плашка до ${t2(st.clear.until)}</p></div>${canAnn ? '<button class="btn hero-btn" id="oClearHide" type="button">Скрыть отбой</button>' : ''}</section>`
      : `<section class="hero"><div><h2 class="hero-t">Всё в порядке</h2><p class="hero-s">Экраны показывают расписание</p></div>${canAnn ? '<a class="btn primary" href="#urgent">Срочное сообщение</a>' : ''}</section>`;
  // что сейчас меняет расписание: показываем только то, что действует
  const live = [];
  if (st.shift) live.push(`<a class="live-i" href="${me.can.schedule ? '#schedule/calls' : '#overview'}"><span>Сдвиг звонков</span><b>на ${st.shift.minutes} мин с ${st.shift.from} урока</b></a>`);
  if (st.subs_today) live.push(`<a class="live-i" href="${me.can.subs ? '#subs' : '#overview'}"><span>Замены на сегодня</span><b>${st.subs_today}</b></a>`);
  if (offline.length) {
    const named = offline.filter(x => x.name).map(x => x.name);
    const txt = named.length === offline.length ? named.join(', ') : `${offline.length} ${plural(offline.length)}`;
    live.push(`<a class="live-i live-bad" href="#system/screens"><span>Не на связи</span><b>${esc(txt)}</b></a>`);
  }
  const status = `${hero}${live.length ? `<div class="live">${live.join('')}</div>` : ''}`;
  const attention = [];
  if (o.counts.lessons === 0 && me.can.schedule) attention.push('Расписание ещё не загружено. Откройте раздел «Расписание» и загрузите файл Excel.');
  if (st.urgent && st.urgent.since && Date.now() - st.urgent.since > 2 * 3600e3 && canAnn) attention.push(`Срочное сообщение висит уже больше двух часов. Проверьте, актуально ли оно.`);
  shell('Обзор', `
    ${attention.map(a => `<div class="msg warn" style="margin-bottom:12px">${esc(a)}</div>`).join('')}
    ${status}
    <div class="grid">
      <div class="stat"><div class="v">${o.counts.screens} <span class="muted small">из ${o.counts.screens_total}</span></div><div class="l">экранов на связи</div></div>
      <div class="stat"><div class="v">${st.subs_today}</div><div class="l">замен на сегодня</div></div>
      <div class="stat"><div class="v">${o.counts.media}</div><div class="l">постеров и видео в показе</div></div>
    </div>
    ${scfg ? `<div class="card screen-theme"><div><h2>Тема экрана</h2><p class="muted small" style="margin:4px 0 0">«Авто» — светлая днём, ночью чёрная с временем и логотипом</p></div>
      <div class="seg seg-wide" id="sTheme">${[['auto', 'Авто'], ['light', 'Светлая'], ['dark', 'Тёмная']].map(([v, l]) => `<button type="button" data-st="${v}" aria-pressed="${stheme === v}">${l}</button>`).join('')}</div></div>` : ''}
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center;margin-bottom:14px"><div><h2 style="margin:0">Так видит экран</h2><p class="muted small" style="margin:4px 0 0">Копия телевизора, обновляется вместе с ним</p></div><a class="btn sm" href="/tv" target="_blank" rel="noopener">Во весь экран</a></div>
      <div class="tvframe" id="tvWrap"><iframe src="/tv?preview=1" title="Предпросмотр экрана" id="tvFrame" tabindex="-1"></iframe></div></div>
    ${me.can.audit ? `<div class="card"><h2>Последние действия</h2>${auditTable(o.recent.slice(0, 5), true)}</div>` : ''}`);
  const off = document.getElementById('oAlarmOff');
  if (off) off.onclick = async () => { if (!confirm('Отправить отбой на все экраны?')) return; try { await api('PUT', '/api/admin/urgent', { title: '' }); render(); } catch (e) { alert(e.message); } };
  document.querySelectorAll('#sTheme [data-st]').forEach(b => b.onclick = async () => {
    try { await api('PUT', '/api/admin/settings', { theme: b.dataset.st }); render(); } catch (e) { alert(e.message); }
  });
  const hide = document.getElementById('oClearHide');
  if (hide) hide.onclick = async () => { try { await api('PUT', '/api/admin/urgent', { hide_clear: true }); render(); } catch (e) { alert(e.message); } };
  // живая миниатюра экрана: страница 1920×1080 уменьшается под ширину карточки
  const wrap = document.getElementById('tvWrap'), frame = document.getElementById('tvFrame');
  if (wrap && frame) {
    const fit = () => { frame.style.transform = `scale(${wrap.clientWidth / 1920})`; };
    new ResizeObserver(fit).observe(wrap); fit();
  }
}

// compact — короткий вид для «Обзора»: когда, кто, что и где; без «Было → стало»
function auditTable(rows, compact = false) {
  if (!rows.length) return '<p class="muted">Записей нет</p>';
  const srcName = s => ({ admin: 'Админка', system: 'Система', telegram: 'Telegram' })[s] || s;
  return `<div class="tbl-wrap"><table><thead><tr><th>Когда</th><th>Кто</th><th>Что</th><th>Где</th>${compact ? '' : '<th>Было → стало</th>'}</tr></thead><tbody>${rows.map(r => {
    const what = r.action === 'settings_changed' ? 'Изменена настройка: ' + (SETTING_LABELS[r.target] || r.target) : (ACTIONS[r.action] || r.action);
    const tgt = r.action === 'settings_changed' ? '' : r.target;
    return `<tr><td class="num">${fmtDT(r.at)}</td><td>${esc(r.user_name || '—')}<div><span class="src">${srcName(r.source)}</span></div></td>
      <td>${esc(what)}</td><td>${esc(tgt)}${r.details ? `<div class="muted small">${esc(detailsRu(r))}</div>` : ''}${r.action.startsWith('substitution') && /^\d{4}-/.test(r.details || '') ? `<div class="muted small">на ${esc(r.details.split('-').reverse().join('.'))}</div>` : ''}</td>
      ${compact ? '' : `<td>${r.was ? `<span class="was">${esc(r.was)}</span>` : ''}${r.was && r.now ? ' → ' : ''}${r.now ? `<span class="now">${esc(r.now)}</span>` : ''}</td>`}</tr>`;
  }).join('')}</tbody></table></div>`;
}

// ---------- журнал ----------
const auditState = { source: '', q: '', hide: true, rows: [], total: 0 };
async function viewAudit() {
  shell('Журнал изменений', `<div class="card"><div class="row">
    <label class="f" style="min-width:160px">Источник<select id="fs"><option value="">Все</option><option value="admin">Действия в админке</option><option value="system">Система</option><option value="telegram">Бот в Telegram</option></select></label>
    <label class="f" style="flex:1;min-width:200px">Поиск<input type="search" id="fq" placeholder="класс, учитель, имя…"></label>
    <label class="check"><input type="checkbox" id="fh"> Показывать входы и выходы</label></div></div>
    <div class="card" id="at"></div><div id="more" style="text-align:center"></div>`);
  const fs = document.getElementById('fs'), fq = document.getElementById('fq'), fh = document.getElementById('fh');
  fs.value = auditState.source; fq.value = auditState.q; fh.checked = !auditState.hide;
  const load = async (append) => {
    const off = append ? auditState.rows.length : 0;
    const q = new URLSearchParams({ limit: 50, offset: off, source: auditState.source, q: auditState.q, hide_logins: auditState.hide ? 1 : 0 });
    const r = await api('GET', '/api/admin/audit?' + q);
    auditState.rows = append ? auditState.rows.concat(r.rows) : r.rows; auditState.total = r.total;
    document.getElementById('at').innerHTML = auditTable(auditState.rows);
    document.getElementById('more').innerHTML = auditState.rows.length < auditState.total ? `<button class="btn" id="bm">Показать ещё (${auditState.total - auditState.rows.length})</button>` : '';
    const bm = document.getElementById('bm'); if (bm) bm.onclick = () => load(true);
  };
  let t; fs.onchange = () => { auditState.source = fs.value; load(); }; fh.onchange = () => { auditState.hide = !fh.checked; load(); };
  fq.oninput = () => { clearTimeout(t); t = setTimeout(() => { auditState.q = fq.value.trim(); load(); }, 300); };
  await load();
}

// ---------- медиа ----------
// три места показа; названия одинаковы везде: в загрузке, в карточках и в справке
const PLACES = [['screen', 'На весь экран'], ['center', 'В центре экрана'], ['banner', 'Баннер с QR-кодом']];
// схема экрана: подсвечена зона, куда попадёт файл
function zoneIcon(z) {
  const hl = 'fill="var(--brand)"', dim = 'fill="var(--line)"';
  if (z === 'screen') return `<svg class="zone" viewBox="0 0 64 36" aria-hidden="true"><rect x=".5" y=".5" width="63" height="35" rx="3" ${hl} opacity=".85"/></svg>`;
  return `<svg class="zone" viewBox="0 0 64 36" aria-hidden="true"><rect x=".5" y=".5" width="63" height="35" rx="3" fill="var(--sunk)" stroke="var(--line)"/>
    <rect x="3" y="3" width="58" height="5" rx="1" ${dim}/><rect x="3" y="10" width="9" height="16" rx="1.5" ${z === 'banner' ? hl : dim}/>
    <rect x="15" y="10" width="32" height="16" rx="1.5" ${z === 'center' ? hl : dim}/><rect x="50" y="10" width="11" height="16" rx="1.5" ${dim}/><rect x="3" y="28" width="58" height="5" rx="1" ${dim}/></svg>`;
}
async function mountMedia() {
  const items = await api('GET', '/api/admin/media');
  const kindLabel = { image: 'Картинка', video: 'Видео', pdf: 'Презентация' };
  document.getElementById('mediaBox').innerHTML = `
    <h2 style="margin:28px 0 12px;font-size:20px">Постеры и видео</h2>
    <div class="card"><div class="f" style="margin-bottom:12px"><span class="muted small" style="font-weight:600">Где показывать новые файлы</span>
      <div class="zones" role="radiogroup" aria-label="Где показывать">${PLACES.map(([v, l], i) => `<label class="zonepick"><input type="radio" name="place" value="${v}" ${i === 0 ? 'checked' : ''}>${zoneIcon(v)}<span>${l}</span></label>`).join('')}</div></div>
      <label class="drop" id="drop" for="fileIn">Перетащите сюда файлы или нажмите, чтобы выбрать<br><span class="small">Картинки JPG и PNG, презентации PDF, видео MP4 до 30 МБ</span></label>
      <div class="row" style="margin-top:10px"><button class="btn" id="dirBtn" type="button">Загрузить папку</button><span class="muted small">Все подходящие файлы из папки загрузятся по очереди.</span></div>
      <input type="file" id="fileIn" accept=".jpg,.jpeg,.png,.pdf,.mp4,image/jpeg,image/png,application/pdf,video/mp4" multiple hidden>
      <input type="file" id="dirIn" webkitdirectory multiple hidden><div id="um" style="margin-top:10px"></div></div>
    <p class="muted small">Видео проигрывается без звука. Текстовые объявления — выше, на этой же странице.</p>
    <div id="list">${items.map(m => `
      <div class="card media" data-id="${m.id}">
        <div class="thumb">${m.kind === 'image' ? `<img src="${esc(m.url)}" alt="">` : m.kind === 'video' ? `<video src="${esc(m.url)}#t=0.5" muted preload="metadata"></video>` : 'PDF'}</div>
        <div class="fields">
          <label class="f wide">Название<input type="text" data-k="title" value="${esc(m.title)}" maxlength="120"></label>
          ${m.kind === 'video' ? '' : `<label class="f">Секунд на экране<input type="number" data-k="duration" min="3" max="600" value="${m.duration}"></label>`}
          <label class="f" title="1 — обычно, 5 — очень часто">Как часто (1–5)<input type="number" data-k="priority" min="1" max="5" value="${m.priority}"></label>
          <label class="f">Показывать с<input type="date" data-k="date_from" value="${esc(m.date_from)}"></label>
          <label class="f">Показывать по<input type="date" data-k="date_to" value="${esc(m.date_to)}"></label>
          <label class="f">Где показывать<select data-k="place">${PLACES.map(([v, l]) => `<option value="${v}"${m.place === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="check"><input type="checkbox" data-k="break_only" ${m.break_only ? 'checked' : ''}> Только на переменах</label>
          <label class="check"><input type="checkbox" data-k="active" ${m.active ? 'checked' : ''}> Включено</label>
          <div class="wide row"><span class="muted small">${kindLabel[m.kind]} · ${Math.round(m.size / 1024)} КБ · ${esc(m.created_by || '')}, ${fmtDT(m.created_at)}</span>
            <span style="flex:1"></span>
            <button class="btn sm primary" data-a="save">Сохранить</button><button class="btn sm danger" data-a="del">Удалить</button></div>
          <div class="wide" data-m></div>
        </div></div>`).join('') || '<div class="card muted">Файлов пока нет. Загрузите первый постер.</div>'}</div>`;
  const um = document.getElementById('um'), drop = document.getElementById('drop'), inp = document.getElementById('fileIn');
  // длину видео узнаём в браузере: он читает заголовок файла без загрузки
  const videoSeconds = f => new Promise(res => { const v = document.createElement('video'); v.preload = 'metadata';
    v.onloadedmetadata = () => { URL.revokeObjectURL(v.src); res(Math.round(v.duration) || 0); };
    v.onerror = () => res(0); v.src = URL.createObjectURL(f); });
  const upload = async files => {
    const place = (document.querySelector('input[name=place]:checked') || {}).value || 'screen';
    const list = files.filter(f => /\.(jpe?g|png|pdf|mp4)$/i.test(f.name));
    const skipped = files.length - list.length;
    if (!list.length) return msg(um, 'Подходящих файлов нет: JPG, PNG, PDF или MP4', 'err');
    const failed = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      msg(um, `Загрузка ${i + 1} из ${list.length}: ${f.name}…`, 'ok');
      const headers = { 'X-File-Name': encodeURIComponent(f.name), 'X-Place': place, 'Content-Type': 'application/octet-stream' };
      if (/\.mp4$/i.test(f.name)) headers['X-Duration'] = String(await videoSeconds(f));
      try { await api('POST', '/api/admin/media/upload', f, headers); }
      catch (e) { failed.push(`${f.name}: ${e.message}`); }
    }
    if (failed.length || skipped) alert([...failed, skipped ? `Пропущено файлов другого типа: ${skipped}` : ''].filter(Boolean).join('\n'));
    render();
  };
  inp.onchange = () => upload([...inp.files]);
  const dirIn = document.getElementById('dirIn');
  document.getElementById('dirBtn').onclick = () => dirIn.click();
  dirIn.onchange = () => upload([...dirIn.files]);
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => upload([...e.dataTransfer.files]));
  document.getElementById('list').onclick = async e => {
    const btn = e.target.closest('button[data-a]'); if (!btn) return;
    const card = btn.closest('.media'), id = card.dataset.id, m = card.querySelector('[data-m]');
    const a = btn.dataset.a;
    try {
      if (a === 'save') {
        const body = {}; card.querySelectorAll('[data-k]').forEach(i => { body[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value; });
        await api('PATCH', '/api/admin/media/' + id, body); clearDirty(card, 'button[data-a=save]'); msg(m, 'Сохранено', 'ok'); setTimeout(() => msg(m, ''), 2000);
      } else if (a === 'del') {
        if (btn.dataset.sure !== '1') { btn.dataset.sure = '1'; btn.textContent = 'Точно удалить?'; setTimeout(() => { btn.dataset.sure = ''; btn.textContent = 'Удалить'; }, 4000); return; }
        await api('DELETE', '/api/admin/media/' + id); render();
      }
    } catch (err) { msg(m, err.message); }
  };
}

// ---------- экраны ----------
async function viewScreens() {
  const prefill = pendingPair; pendingPair = ''; // код из QR: вставляем в форму один раз
  const rows = await api('GET', '/api/admin/screens');
  // технические подробности (версия данных, устройство, адрес) спрятаны во всплывающую подсказку: в работе они не нужны
  const table = rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>Название</th><th>Состояние</th><th>Последний сигнал</th><th></th></tr></thead><tbody>
    ${rows.map(r => { const on = Date.now() - r.last_seen < 180000; const tech = `Версия данных: ${r.version || '—'}\nУстройство: ${(r.ua || '—').slice(0, 120)}\nАдрес: ${r.ip || '—'}`; return `<tr title="${esc(tech)}"><td><input type="text" value="${esc(r.name || '')}" placeholder="${esc(r.id)}" data-id="${esc(r.id)}" style="max-width:220px"></td>
      <td>${on ? '<span class="pill ok">на связи</span>' : '<span class="pill bad">не на связи</span>'}</td><td class="num">${esc(ago(r.last_seen))}</td>
      <td><button class="btn sm danger" type="button" data-unpair="${esc(r.id)}">Отвязать</button></td></tr>`; }).join('')}
    </tbody></table></div>` : '<p class="muted" style="margin:0">Пока ни один экран не привязан. Откройте табло — на нём появится код.</p>';
  shell('Экраны', `
    <div class="card"><h2>Привязать экран</h2>
      <p class="muted small" style="margin:4px 0 14px">На телевизоре откройте табло: на нём появится код из 6 цифр. Введите его здесь. Код действует 10 минут.</p>
      <form class="row" id="pf"><label class="f">Код с экрана<input type="text" id="pc" inputmode="numeric" autocomplete="off" maxlength="7" required placeholder="123 456" value="${esc(prefill)}" style="max-width:200px;font-size:20px;letter-spacing:.12em"></label>
        <label class="f">Название<input type="text" id="pn" maxlength="60" placeholder="Холл, 1 этаж" style="max-width:260px"></label>
        <button class="btn primary" type="submit">Привязать экран</button></form><div id="pm" style="margin-top:10px"></div></div>
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px"><h2 style="margin:0">Привязанные экраны</h2></div>
      <p class="muted small" style="margin:0 0 12px">Экран сообщает о себе раз в 15 секунд. Если связи нет больше трёх минут, он помечается как «не на связи».</p>
      ${table}</div>`, '<button class="btn primary" id="bRef">Обновить все экраны</button>');
  document.getElementById('bRef').onclick = async e => { e.target.disabled = true; try { await api('POST', '/api/admin/refresh-screens'); e.target.textContent = 'Отправлено'; } catch (er) { alert(er.message); } };
  document.getElementById('pf').onsubmit = async e => {
    e.preventDefault();
    const pm = document.getElementById('pm');
    try {
      await api('POST', '/api/admin/screens/pair', { code: document.getElementById('pc').value, name: document.getElementById('pn').value });
      msg(pm, 'Экран привязан. Через несколько секунд он откроет табло.', 'ok'); setTimeout(render, 1500);
    } catch (er) { msg(pm, er.message, 'err'); }
  };
  document.querySelectorAll('[data-unpair]').forEach(b => b.onclick = async () => {
    if (!confirm('Отвязать экран? Он снова покажет код, пока его не привяжут заново.')) return;
    try { await api('POST', '/api/admin/screens/' + b.dataset.unpair + '/unpair'); render(); } catch (er) { alert(er.message); }
  });
  document.querySelectorAll('input[data-id]').forEach(i => i.onchange = () => api('PATCH', '/api/admin/screens/' + i.dataset.id, { name: i.value }).catch(e => alert(e.message)));
}

// ---------- пользователи ----------
async function viewUsers() {
  const { roles, users } = await api('GET', '/api/admin/users');
  const roleOpts = sel => Object.entries(roles).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
  shell('Пользователи', `
    <div class="card"><h2>Добавить пользователя</h2><form class="row" id="nu">
      <label class="f">Имя<input type="text" id="nn" required placeholder="Иванова Мария Петровна"></label>
      <label class="f">Логин<input type="text" id="nl" required pattern="[A-Za-z0-9._-]{3,32}" placeholder="ivanova" autocapitalize="none"></label>
      <label class="f">Роль<select id="nr">${roleOpts('helper')}</select></label>
      <button class="btn primary" type="submit">Создать</button></form><div id="nm" style="margin-top:10px"></div>
      <p class="muted small" style="margin-bottom:0"><b>Директор</b>: всё. <b>IT-администратор</b>: всё, кроме директоров. <b>Завуч</b>: замены, срочное, расписание и звонки, объявления и постеры, экраны, журнал. <b>Помощник</b> (старшеклассник): только объявления, постеры и видео, без тревоги, замен и расписания. <b>Просмотр</b>: только обзор.</p></div>
    <div class="card"><div class="tbl-wrap"><table><thead><tr><th>Имя и логин</th><th>Роль</th><th>Состояние</th><th>Последний вход</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr data-id="${u.id}"><td><b>${esc(u.name)}</b><div class="muted small">${esc(u.login)}</div></td>
      <td><select data-f="role">${roleOpts(u.role)}</select></td>
      <td>${u.active ? '<span class="pill ok">активен</span>' : '<span class="pill off">отключён</span>'}${u.must_change ? ' <span class="pill off">пароль не сменён</span>' : ''}</td>
      <td class="num">${fmtDT(u.last_login)}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-a="tg">${u.tg ? 'Отвязать Telegram' : 'Привязать Telegram'}</button> <button class="btn sm" data-a="reset">Сбросить пароль</button> <button class="btn sm ${u.active ? 'danger' : ''}" data-a="toggle">${u.active ? 'Отключить' : 'Включить'}</button></td></tr>`).join('')}
    </tbody></table></div><div id="um" style="margin-top:10px"></div></div>`);
  const showTemp = (el, who, pw) => { el.innerHTML = `<div class="msg ok">Временный пароль для <b>${esc(who)}</b>: <span class="temp">${esc(pw)}</span><br><span class="small">Покажите его сотруднику сейчас: потом он не отображается. При входе пароль придётся заменить.</span></div>`; };
  document.getElementById('nu').onsubmit = async e => {
    e.preventDefault(); const nm = document.getElementById('nm');
    try { const r = await api('POST', '/api/admin/users', { name: document.getElementById('nn').value, login: document.getElementById('nl').value, role: document.getElementById('nr').value }); showTemp(nm, r.login, r.temp_password); e.target.reset(); setTimeout(() => { }, 0); }
    catch (er) { msg(nm, er.message); }
  };
  const um = document.getElementById('um');
  document.querySelector('tbody').onclick = async e => {
    const b = e.target.closest('button[data-a]'); if (!b) return; const tr = b.closest('tr'), id = tr.dataset.id;
    try {
      if (b.dataset.a === 'reset') {
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Точно сбросить?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Сбросить пароль'; }, 4000); return; }
        const r = await api('PATCH', '/api/admin/users/' + id, { reset_password: true }); showTemp(um, tr.querySelector('.muted').textContent, r.temp_password);
      } else if (b.dataset.a === 'tg') {
        if (b.textContent.includes('Отвязать')) { await api('POST', '/api/admin/users/' + id + '/tg-unlink', {}); render(); }
        else { const r = await api('POST', '/api/admin/users/' + id + '/tg-link', {}); tgLinkMsg(um, r.link); }
      } else { const active = b.textContent.trim() === 'Включить'; await api('PATCH', '/api/admin/users/' + id, { active }); render(); }
    } catch (er) { msg(um, er.message); }
  };
  document.querySelectorAll('select[data-f=role]').forEach(s => s.onchange = async () => {
    try { await api('PATCH', '/api/admin/users/' + s.closest('tr').dataset.id, { role: s.value }); msg(um, 'Роль изменена', 'ok'); setTimeout(render, 800); }
    catch (er) { msg(um, er.message); render(); }
  });
}

// ---------- справка ----------
async function viewHelp() {
  shell('Справка', `
  <div class="card help">
    <h2>Что где</h2>
    <p><b>Экран для телевизора</b> — адрес <code>/tv</code>. Слева сверху логотип и название школы, справа дата и время. В центре: логотип, объявления и ролики. Справа — звонки. Внизу — расписание классов.</p>
    <p><b>Страница для учеников</b> — адрес <code>/</code>. Выбор класса, расписание, замены, звонки.</p>
    <p><b>Админка</b> — адрес <code>/admin</code>. Вход по логину и паролю. Вы видите только те разделы, которые положены вашей роли.</p>

    <h2>Роли</h2>
    <ul>
      <li><b>Директор</b> — всё.</li>
      <li><b>IT-администратор</b> — пользователи (кроме директора), настройки, экраны, постеры, расписание.</li>
      <li><b>Завуч</b> — постеры, расписание, замены, объявления, экраны, журнал.</li>
      <li><b>Помощник</b> (старшеклассник) — объявления, постеры и видео. Публикует сам, без одобрения. Не включает срочные сообщения и не меняет замены и расписание.</li>
      <li><b>Просмотр</b> — обзор и журнал.</li>
    </ul>

    <h2>Бот в Telegram</h2>
    <ul>
      <li><b>Постер из телефона</b> — пришлите боту фото. Оно сразу встанет на весь экран на 10 секунд, подпись станет названием. Под ответом кнопки «В центр экрана» и «Убрать». Помощник убирает только свои постеры.</li>
      <li><b>Замена</b> (директор, завуч, IT) — кнопка «Добавить замену»: дата, классы, урок, потом одним сообщением кабинет и учитель, например «205, Петрова». Слово «отменён» — урок отменён.</li>
      <li><b>Напоминания</b>: тревога висит больше 30 минут (директор, завуч); после 16:00 нет замен на завтра (завуч); постер или объявление завтра перестанут показываться (завуч, помощник); экран не на связи 15 минут (IT).</li>
    </ul>

    <h2>Постоянное расписание</h2>
    <ul>
      <li>Меняется только загрузкой нового большого Excel-файла (.xlsx) на вкладке «Расписание». Листы: «Расписание» и «Звонки».</li>
      <li>Сначала показывается проверка: что изменится, что стоит проверить. Записывается только после кнопки «Записать расписание».</li>
      <li>Даты, которые Excel превратил из времени (12.10 → 12 октября), исправляются сами.</li>
    </ul>

    <h2>Звонки на дату</h2>
    <p>Раздел «Звонки», карточка «Звонки на дату». Выберите дату или промежуток дат, поправьте время в строке звонка или отметьте «отменён». Обычные звонки не меняются, после этих дат всё возвращается по расписанию. Отменённый урок на экране подсвечивается красным.</p>

    <h2>Замены</h2>
    <ul>
      <li><b>Файл завуча</b> — Excel-файл с заменами (колонки: Урок, Класс, Предмет, Кабинет, Ответственный учитель, Отсутствует, Примечание). Дата берётся из заголовка блока. Сначала проверка, потом запись. Записываются только даты из файла.</li>
      <li><b>Номера уроков и классы</b> сопоставляются по порядку: «1-6» со списком «8аб, 6б, 5б, 5а, 6а, 6б» — 8А и 8Б на 1-м уроке, 6Б на 2-м и так далее. «8аб» — один урок на оба класса.</li>
      <li><b>Изменения на дату</b> — выберите день и поправьте нужные ячейки. Меняется только эта дата. Пустые поля не трогаются. Чтобы отменить урок у класса, напишите в предмете «отменён».</li>
      <li>Что означает подсветка на экране: <b>предмет</b> — меняется предмет; <b>кабинет</b> — меняется кабинет; <b>учитель</b> — под предметом пишется фамилия нового учителя. Подсветка держится на один день этой замены.</li>
    </ul>

    <h2>Тема и ночной экран</h2>
    <ul>
      <li><b>Авто</b> — днём светлая тема. Ночью (по умолчанию с 21:00 до 07:00) экран чёрный, виден только крупное время и логотип. Постеры и центр ночью не показываются.</li>
      <li><b>Светлая</b> или <b>тёмная</b> весь день — ночного экрана нет. Для тёмной темы используется тёмный логотип, если он загружен (файл <code>public/brand/logo-dark.png</code>).</li>
    </ul>

    <h2>Погода</h2>
    <p>В шапке экрана показываются температура и краткое описание для Нижнекамска. Данные берутся из открытого сервиса и обновляются каждые 15 минут. Если связи нет, строка скрывается.</p>

    <h2>Режим экрана</h2>
    <ul>
      <li><b>Авто</b> (по умолчанию) — на уроках экран статичный: логотип или постеры центра, QR-баннеры без смены. На переменах всё как обычно: ролики и постеры на весь экран, баннеры листаются.</li>
      <li><b>Всегда статично</b> — для гостей и мероприятий. Ролики и постеры на весь экран не идут; постеры центра и QR-баннеры остаются.</li>
      <li><b>Всегда активно</b> — ролики и постеры идут и на уроках.</li>
    </ul>
    <p>Режим и тема меняются в «Настройках». Изменения на экране появляются в течение 15 секунд.</p>

    <h2>Центр экрана</h2>
    <p>В центре показываются постеры, ролики и объявления с местом «центр» — и на уроках тоже. Логотип школы в центре виден только тогда, когда постеров центра нет.</p>

    <h2>Постеры и ролики</h2>
    <ul>
      <li>Картинки (JPG, PNG), презентации (PDF) и видео (MP4 до 30 МБ) загружаются во вкладке «Объявления и постеры», блок «Постеры и ролики».</li>
      <li><b>Где показывать</b>: на весь экран, в центре экрана или маленьким баннером. Маленький баннер может быть картинкой или видео. Видео всегда идёт без звука, зациклено.</li>
      <li><b>Длительность видео</b> определяется при загрузке. Ролик на весь экран идёт до конца.</li>
      <li><b>Только на переменах</b> — файл на весь экран не показывается на уроках.</li>
    </ul>

    <h2>Срочное сообщение</h2>
    <p>Во вкладке «Объявления и постеры» сверху, а также в блоке «Сейчас на экранах» на «Обзоре». Текст появляется поверх всего на всех экранах и закрывает расписание и постеры. Чтобы отправить отбой, нажмите «Отправить отбой»: на экранах зелёная плашка на 5 минут. Если она мешает раньше, нажмите «Скрыть отбой», и она уйдёт сразу. В журнале записывается каждое действие.</p>

    <h2>Объявления</h2>
    <p>Короткий текст для центра экрана: сколько секунд показывать, приоритет (чем выше, тем чаще), даты показа. Выключенное объявление не показывается, но остаётся в списке.</p>

    <h2>Журнал изменений</h2>
    <p>Каждое действие: что сделано, где, кто, когда и что было → стало. Журнал виден всем ролям.</p>

    <h2>Экраны и обновление</h2>
    <p>В «Экранах» видно, какие телевизоры сейчас на связи. «Обновить все экраны» перезагружает их; обычно это не нужно, экран сам обновляется каждые 15 секунд.</p>

    <h2>Если забыли пароль</h2>
    <p>На компьютере, где запущена панель, выполните <code>npm run reset-password</code>. Команда выдаст временный пароль. При первом входе его нужно сменить.</p>
  </div>`);
}

// ---------- настройки ----------
// часовые пояса России: вместо ввода названия вручную (опечатка ломала время на экране)
const TZ_LIST = [['Europe/Kaliningrad', 'Калининград (МСК−1)'], ['Europe/Moscow', 'Москва (МСК)'], ['Europe/Samara', 'Самара (МСК+1)'], ['Asia/Yekaterinburg', 'Екатеринбург (МСК+2)'],
  ['Asia/Omsk', 'Омск (МСК+3)'], ['Asia/Krasnoyarsk', 'Красноярск (МСК+4)'], ['Asia/Irkutsk', 'Иркутск (МСК+5)'], ['Asia/Yakutsk', 'Якутск (МСК+6)'],
  ['Asia/Vladivostok', 'Владивосток (МСК+7)'], ['Asia/Magadan', 'Магадан (МСК+8)'], ['Asia/Kamchatka', 'Камчатка (МСК+9)']];
async function viewSettings() {
  const s = await api('GET', '/api/admin/settings');
  shell('Настройки', `<form class="card" id="sf" style="display:grid;gap:14px;max-width:640px">
    <label class="f">Название школы на экране<input type="text" id="s2" value="${esc(s.school_name)}" maxlength="80"></label>
    <div class="row"><label class="f">Минимум секунд на таблице между видео<input type="number" id="s3" min="10" max="600" value="${esc(s.board_seconds)}"></label>
    <label class="f">Часов подсвечивать изменения<input type="number" id="s4" min="1" max="168" value="${esc(s.change_ttl_hours)}"></label></div>
    <p class="muted small" style="margin:0">Тема, ночной режим, цвета и режим показа теперь в разделе «Система» → «Оформление».</p>
    <label class="f">Часовой пояс<select id="s5">${TZ_LIST.concat(TZ_LIST.some(z => z[0] === s.tz) ? [] : [[s.tz, s.tz]]).map(([v, l]) => `<option value="${esc(v)}"${v === s.tz ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <div id="sm"></div><div><button class="btn primary" type="submit">Сохранить</button></div></form>`);
  document.getElementById('sf').onsubmit = async e => {
    e.preventDefault(); const m = document.getElementById('sm');
    try { await api('PUT', '/api/admin/settings', { school_name: document.getElementById('s2').value, board_seconds: document.getElementById('s3').value, change_ttl_hours: document.getElementById('s4').value, tz: document.getElementById('s5').value });
      msg(m, 'Сохранено', 'ok'); }
    catch (er) { msg(m, er.message); }
  };
}

function viewProfile() {
  const p = renderPasswordForm(false);
  // тема админки переключается в меню профиля (кнопка с именем), здесь её не дублируем
  shell('Мой профиль', `<div class="card" id="tgCard"></div>` + p.form + `
    <div class="card" style="max-width:420px"><h2>Выйти на всех устройствах</h2>
      <p class="muted small" style="margin:4px 0 12px">Закроет вход в админку везде, где вы входили. Понадобится войти заново.</p>
      <button class="btn danger" id="loAll" type="button">Выйти на всех устройствах</button></div>`);
  wireTg(document.getElementById('tgCard'), !!me.tg, me.id);
  document.getElementById('loAll').onclick = async () => {
    if (!confirm('Выйти на всех устройствах? Придётся войти заново.')) return;
    try { await api('POST', '/api/auth/logout-all'); } catch {} me = null; render();
  };
  p.wire();
}

// ---------- расписание: большой файл и звонки на даты ----------
const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
async function viewSchedule() {
  const canEdit = me.can.schedule;
  const [sch, subsAll] = await Promise.all([api('GET', '/api/admin/schedule'), api('GET', '/api/admin/subs')]);
  shell('Расписание', `
    <div class="card"><h2>Что на уроке</h2>
      <p class="muted small" style="margin-top:0">Уроки класса на дату так, как их видят экраны: постоянное расписание и замены этой даты.</p>
      <div class="row"><label class="f">Класс<select id="vc"></select></label><label class="f">Дата<input type="date" id="vd"></label></div>
      <div id="viewBox" style="margin-top:12px"></div></div>
    ${me.can.schedule ? `<div class="card"><h2>Каникулы и праздники</h2>
      <p class="muted small" style="margin-top:0">В эти даты экраны вместо расписания показывают название и дату возвращения. Чтобы убрать каникулы, очистите обе даты.</p>
      <div class="row"><label class="f">С<input type="date" id="hf"></label><label class="f">По<input type="date" id="ht"></label><label class="f" style="flex:1;min-width:200px">Название<input type="text" id="hn" maxlength="80" placeholder="Каникулы"></label></div>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="hs" type="button">Сохранить каникулы</button></div>
      <div id="hm" style="margin-top:8px"></div></div>` : ''}
    <details class="card" id="impCard" ${sch.lessons.length ? '' : 'open'}><summary><b>Загрузить новое расписание из Excel</b> <span class="muted small">— обычно раз в семестр</span></summary>
      <p class="muted small" style="margin-top:12px">Постоянное расписание меняется только загрузкой нового большого Excel-файла (.xlsx). Листы: «Расписание» (сетка уроков) и «Звонки» (время уроков, завтрак, обед). Сначала система покажет, что изменится, и только после подтверждения запишет данные. Замены на отдельные дни — в разделе «Замены».</p>
      <div class="row"><label class="f" style="flex:1;min-width:240px">Файл<input type="file" id="xf" accept=".xlsx"></label>
        <button class="btn" id="xr" type="button">Проверить файл</button></div>
      <div id="xres" style="margin-top:12px"></div></details>
`);
  if (!canEdit) document.querySelectorAll('button').forEach(b => { if (b.id !== 'xr') b.disabled = true; });
  // импорт файла
  const xres = document.getElementById('xres');
  let token = null;
  document.getElementById('xr').onclick = async () => {
    const f = document.getElementById('xf').files[0];
    if (!f) return msg(xres, 'Выберите файл .xlsx');
    xres.innerHTML = '<div class="muted">Читаю файл…</div>';
    try {
      const p = await api('POST', '/api/admin/schedule/import', f, { 'Content-Type': 'application/octet-stream' });
      token = p.token;
      const warn = p.warnings.length ? `<div class="msg warn" style="margin-bottom:10px"><b>Что стоит проверить:</b><ul style="margin:6px 0 0 18px">${p.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
      const rows = p.changes.map(c => {
        const day = DAY_SHORT[c.day] || '';
        const what = c.type === 'added' ? 'добавится' : c.type === 'removed' ? 'уберётся' : 'изменится';
        return `<tr><td>${esc(c.cls)}</td><td>${esc(day)}</td><td class="num">${c.n}</td><td>${esc(what)}</td><td>${c.was ? `<span class="was">${esc(c.was)}</span>` : ''}${c.was && c.now ? ' → ' : ''}${c.now ? `<span class="now">${esc(c.now)}</span>` : ''}</td></tr>`;
      }).join('');
      xres.innerHTML = `${warn}
        <div class="msg ok" style="margin-bottom:10px">Нашли: уроков ${p.counts.lessons} в ${p.counts.classes} классах, звонков ${p.counts.bells} (перемен ${p.counts.meals}), замен ${p.counts.subs}.</div>
        ${p.first_load ? '<p class="muted small">Расписание загружается впервые, сравнивать не с чем. Подсветки не будет.</p>' : `
          <p><b>Будет изменено уроков: ${p.changes_total}</b>${p.changes_total > p.changes.length ? ` (показаны первые ${p.changes.length})` : ''}</p>
          ${p.changes.length ? `<div class="tbl-wrap" style="max-height:340px;overflow:auto"><table><thead><tr><th>Класс</th><th>День</th><th>Урок</th><th></th><th>Было → стало</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Уроки не меняются.</p>'}
          <label class="check" style="margin-top:10px"><input type="checkbox" id="mk" checked> Подсветить изменения красным на экранах</label>`}
        <div class="row" style="margin-top:12px"><button class="btn primary" id="xc" type="button">Записать расписание</button><button class="btn" id="xx" type="button">Отмена</button></div>`;
      document.getElementById('xc').onclick = async () => {
        const mk = document.getElementById('mk'); const ok = { mark: mk ? mk.checked : false };
        try { await api('POST', '/api/admin/schedule/import/commit', { token, mark: ok.mark }); xres.innerHTML = '<div class="msg ok">Расписание записано. Экраны обновятся в течение 15 секунд.</div>'; setTimeout(render, 1200); }
        catch (er) { msg(xres, er.message); }
      };
      document.getElementById('xx').onclick = () => { xres.innerHTML = ''; token = null; };
    } catch (er) { msg(xres, er.message); }
  };
  // каникулы: заполняем даты из настроек и сохраняем
  if (me.can.schedule) {
    const hs = await api('GET', '/api/admin/settings');
    document.getElementById('hf').value = hs.holiday_from || '';
    document.getElementById('ht').value = hs.holiday_to || '';
    document.getElementById('hn').value = hs.holiday_title || '';
    document.getElementById('hs').onclick = async () => {
      const body = { holiday_from: document.getElementById('hf').value, holiday_to: document.getElementById('ht').value, holiday_title: document.getElementById('hn').value.trim() };
      try { await api('PUT', '/api/admin/settings', body); msg(document.getElementById('hm'), 'Сохранено. Экраны обновятся в течение минуты.', 'ok'); }
      catch (er) { msg(document.getElementById('hm'), er.message); }
    };
  }
  // просмотр: уроки класса на дату с учётом замен этой даты (как на экранах)
  const cSel = document.getElementById('vc'), dSel = document.getElementById('vd'), vBox = document.getElementById('viewBox');
  dSel.value = todayMsk(); // сегодня по Москве
  cSel.innerHTML = sch.classes.map(c => `<option>${esc(c)}</option>`).join('');
  // звонок, который относится к параллели класса (по диапазону классов в листе «Звонки»)
  const bellFor = (n, cls) => {
    const g = parseInt(cls, 10) || 0;
    const b = sch.bells.find(x => !x.meal && x.n === n && (() => { const nums = (String(x.classes || '').match(/\d+/g) || []).map(Number); return !nums.length || (g >= Math.min(...nums) && g <= Math.max(...nums)); })());
    return b ? `${b.start}–${b.end}` : '';
  };
  const drawView = () => {
    const c = cSel.value, iso = dSel.value;
    if (!iso) return msg(vBox, 'Выберите дату');
    const w = new Date(iso + 'T12:00:00Z').getUTCDay();
    if (w === 0) { vBox.innerHTML = '<p class="muted">Воскресенье — выходной, уроков нет.</p>'; return; }
    const base = sch.lessons.filter(l => l.cls === c && l.day === w - 1);
    const subs = subsAll.filter(s => s.date === iso && s.cls === c);
    const nums = [...new Set([...base.map(l => l.n), ...subs.flatMap(s => lessonNumsOf(s.lessons))])].sort((a, b) => a - b);
    if (!nums.length) { vBox.innerHTML = '<p class="muted">У этого класса на эту дату уроков нет.</p>'; return; }
    const rows = nums.map(n => {
      const L = base.find(l => l.n === n);
      const S = subs.find(s => lessonNumsOf(s.lessons).includes(n));
      const cur = L ? `${esc(L.subject)}${L.room ? ` · к.${esc(L.room)}` : ''}${L.teacher ? `<br><small>${esc(L.teacher)}</small>` : ''}` : '<span class="muted">—</span>';
      const sub = S ? `<span class="now">${esc(S.subject || (L && L.subject) || '')}${S.room ? ` · к.${esc(S.room)}` : ''}</span><br><small>${esc(S.teacher || '')}${S.absent ? ' · вместо ' + esc(S.absent) : ''}${S.note ? ' · ' + esc(S.note) : ''}</small>` : '<span class="muted">без замены</span>';
      return `<tr><td class="num">${n}</td><td class="num">${esc(bellFor(n, c))}</td><td>${cur}</td><td>${sub}</td></tr>`;
    }).join('');
    vBox.innerHTML = `<table class="lessons"><thead><tr><th>Урок</th><th>Звонок</th><th>По расписанию</th><th>На эту дату</th></tr></thead><tbody>${rows}</tbody></table>`;
  };
  cSel.onchange = drawView; dSel.onchange = drawView;
  drawView();
}

// ---------- замены ----------
// Что показываем на дате: постоянное расписание + замены этой даты (как на экране)
const dayIndexOf = iso => { const w = new Date(iso + 'T12:00:00').getDay(); return w === 0 ? -1 : w - 1; };
const lessonNumsOf = str => { const out = []; String(str || '').split(',').forEach(part => { const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part); if (m) { for (let i = +m[1]; i <= +m[2]; i++) out.push(i); } else if (/^\s*\d+\s*$/.test(part)) out.push(+part); }); return out; };

async function viewSubs() {
  const [rows, sch] = await Promise.all([api('GET', '/api/admin/subs'), api('GET', '/api/admin/schedule')]);
  const groups = new Map();
  for (const r of rows) {
    const k = [r.date, r.lessons, r.subject, r.room, r.teacher, r.absent, r.note].join('|');
    if (!groups.has(k)) groups.set(k, { ids: [], date: r.date, lessons: r.lessons, subject: r.subject, room: r.room, teacher: r.teacher, absent: r.absent, note: r.note, cls: [] });
    const g = groups.get(k); g.ids.push(r.id); g.cls.push(r.cls);
  }
  const list = [...groups.values()];
  const today = todayMsk();
  shell('Замены', `
    <div class="card"><h2>Добавить замену</h2>
      <p class="muted small" style="margin-top:0">Выберите дату, урок и классы. Пустые поля берутся из расписания. Чтобы отменить урок, напишите в предмете «отменён».</p>
      <form id="sf2" style="display:grid;gap:14px">
        <div class="row">
          <label class="f">Дата<input type="date" id="sd" required></label>
          <label class="f">Урок<input type="text" id="sl" placeholder="3 или 1-6" maxlength="20" style="width:110px" required></label>
          <label class="f" style="flex:1;min-width:180px">Предмет<input type="text" id="ss" placeholder="пусто — как в расписании" maxlength="120"></label>
          <label class="f">Кабинет<input type="text" id="sr" maxlength="40" style="width:110px"></label>
        </div>
        <div class="f"><span class="muted small" style="font-weight:600">Классы <span id="scN" class="muted"></span></span>
          <div class="chipsel" id="scBox">${sch.classes.map(c => `<label class="clschip"><input type="checkbox" value="${esc(c)}"><span>${esc(c)}</span></label>`).join('') || '<span class="muted small">Расписание ещё не загружено</span>'}</div></div>
        <div class="row">
          <label class="f" style="flex:1;min-width:200px">Кто заменяет<input type="text" id="st" list="teachers" maxlength="80"></label>
          <label class="f" style="flex:1;min-width:200px">Кого заменяют<input type="text" id="sa" list="teachers" maxlength="80"></label>
          <label class="f" style="flex:1;min-width:200px">Примечание<input type="text" id="sn" maxlength="120"></label>
          <datalist id="teachers">${[...new Set(sch.lessons.map(l => l.teacher).filter(Boolean))].sort().map(t => `<option value="${esc(t)}">`).join('')}</datalist>
        </div>
        <div class="row"><button class="btn primary" type="submit">Добавить замену</button></div></form><div id="sm2" style="margin-top:10px"></div></div>
    <div class="card"><h2>Замены (последние 400)</h2>
      ${list.length ? `<div class="tbl-wrap"><table><thead><tr><th>Дата</th><th>Уроки</th><th>Классы</th><th>Предмет</th><th>Кабинет</th><th>Учитель</th><th>Вместо</th><th></th></tr></thead><tbody>
        ${list.map(g => `<tr><td class="num">${esc(g.date.split('-').reverse().join('.'))}</td><td class="num">${esc(g.lessons)}</td><td>${esc(g.cls.join(', '))}</td><td>${esc(g.subject)}${g.note ? `<div class="muted small">${esc(g.note)}</div>` : ''}</td><td>${esc(g.room)}</td><td>${esc(g.teacher)}</td><td>${esc(g.absent)}</td>
          <td>${me.can.subs ? `<button class="btn sm danger" data-ids="${g.ids.join(',')}">Убрать</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Замен пока нет.</p>'}</div>
    <details class="card" id="fileCard"><summary><b>Загрузить замены из Excel</b> <span class="muted small">— файл завуча на день</span></summary>
      <p class="muted small" style="margin-top:12px">Файл Excel (.xlsx), лист «Замены» или первый лист. Колонки: Урок, Класс, Предмет, Кабинет, Ответственный учитель, Отсутствует, Примечание. Дата — в строке заголовка блока (например «Замена кабинетов на 17.10.2026»). Номер урока «1-6» или «1, 3» сопоставляется с классами по порядку, «8аб» — один урок для 8А и 8Б. Перед записью показываем проверку. Записываются только даты из файла: замены этих дат, загруженные из файла раньше, заменяются; ручные остаются.</p>
      <div class="row"><label class="f" style="flex:1;min-width:240px">Файл<input type="file" id="sfile" accept=".xlsx"></label>
        <button class="btn" id="sfr" type="button">Проверить файл</button></div>
      <div id="sfres" style="margin-top:12px"></div></details>`);

  // --- файл завуча: проверка → запись ---
  const sres = document.getElementById('sfres');
  let token = null;
  document.getElementById('sfr').onclick = async () => {
    const f = document.getElementById('sfile').files[0];
    if (!f) return msg(sres, 'Выберите файл .xlsx');
    sres.innerHTML = '<div class="muted">Читаю файл…</div>';
    try {
      const p = await api('POST', '/api/admin/subs/import', f, { 'Content-Type': 'application/octet-stream' });
      token = p.token;
      const warn = p.warnings.length ? `<div class="msg warn" style="margin-bottom:10px"><b>Что стоит проверить:</b><ul style="margin:6px 0 0 18px">${p.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
      const lines = p.rows.map(r => `<tr><td class="num">${esc(r.date.split('-').reverse().join('.'))}</td><td class="num">${esc(r.lessons)}</td><td>${esc(r.cls)}</td><td>${esc(r.subject)}</td><td>${esc(r.room)}</td><td>${esc(r.teacher)}</td><td>${esc(r.note)}</td></tr>`).join('');
      sres.innerHTML = `${warn}
        <div class="msg ok" style="margin-bottom:10px">Нашли строк замен: ${p.counts.rows} для классов: ${p.counts.classes}. Даты: ${p.dates.map(d => d.split('-').reverse().join('.')).join(', ')}. Лист: «${esc(p.sheet)}».</div>
        <div class="tbl-wrap" style="max-height:360px;overflow:auto"><table><thead><tr><th>Дата</th><th>Урок</th><th>Класс</th><th>Предмет</th><th>Кабинет</th><th>Учитель</th><th>Примечание</th></tr></thead><tbody>${lines}</tbody></table></div>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="sfc" type="button">Записать замены</button><button class="btn" id="sfx" type="button">Отмена</button></div>`;
      document.getElementById('sfc').onclick = async () => {
        try { const r = await api('POST', '/api/admin/subs/import/commit', { token }); sres.innerHTML = `<div class="msg ok">Записано строк: ${r.saved}. Экраны обновятся в течение 15 секунд.</div>`; setTimeout(render, 1200); }
        catch (er) { msg(sres, er.message); }
      };
      document.getElementById('sfx').onclick = () => { sres.innerHTML = ''; token = null; };
    } catch (er) { msg(sres, er.message); }
  };

  // --- добавить замену: классы выбираются кнопками, список «Классы» собирается в строку для сервера ---
  document.getElementById('sd').value = today;
  const chosen = () => [...document.querySelectorAll('#scBox input:checked')].map(i => i.value);
  document.getElementById('scBox').onchange = () => { const n = chosen().length; document.getElementById('scN').textContent = n ? '· выбрано ' + n : ''; };
  document.getElementById('sf2').onsubmit = async e => {
    e.preventDefault(); const m = document.getElementById('sm2');
    const classes = chosen();
    if (!classes.length) return msg(m, 'Выберите хотя бы один класс');
    try { await api('POST', '/api/admin/subs', { date: document.getElementById('sd').value, lessons: document.getElementById('sl').value, classes: classes.join(', '), subject: document.getElementById('ss').value, room: document.getElementById('sr').value, teacher: document.getElementById('st').value, absent: document.getElementById('sa').value, note: document.getElementById('sn').value }); render(); }
    catch (er) { msg(m, er.message); }
  };
  document.querySelector('#view').onclick = async e => {
    const b = e.target.closest('button[data-ids]'); if (!b) return;
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Точно убрать?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Убрать'; }, 4000); return; }
    try { await api('DELETE', '/api/admin/subs', { ids: b.dataset.ids.split(',').map(Number) }); render(); } catch (er) { alert(er.message); }
  };
}

// ---------- звонки: сдвиг на сегодня, звонки на дату, действующие изменения ----------
async function viewCalls() {
  const sch = await api('GET', '/api/admin/schedule');
  const canEdit = me.can.schedule;
  const dRange = (a, b) => a.split('-').reverse().join('.') + (b !== a ? ' – ' + b.split('-').reverse().join('.') : '');
  const exRowsList = (sch.exceptions || []).map(x => `<tr data-id="${x.id}"><td>${x.meal ? esc(x.title) : 'Урок ' + x.n}</td><td>${dRange(x.date_from, x.date_to)}</td><td>${x.cancelled ? 'урок отменён' : esc(x.start) + '–' + esc(x.end)}</td><td><button class="btn sm danger" data-bx="del" type="button">Убрать</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Изменений звонков нет</td></tr>';
  const lessonNums = [...new Set(sch.bells.filter(b => !b.meal).map(b => b.n))].sort((a, b) => a - b);
  shell('Звонки', `
    <div class="card"><h2>Сдвиг звонков на сегодня</h2>
      <p class="muted small" style="margin-top:0">Для случая, когда занятия возобновляются позже (например, после тревоги). Выберите урок, с которого возобновляем, и на сколько минут сдвинуть. Уроки до него не меняются. С выбранного урока сдвигаются его начало и конец, все перемены после него и конец дня. Действует только сегодня. Сам не возвращается: снимите кнопкой «Вернуть».</p>
      <div id="shiftNow"></div>
      <div class="row" style="align-items:flex-end">
        <label class="f">С какого урока<select id="shFrom">${lessonNums.map(n => `<option value="${n}">Урок ${n}</option>`).join('')}</select></label>
        <label class="f">На сколько минут<input type="number" id="shMin" min="1" max="120" value="30" style="width:110px"></label>
        <button class="btn primary" id="shGo" type="button">Сдвинуть звонки</button>
      </div>
      <div id="shMsg" style="margin-top:8px"></div></div>
    <div class="card"><h2>Звонки на дату</h2>
      <p class="muted small" style="margin-top:0">Выберите дату (или промежуток дат). В строке поправьте время или отметьте «отменён» (урок или перемену: завтрак, обед). Меняется только выбранный период, обычные звонки не трогаются. Пустые строки не меняются.</p>
      <div class="row"><label class="f">С даты<input type="date" id="bellFrom"></label><label class="f">По дату<input type="date" id="bellTo"></label><button class="btn" id="bellLoad" type="button">Показать звонки</button></div>
      <div class="tbl-wrap" style="margin-top:12px"><table class="lessons" id="bellTbl"></table></div>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="bellSave" type="button">Сохранить звонки на период</button></div>
      <div id="bellMsg" style="margin-top:8px"></div>
      <h3 style="margin:18px 0 8px;font-size:15px">Изменения звонков, которые уже действуют</h3>
      <div class="tbl-wrap"><table class="lessons" id="bxTbl"><thead><tr><th>Звонок</th><th>Даты</th><th>Что</th><th></th></tr></thead><tbody>${exRowsList}</tbody></table></div></div>`);
  if (!canEdit) document.querySelectorAll('button').forEach(b => { b.disabled = true; });

  // сдвиг звонков на сегодня
  const shNow = document.getElementById('shiftNow'), shMsg = document.getElementById('shMsg');
  const shState = await api('GET', '/api/admin/shift');
  shNow.innerHTML = shState ? `<div class="msg warn" style="margin-bottom:10px"><b>Сейчас сдвинуто:</b> с ${shState.from} урока на ${shState.minutes} мин. <button class="btn sm" id="shOff" type="button" style="margin-left:8px">Вернуть</button></div>` : '';
  if (shState) document.getElementById('shFrom').value = String(shState.from);
  document.getElementById('shGo').onclick = async () => {
    const from = Number(document.getElementById('shFrom').value), minutes = Number(document.getElementById('shMin').value);
    if (!confirm(`Сдвинуть звонки на ${minutes} мин с ${from} урока на сегодня?`)) return;
    try { await api('PUT', '/api/admin/shift', { from, minutes }); msg(shMsg, 'Звонки сдвинуты. Экраны обновятся в течение 15 секунд', 'ok'); setTimeout(render, 600); }
    catch (er) { msg(shMsg, er.message); }
  };
  const shOff = document.getElementById('shOff');
  if (shOff) shOff.onclick = async () => {
    if (!confirm('Вернуть звонки к обычному расписанию на сегодня?')) return;
    try { await api('PUT', '/api/admin/shift', { reset: true }); render(); } catch (er) { msg(shMsg, er.message); }
  };

  // звонки на дату: таблица звонков и сохранение на период
  const bellTbl = document.getElementById('bellTbl'), bellMsg = document.getElementById('bellMsg');
  const drawBells = () => {
    const from = document.getElementById('bellFrom').value;
    if (!from) { bellTbl.innerHTML = '<tr><td class="muted">Выберите дату, с которой меняются звонки</td></tr>'; return; }
    bellTbl.innerHTML = `<thead><tr><th>Звонок</th><th>По расписанию</th><th>Новое начало</th><th>Новый конец</th><th>Отменить (урок или перемену)</th></tr></thead><tbody>${
      sch.bells.map(b => `<tr data-id="${b.id}" data-meal="${b.meal ? 1 : 0}"><td>${b.meal ? esc(b.title) : 'Урок ' + b.n}${b.label ? ` <span class="muted small">(${esc(b.label)})</span>` : ''}</td><td class="num">${esc(b.start)}–${esc(b.end)}</td>
        <td><input data-k="start" data-o="${esc(b.start)}" value="${esc(b.start)}" style="width:90px"></td>
        <td><input data-k="end" data-o="${esc(b.end)}" value="${esc(b.end)}" style="width:90px"></td>
        <td><input type="checkbox" data-k="cancel"></td></tr>`).join('')}</tbody>`;
  };
  document.getElementById('bellFrom').onchange = e => { const to = document.getElementById('bellTo'); if (!to.value) to.value = e.target.value; drawBells(); };
  document.getElementById('bellLoad').onclick = drawBells;
  document.getElementById('bellSave').onclick = async () => {
    const from = document.getElementById('bellFrom').value, to = document.getElementById('bellTo').value || from;
    if (!from) return msg(bellMsg, 'Выберите дату');
    const items = [];
    bellTbl.querySelectorAll('tbody tr').forEach(tr => {
      const g = k => tr.querySelector(`[data-k=${k}]`);
      const cancel = g('cancel') ? g('cancel').checked : false;
      const st = g('start').value.trim(), en = g('end').value.trim();
      const timeChanged = st !== g('start').dataset.o || en !== g('end').dataset.o;
      if (cancel || timeChanged) items.push({ bell_id: tr.dataset.id, cancelled: cancel, start: st, end: en });
    });
    if (!items.length) return msg(bellMsg, 'Ничего не изменено');
    let done = 0;
    for (const it of items) {
      try { await api('POST', '/api/admin/schedule/bell-exceptions', { bell_id: it.bell_id, date_from: from, date_to: to, cancelled: it.cancelled, start: it.start, end: it.end }); done++; }
      catch (er) { return msg(bellMsg, `Сохранено ${done} из ${items.length}. Ошибка: ${er.message}`); }
    }
    msg(bellMsg, `Сохранено звонков: ${done}. Экраны обновятся в течение 15 секунд`, 'ok'); setTimeout(render, 500);
  };
  // удаление изменения звонка: сначала подтверждение второй кнопкой
  document.getElementById('bxTbl').onclick = async e => {
    const b = e.target.closest('button[data-bx=del]'); if (!b) return;
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Точно убрать?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Убрать'; }, 4000); return; }
    try { await api('DELETE', '/api/admin/schedule/bell-exceptions/' + b.closest('tr').dataset.id); render(); } catch (er) { msg(bellMsg, er.message); }
  };
  drawBells();
}

// ---------- срочное сообщение ----------
// Включение одним подтверждением прямо на странице (без двух системных окон подряд): при тревоге важны секунды.
async function viewUrgent() {
  const urgent = await api('GET', '/api/admin/urgent');
  const hrs = urgent.item && urgent.item.since ? (Date.now() - urgent.item.since) / 3600e3 : 0;
  const t2 = ts => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  shell('Срочное сообщение', `
    <p class="muted" style="margin-top:0">Сообщение появится на всех экранах поверх расписания, постеров и ночного режима и будет висеть, пока его не снимут. Снять может тот, кто включил, или директор.</p>
    ${urgent.active ? `<div class="msg warn" style="margin-bottom:12px"><b>Сейчас на экранах:</b> «${esc(urgent.item.title)}»${urgent.item.source ? `, источник: ${esc(urgent.item.source)}` : ''}, включено в ${t2(urgent.item.since)}.
      ${hrs >= 2 ? `<br><b>Сообщение висит уже ${Math.floor(hrs)} ч. Проверьте, актуально ли оно, и снимите его.</b>` : ''}
      <div class="row" style="margin-top:8px"><button class="btn danger" id="uOff" type="button">Отправить отбой</button></div></div>` : ''}
    ${urgent.clear ? `<div class="msg ok" style="margin-bottom:12px"><b>Отбой на экранах</b> до ${t2(urgent.clear.until)}.
      <div class="row" style="margin-top:8px"><button class="btn" id="cHide" type="button">Скрыть отбой</button></div></div>` : ''}
    <div class="card"><h2>Готовые тревоги</h2>
      <div class="row presets">${urgent.presets.map(p => `<button class="btn danger preset" data-preset="${esc(p.id)}" type="button">${esc(p.title)}</button>`).join('')}</div>
      <div id="uAsk"></div></div>
    <div class="card"><h2>Своё сообщение</h2>
      <div class="row" style="align-items:flex-end">
        <label class="f" style="flex:1;min-width:260px">Заголовок<input type="text" id="ut" maxlength="120" placeholder="Например: Эвакуация"></label>
        <label class="f" style="flex:1;min-width:260px">Что делать (необязательно)<input type="text" id="un" maxlength="200" placeholder="Выйдите из здания по плану эвакуации"></label>
        <label class="f" style="min-width:200px">Кто сообщает (необязательно)<input type="text" id="us" maxlength="80" placeholder="Администрация"></label>
        <button class="btn danger" id="uOn" type="button">Показать на экранах</button>
      </div></div>
    <div id="um2"></div>`);
  const um2 = document.getElementById('um2'), ask = document.getElementById('uAsk');
  const sendUrgent = async body => {
    try { await api('PUT', '/api/admin/urgent', body); msg(um2, 'Сообщение отправлено на экраны', 'ok'); setTimeout(render, 600); }
    catch (er) { msg(um2, er.message); }
  };
  // подтверждение прямо в странице: одна крупная кнопка «Включить»; для своего текста окно появляется рядом с полями
  const confirmUrgent = (title, host, body) => {
    host.innerHTML = `<div class="confirm" role="alertdialog" aria-label="Подтверждение"><div><b>Включить на всех экранах?</b><div class="confirm-t">«${esc(title)}»</div><div class="muted small">Появится сразу и будет висеть, пока не отправите отбой.</div></div>
      <div class="row"><button class="btn danger big" id="uYes" type="button">Включить на всех экранах</button><button class="btn big" id="uNo" type="button">Отмена</button></div></div>`;
    document.getElementById('uYes').onclick = () => sendUrgent(body);
    document.getElementById('uNo').onclick = () => { host.innerHTML = ''; };
    host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  document.querySelectorAll('button[data-preset]').forEach(btn => btn.onclick = () =>
    confirmUrgent(btn.textContent.trim(), ask, { preset: btn.dataset.preset, confirmed: true }));
  document.getElementById('uOn').onclick = () => {
    const title = document.getElementById('ut').value.trim();
    if (!title) return msg(um2, 'Напишите заголовок сообщения');
    um2.innerHTML = '';
    const host = document.createElement('div'); um2.append(host);
    confirmUrgent(title, host, { title, source: document.getElementById('us').value.trim(), note: document.getElementById('un').value.trim() });
  };
  const uo = document.getElementById('uOff');
  if (uo) uo.onclick = () => {
    um2.innerHTML = '<div class="confirm" role="alertdialog"><div><b>Отправить отбой на все экраны?</b><div class="muted small">Зелёная плашка будет показана 5 минут.</div></div><div class="row"><button class="btn danger big" id="uOffYes" type="button">Отправить отбой</button><button class="btn big" id="uOffNo" type="button">Отмена</button></div></div>';
    document.getElementById('uOffYes').onclick = async () => { try { await api('PUT', '/api/admin/urgent', { title: '' }); render(); } catch (er) { msg(um2, er.message); } };
    document.getElementById('uOffNo').onclick = () => { um2.innerHTML = ''; };
  };
  const ch = document.getElementById('cHide');
  if (ch) ch.onclick = async () => { try { await api('PUT', '/api/admin/urgent', { hide_clear: true }); render(); } catch (er) { msg(um2, er.message); } };
}

// ---------- объявления и постеры ----------
async function viewAnn() {
  const rows = await api('GET', '/api/admin/announcements');
  shell('Объявления и постеры', `
    <div class="card"><h2>Новое объявление</h2><p class="muted small" style="margin-top:0">Текст показывается в центре экрана. Картинки и видео загружаются ниже, в блоке «Постеры и видео».</p>
      <form class="row" id="af">
        <label class="f" style="flex:1;min-width:320px">Текст<input type="text" id="at" required maxlength="300" placeholder="Родительское собрание — в четверг в 18:00, актовый зал"></label>
        <label class="f">Сколько показывать<select id="aq"><option value="">Пока не уберу</option><option value="0">Сегодня</option><option value="2">3 дня</option><option value="6">Неделю</option><option value="dates">Выбрать даты…</option></select></label>
        <label class="f">Секунд на экране<input type="number" id="ad" min="3" max="600" value="10" style="width:90px"></label>
        <label class="f" title="1 — обычно, 5 — очень часто">Как часто (1–5)<input type="number" id="ap" min="1" max="5" value="1" style="width:90px"></label>
        <label class="f" id="af1w" hidden>С даты<input type="date" id="af1"></label>
        <label class="f" id="af2w" hidden>По дату<input type="date" id="af2"></label>
        <button class="btn primary" type="submit">Добавить</button></form><div id="am" style="margin-top:10px"></div></div>
    <div class="card">${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>Текст</th><th>Секунд</th><th>Как часто</th><th>С</th><th>По</th><th>Включено</th><th></th></tr></thead><tbody>
      ${rows.map(a => `<tr data-id="${a.id}"><td><input type="text" data-k="title" value="${esc(a.title)}" maxlength="300" style="min-width:260px"></td>
        <td><input type="number" data-k="duration" min="3" max="600" value="${a.duration}" style="width:80px"></td>
        <td><input type="number" data-k="priority" min="1" max="5" value="${a.priority}" style="width:70px"></td>
        <td><input type="date" data-k="date_from" value="${esc(a.date_from)}"></td><td><input type="date" data-k="date_to" value="${esc(a.date_to)}"></td>
        <td><input type="checkbox" data-k="active" ${a.active ? 'checked' : ''}></td>
        <td style="white-space:nowrap"><button class="btn sm primary" data-a="save" type="button">Сохранить</button> <button class="btn sm danger" data-a="del" type="button">Удалить</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Объявлений пока нет.</p>'}<div id="al" style="margin-top:8px"></div></div>
    <div id="mediaBox"></div>`);
  // срок показа: быстрые варианты вместо двух дат (даты — по запросу)
  const aq = document.getElementById('aq');
  aq.onchange = () => { const d = aq.value === 'dates'; document.getElementById('af1w').hidden = !d; document.getElementById('af2w').hidden = !d; };
  document.getElementById('af').onsubmit = async e => {
    e.preventDefault(); const m = document.getElementById('am');
    let from = '', to = '';
    if (aq.value === 'dates') { from = document.getElementById('af1').value; to = document.getElementById('af2').value; }
    else if (aq.value !== '') { from = todayMsk(); to = addDaysIso(from, Number(aq.value)); }
    try { await api('POST', '/api/admin/announcements', { title: document.getElementById('at').value, duration: document.getElementById('ad').value, priority: document.getElementById('ap').value, date_from: from, date_to: to }); render(); }
    catch (er) { msg(m, er.message); }
  };
  const al = document.getElementById('al');
  // несохранённая правка в строке подсвечивается: чтобы не уйти со страницы, не нажав «Сохранить»
  markDirty(document.querySelector('#view'), 'tr[data-id], .media', 'button[data-a=save]');
  document.querySelector('#view').onclick = async e => {
    const b = e.target.closest('button[data-a]'); if (!b) return; const tr = b.closest('tr[data-id]'); if (!tr) return;
    const id = tr.dataset.id;
    try {
      if (b.dataset.a === 'save') {
        const body = {}; tr.querySelectorAll('[data-k]').forEach(i => { body[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value; });
        await api('PATCH', '/api/admin/announcements/' + id, body); clearDirty(tr, 'button[data-a=save]'); msg(al, 'Сохранено', 'ok'); setTimeout(() => msg(al, ''), 1500);
      } else {
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Точно удалить?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Удалить'; }, 4000); return; }
        await api('DELETE', '/api/admin/announcements/' + id); render();
      }
    } catch (er) { msg(al, er.message); }
  };
  await mountMedia();
}

// ---------- запуск ----------
const VIEWS = { overview: viewOverview, schedule: viewSchedule, subs: viewSubs, urgent: viewUrgent, ann: viewAnn };

// ---------- оформление экрана ----------
// Всё, что меняет вид экрана в холле, в одном месте: тема и ночь, цвета, что показывать, размер таблицы, режим показа.
// Справа живой предпросмотр: изменения видны сразу, на настоящих экранах они появятся после сохранения.
const LOOK_DEFAULT = { bg: '#d9dde4', panel: '#f1f3f6', text: '#1f2330', accent: '#db4755' };
const LOOK_COLORS = [['bg', 'Фон', 'за блоками'], ['panel', 'Блоки', 'шапка, звонки, таблица'], ['text', 'Текст', 'предметы и время'], ['accent', 'Акцент', 'замены, текущий урок']];
const LOOK_PRESETS = [['Лицей', {}], ['Синий', { bg: '#dbe4ef', panel: '#f3f7fc', text: '#1b2433', accent: '#2f6fd6' }],
  ['Зелёный', { bg: '#dce6df', panel: '#f2f7f3', text: '#1d2a22', accent: '#1f8a5b' }], ['Графит', { bg: '#d8d8dc', panel: '#f0f0f2', text: '#202126', accent: '#4b5563' }],
  ['Бордо', { bg: '#e6dcdd', panel: '#f7f1f1', text: '#2a1d1f', accent: '#9b2335' }]];
const LOOK_MODES = [['auto', 'Авто', 'На уроках экран спокойный: логотип и QR-баннеры. На переменах всё как обычно: постеры и ролики.'],
  ['static', 'Всегда спокойный', 'Для гостей и мероприятий: постеры и ролики на весь экран не идут.'],
  ['active', 'Всегда с роликами', 'Постеры и ролики идут и во время уроков.']];
const LOOK_THEMES = [['auto', 'Авто'], ['light', 'Светлая'], ['dark', 'Тёмная']];
// контраст по WCAG: насколько один цвет читается на другом (4.5 и выше — хорошо)
const hexLum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrastOf = (a, b) => { const [x, y] = [hexLum(a), hexLum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

async function viewLook() {
  const s = await api('GET', '/api/admin/settings');
  const from = {
    theme: s.theme || 'auto', night_from: s.night_from || '21:00', night_to: s.night_to || '07:00', display_mode: s.display_mode || 'auto',
    bg: s.look_bg || '', panel: s.look_panel || '', text: s.look_text || '', accent: s.look_accent || '',
    font: Number(s.look_font) || 100, weather: s.look_weather !== '0', bells: s.look_bells !== '0', banners: s.look_banners !== '0'
  };
  const STANDARD = { theme: 'auto', night_from: '21:00', night_to: '07:00', display_mode: 'auto', bg: '', panel: '', text: '', accent: '', font: 100, weather: true, bells: true, banners: true };
  let cur = { ...from }, previewNight = false, saved = { ...from };
  const val = k => cur[k] || LOOK_DEFAULT[k];
  shell('Оформление', `
    <div class="look-grid">
      <div class="look-col">
        <div class="card"><h2>Тема экрана</h2>
          <div class="seg seg-wide" id="lkTheme" role="group" aria-label="Тема экрана">${LOOK_THEMES.map(([v, l]) => `<button type="button" data-th="${v}">${l}</button>`).join('')}</div>
          <p class="muted small" id="lkThemeHint" style="margin:10px 0 0"></p>
          <div class="row" id="lkNight" style="margin-top:10px"><label class="f">Ночь с<input type="time" id="lkNf" style="width:130px"></label><label class="f">до<input type="time" id="lkNt" style="width:130px"></label></div></div>
        <div class="card"><h2>Цвета светлой темы</h2>
          <div class="presets-look" id="lkPresets">${LOOK_PRESETS.map(([n, c], i) => { const d = { ...LOOK_DEFAULT, ...c }; return `<button type="button" class="preset-look" data-p="${i}" aria-pressed="false"><span class="dots"><i style="background:${d.bg}"></i><i style="background:${d.panel}"></i><i style="background:${d.accent}"></i></span>${n}</button>`; }).join('')}</div>
          ${LOOK_COLORS.map(([k, l, h]) => `<div class="colorrow"><label for="lkc_${k}"><b>${l}</b><span class="muted small">${h}</span></label><input type="color" id="lkc_${k}" data-c="${k}"><button class="btn sm" type="button" data-reset="${k}">Стандартный</button></div>`).join('')}
          <div id="lkContrast"></div>
          <p class="muted small" style="margin:10px 0 0">Тёмная тема и ночной экран остаются тёмными.</p></div>
        <div class="card"><h2>Что показывать</h2>
          <label class="check"><input type="checkbox" data-t="weather"> Погода в шапке</label>
          <label class="check"><input type="checkbox" data-t="bells"> Расписание звонков справа</label>
          <label class="check"><input type="checkbox" data-t="banners"> Маленькие баннеры с QR-кодами слева</label>
          <div class="f" style="margin-top:14px"><span class="muted small" style="font-weight:600">Размер таблицы уроков: <output id="lkFontO"></output></span>
            <input type="range" id="lkFont" min="80" max="130" step="5" aria-label="Размер таблицы уроков"></div></div>
        <div class="card"><h2>Режим показа</h2>
          <div class="optlist" role="radiogroup" aria-label="Режим показа">${LOOK_MODES.map(([v, t, d]) => `<label class="opt"><input type="radio" name="lkMode" value="${v}"><span><b>${t}</b><span class="muted small">${d}</span></span></label>`).join('')}</div></div>
      </div>
      <div class="look-col look-prev"><div class="card"><div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px"><h2 style="margin:0">Так выглядит экран</h2>
        <div class="seg seg2" id="lkDayNight" role="group" aria-label="Что показать в предпросмотре"><button type="button" data-n="0">День</button><button type="button" data-n="1">Ночь</button></div></div>
        <div class="tvframe" id="tvWrap"><iframe src="/tv?preview=1" title="Предпросмотр экрана" id="tvFrame" tabindex="-1"></iframe></div>
        <p class="muted small" style="margin:10px 0 0">Изменения видны здесь сразу. На экранах в холле они появятся после сохранения, в течение минуты.</p></div></div>
    </div>
    <div class="savebar" id="lkBar"><span id="lkState" class="muted"></span><button class="btn" id="lkReset" type="button" title="Вернуть стандартные цвета, тему и режим (кнопку «Сохранить» ещё нужно нажать)">Сбросить</button><button class="btn primary" id="lkSave" type="button">Сохранить оформление</button></div>
    <div id="lookMsg"></div>`);
  const $q = id => document.getElementById(id), frame = $q('tvFrame'), wrap = $q('tvWrap');
  const fit = () => { frame.style.transform = `scale(${wrap.clientWidth / 1920})`; };
  new ResizeObserver(fit).observe(wrap); fit();

  const push = () => {
    const w = frame.contentWindow; if (!w || typeof w.previewSettings !== 'function') return false;
    w.previewSettings({ theme: cur.theme, nightFrom: cur.night_from, nightTo: cur.night_to, displayMode: cur.display_mode, previewNight: cur.theme === 'auto' ? previewNight : null,
      look: { bg: cur.bg, panel: cur.panel, text: cur.text, accent: cur.accent, font: cur.font, weather: cur.weather, bells: cur.bells, banners: cur.banners } });
    return true;
  };
  // страница в рамке загружает данные не сразу: пробуем несколько раз
  frame.addEventListener('load', () => [400, 1200, 2500, 5000].forEach(t => setTimeout(push, t)));

  const hint = { auto: 'Днём светлая, ночью чёрный экран с временем и логотипом.', light: 'Светлая весь день, ночного экрана нет.', dark: 'Тёмная весь день, ночного экрана нет.' };
  const sync = () => {
    document.querySelectorAll('#lkTheme [data-th]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.th === cur.theme)));
    $q('lkThemeHint').textContent = hint[cur.theme];
    $q('lkNight').hidden = cur.theme !== 'auto'; $q('lkDayNight').hidden = cur.theme !== 'auto';
    $q('lkNf').value = cur.night_from; $q('lkNt').value = cur.night_to;
    document.querySelectorAll('#lkDayNight [data-n]').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.n === '1') === previewNight)));
    LOOK_COLORS.forEach(([k]) => { $q('lkc_' + k).value = val(k); document.querySelector(`[data-reset="${k}"]`).hidden = !cur[k]; });
    document.querySelectorAll('#lkPresets [data-p]').forEach(b => { const c = { ...LOOK_DEFAULT, ...LOOK_PRESETS[b.dataset.p][1] }; b.setAttribute('aria-pressed', String(LOOK_COLORS.every(([k]) => val(k).toLowerCase() === c[k]))); });
    const warn = [];
    if (contrastOf(val('text'), val('panel')) < 4.5) warn.push('Текст плохо читается на блоках: сделайте его темнее или блоки светлее.');
    if (contrastOf(val('text'), val('bg')) < 3) warn.push('Текст почти сливается с фоном.');
    if (contrastOf('#ffffff', val('accent')) < 3) warn.push('Белый текст на акценте (текущий урок) плохо виден: возьмите акцент темнее.');
    $q('lkContrast').innerHTML = warn.length ? `<div class="msg warn" style="margin-top:12px">${warn.map(esc).join('<br>')}</div>` : '';
    document.querySelectorAll('[data-t]').forEach(c => { c.checked = !!cur[c.dataset.t]; });
    $q('lkFont').value = cur.font; $q('lkFontO').textContent = cur.font + '%';
    document.querySelectorAll('input[name=lkMode]').forEach(r => { r.checked = r.value === cur.display_mode; });
    const dirty = JSON.stringify(cur) !== JSON.stringify(saved);
    $q('lkBar').classList.toggle('dirty', dirty);
    $q('lkState').textContent = dirty ? 'Есть несохранённые изменения' : 'Всё сохранено';
    $q('lkSave').disabled = !dirty;
    $q('lkReset').disabled = JSON.stringify(cur) === JSON.stringify(STANDARD);
    push();
  };
  const set = patch => { Object.assign(cur, patch); sync(); };

  document.querySelectorAll('#lkTheme [data-th]').forEach(b => b.onclick = () => set({ theme: b.dataset.th }));
  document.querySelectorAll('#lkDayNight [data-n]').forEach(b => b.onclick = () => { previewNight = b.dataset.n === '1'; sync(); });
  $q('lkNf').onchange = e => { if (e.target.value) set({ night_from: e.target.value }); else sync(); };
  $q('lkNt').onchange = e => { if (e.target.value) set({ night_to: e.target.value }); else sync(); };
  document.querySelectorAll('#lkPresets [data-p]').forEach(b => b.onclick = () => set({ bg: '', panel: '', text: '', accent: '', ...LOOK_PRESETS[b.dataset.p][1] }));
  // пока человек двигает выбор цвета, обновляем только предпросмотр; запись в настройки — когда выбор закончен
  document.querySelectorAll('input[data-c]').forEach(i => { i.oninput = () => { cur[i.dataset.c] = i.value; push(); }; i.onchange = () => set({ [i.dataset.c]: i.value }); });
  document.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => set({ [b.dataset.reset]: '' }));
  document.querySelectorAll('[data-t]').forEach(c => c.onchange = () => set({ [c.dataset.t]: c.checked }));
  $q('lkFont').oninput = e => { cur.font = Number(e.target.value); $q('lkFontO').textContent = cur.font + '%'; push(); };
  $q('lkFont').onchange = e => set({ font: Number(e.target.value) });
  document.querySelectorAll('input[name=lkMode]').forEach(r => r.onchange = () => set({ display_mode: r.value }));
  $q('lkReset').onclick = () => set({ ...STANDARD });
  $q('lkSave').onclick = async () => {
    const m = $q('lookMsg'), btn = $q('lkSave'); btn.disabled = true;
    try {
      await api('PUT', '/api/admin/settings', { theme: cur.theme, night_from: cur.night_from, night_to: cur.night_to, display_mode: cur.display_mode,
        look_bg: cur.bg, look_panel: cur.panel, look_text: cur.text, look_accent: cur.accent, look_font: cur.font, look_weather: cur.weather, look_bells: cur.bells, look_banners: cur.banners });
      saved = { ...cur }; sync(); msg(m, 'Сохранено. Экраны в холле обновятся в течение минуты.', 'ok'); setTimeout(() => msg(m, ''), 4000);
    } catch (er) { msg(m, er.message); sync(); }
  };
  sync();
}
// старые адреса (#audit, #media, #screens и т. п.) переводим в новые разделы
const LEGACY = { audit: ['system', 'audit'], screens: ['system', 'screens'], users: ['system', 'users'], settings: ['system', 'settings'], help: ['system', 'help'], profile: ['system', 'profile'], media: ['ann', ''],
  calls: ['schedule', 'calls'], look: ['system', 'look'] };
function readHash() {
  const [v, s = ''] = location.hash.slice(1).split('/');
  if (LEGACY[v]) return { v: LEGACY[v][0], s: LEGACY[v][1] };
  return { v: v || 'overview', s };
}
async function render() {
  if (!me) return renderLogin();
  if (me.must_change) { const p = renderPasswordForm(true); $app.innerHTML = `<div class="login"><div style="width:100%;max-width:440px"><h1 style="margin-bottom:14px">Новый пароль</h1>${p.form}</div></div>`; return p.wire(); }
  if (pendingPair) {
    if (!me.can.screens) { const code = pendingPair; pendingPair = ''; return shell('Привязка экрана', `<div class="card"><h2>Привязать экран нельзя</h2><p class="muted" style="margin:6px 0 0">Привязывать экраны может директор, IT-администратор или завуч. Войдите под своей учётной записью или попросите коллегу с доступом. Код на экране: ${esc(code)}</p></div>`); }
    view = 'system'; sub = 'screens';
  }
  const allowed = NAV.filter(n => n[2](me)).map(n => n[0]);
  if (!allowed.includes(view)) view = 'overview';
  try {
    if (view === 'system') {
      const list = sysAllowed();
      const cur = list.find(s => s[0] === sub) || list[0];
      sub = cur[0];
      await cur[3]();
    } else if (view === 'schedule' && sub === 'calls') await viewCalls();
    else await VIEWS[view]();
  } catch (e) { if (me) shell('Ошибка', `<div class="msg err">${esc(e.message)}</div>`); }
}
window.addEventListener('hashchange', () => { const r = readHash(); view = r.v; sub = r.s; render(); });

// ссылка из QR на табло: /admin?pair=КОД — запоминаем код и открываем привязку после входа
let pendingPair = '';
{
  const qp = new URLSearchParams(location.search).get('pair');
  if (qp) { pendingPair = qp.replace(/\D/g, '').slice(0, 6); history.replaceState(null, '', '/admin'); }
}
// сегодняшняя дата по Москве (не по часовому поясу компьютера и не по UTC)
function todayMsk() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()); }
let meTimer = null;
async function boot() {
  try { const st = await (await fetch('/api/state')).json(); brand = { logo: st.logo || '', school: st.schoolName || '' }; } catch { /* нет связи */ }
  try { me = await api('GET', '/api/auth/me'); } catch { me = null; }
  const r = readHash(); view = r.v; sub = r.s;
  render();
  // права и вход проверяем раз в минуту: если роль сменили или вход закрыли, страница обновится сама
  clearInterval(meTimer); // boot() вызывается и после входа, и после смены пароля: таймер должен быть один
  meTimer = setInterval(async () => {
    if (!me) return;
    try {
      const n = await api('GET', '/api/auth/me');
      if (JSON.stringify([n.role, n.must_change, n.can]) !== JSON.stringify([me.role, me.must_change, me.can])) { me = n; render(); }
    } catch { /* нет связи: проверим в следующий раз */ }
  }, 60e3);
}
boot();
