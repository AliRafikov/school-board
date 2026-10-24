// Админка: одностраничное приложение без зависимостей.
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDT = t => t ? new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const ago = t => { if (!t) return 'никогда'; const s = Math.round((Date.now() - t) / 1000); if (s < 60) return 'только что'; if (s < 3600) return Math.floor(s / 60) + ' мин назад'; if (s < 86400) return Math.floor(s / 3600) + ' ч назад'; return fmtDT(t); };

let me = null, view = 'overview', brand = { logo: '', school: '' };

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
const msg = (el, text, kind = 'err') => { el.innerHTML = text ? `<div class="msg ${kind}" role="${kind === 'err' ? 'alert' : 'status'}">${esc(text)}</div>` : ''; };

const ACTIONS = {
  login: 'Вход', login_failed: 'Неудачный вход', logout: 'Выход', password_changed: 'Смена пароля', password_reset: 'Сброс пароля',
  user_created: 'Создан пользователь', user_role_changed: 'Изменена роль', user_renamed: 'Изменено имя', user_enabled: 'Пользователь включён', user_disabled: 'Пользователь отключён',
  settings_changed: 'Изменена настройка', media_uploaded: 'Загружен файл', media_updated: 'Изменён файл', media_deleted: 'Удалён файл', media_reordered: 'Изменён порядок файлов',
  sync_manual: 'Ручная синхронизация', screens_refresh: 'Обновление всех экранов', screen_renamed: 'Переименован экран', first_user: 'Создан первый пользователь',
  lesson_changed: 'Изменён урок', lesson_added: 'Добавлен урок', lesson_removed: 'Убран урок', bell_changed: 'Изменён звонок',
  urgent_started: 'Срочное сообщение', urgent_stopped: 'Срочное сообщение снято', shift_started: 'Сдвиг звонков', shift_reset: 'Сдвиг звонков снят', substitution_added: 'Новая замена', bell_exception_added: 'Звонки на даты', bell_exception_removed: 'Звонки на даты: убрано', substitution_removed: 'Замена убрана', schedule_imported: 'Загружен файл расписания',
  announcement_added: 'Новое объявление', announcement_changed: 'Изменено объявление', announcement_removed: 'Удалено объявление'
};
const FIELD_LABELS = { title: 'название', duration: 'длительность', priority: 'приоритет', date_from: 'дата «с»', date_to: 'дата «по»', break_only: 'только на переменах', active: 'включён', place: 'место показа' };
const detailsRu = r => r.action === 'media_updated' ? 'изменено: ' + String(r.details).split(', ').map(k => FIELD_LABELS[k] || k).join(', ') : r.details;
const SETTING_LABELS = { tz: 'Часовой пояс', change_ttl_hours: 'Сколько часов подсвечивать изменения', board_seconds: 'Секунд на экране с расписанием', school_name: 'Название школы', display_mode: 'Режим экрана' };

// ---------- экран входа ----------
function renderLogin() {
  $app.innerHTML = `<div class="login"><form class="login-card" id="lf">
    <div class="logo-row">${brand.logo ? `<img src="${esc(brand.logo)}" alt="">` : ''}<h1>${esc(brand.school || 'Информационная панель')}</h1></div>
    <p class="muted" style="margin:0">Вход для сотрудников</p>
    <label class="f">Логин<input type="text" id="lg" autocomplete="username" autocapitalize="none" required autofocus></label>
    <label class="f">Пароль<input type="password" id="pw" autocomplete="current-password" required></label>
    <div id="lm"></div>
    <button class="btn primary" type="submit">Войти</button></form></div>`;
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
const NAV = [['overview', 'Обзор', () => true], ['schedule', 'Расписание', m => m.can.schedule], ['subs', 'Замены', m => m.can.subs], ['ann', 'Объявления', m => m.can.announcements],
  ['audit', 'Журнал изменений', m => m.can.audit], ['media', 'Постеры и ролики', m => m.can.media],
  ['screens', 'Экраны', m => m.can.screens], ['users', 'Пользователи', m => m.can.users], ['settings', 'Настройки', m => m.can.settings], ['help', 'Справка', () => true], ['profile', 'Мой пароль', () => true]];

function shell(title, bodyHtml, actionsHtml = '') {
  $app.innerHTML = `<div class="shell"><aside class="side">
    <div class="logo-row">${brand.logo ? `<img src="${esc(brand.logo)}" alt="">` : ''}<span>${esc(brand.school)}</span></div>
    <nav class="nav" aria-label="Разделы">${NAV.filter(n => n[2](me)).map(n => `<a href="#${n[0]}" ${n[0] === view ? 'aria-current="page"' : ''}>${n[1]}</a>`).join('')}</nav>
    <div class="me"><div><b>${esc(me.name)}</b><div class="muted small">${esc(me.role_label)}</div></div><button class="btn sm" id="lo">Выйти</button></div>
  </aside><main class="main"><header><h1>${esc(title)}</h1><div class="row">${actionsHtml}</div></header><div id="view">${bodyHtml}</div></main></div>`;
  document.getElementById('lo').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch {} me = null; render(); };
}

// ---------- обзор ----------
async function viewOverview() {
  const o = await api('GET', '/api/admin/overview');
  const s = o.sync;
  shell('Обзор', `
    ${o.counts.lessons === 0 ? '<div class="msg warn" style="margin-bottom:16px">Расписание ещё не загружено. Откройте раздел «Расписание» и загрузите файл Excel.</div>' : ''}
    ${s.lastInfo ? `<div class="msg" style="margin-bottom:16px;font-size:14px">В базе: ${esc(s.lastInfo)}</div>` : ''}
    <div class="grid">
      <div class="stat"><div class="v">${o.counts.lessons}</div><div class="l">уроков в расписании</div></div>
      <div class="stat"><div class="v">${o.counts.bells}</div><div class="l">звонков и перемен</div></div>
      <div class="stat"><div class="v">${o.counts.subs}</div><div class="l">замен на сегодня и дальше</div></div>
      <div class="stat"><div class="v">${o.counts.screens} из ${o.counts.screens_total}</div><div class="l">экранов на связи</div></div>
      <div class="stat"><div class="v">${o.counts.media}</div><div class="l">файлов в показе</div></div>
      <div class="stat"><div class="v">${o.counts.users}</div><div class="l">пользователей</div></div>
    </div>
    <div class="card"><h2>Последние действия</h2>${auditTable(o.recent)}</div>`,
    me.can.screens ? '<button class="btn primary" id="bRef">Обновить все экраны</button>' : '');
  const b = document.getElementById('bRef');
  if (b) b.onclick = async () => { b.disabled = true; try { await api('POST', '/api/admin/refresh-screens'); b.textContent = 'Отправлено'; setTimeout(render, 900); } catch (e) { alert(e.message); b.disabled = false; } };
}

function auditTable(rows) {
  if (!rows.length) return '<p class="muted">Записей нет</p>';
  return `<div class="tbl-wrap"><table><thead><tr><th>Когда</th><th>Кто</th><th>Что</th><th>Где</th><th>Было → стало</th></tr></thead><tbody>${rows.map(r => {
    const what = r.action === 'settings_changed' ? 'Изменена настройка: ' + (SETTING_LABELS[r.target] || r.target) : (ACTIONS[r.action] || r.action);
    const tgt = r.action === 'settings_changed' ? '' : r.target;
    return `<tr><td class="num">${fmtDT(r.at)}</td><td>${esc(r.user_name || '—')}<div><span class="src">${({ admin: 'Админка', system: 'Система' })[r.source] || r.source}</span></div></td>
      <td>${esc(what)}</td><td>${esc(tgt)}${r.details ? `<div class="muted small">${esc(detailsRu(r))}</div>` : ''}${r.action.startsWith('substitution') && /^\d{4}-/.test(r.details || '') ? `<div class="muted small">на ${esc(r.details.split('-').reverse().join('.'))}</div>` : ''}</td>
      <td>${r.was ? `<span class="was">${esc(r.was)}</span>` : ''}${r.was && r.now ? ' → ' : ''}${r.now ? `<span class="now">${esc(r.now)}</span>` : ''}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

// ---------- журнал ----------
const auditState = { source: '', q: '', hide: true, rows: [], total: 0 };
async function viewAudit() {
  shell('Журнал изменений', `<div class="card"><div class="row">
    <label class="f" style="min-width:160px">Источник<select id="fs"><option value="">Все</option><option value="admin">Действия в админке</option><option value="system">Система</option></select></label>
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
async function viewMedia() {
  const items = await api('GET', '/api/admin/media');
  const kindLabel = { image: 'Картинка', video: 'Видео', pdf: 'Презентация' };
  shell('Постеры и ролики', `
    <div class="card"><label class="drop" id="drop" for="fileIn">Перетащите сюда файлы или нажмите, чтобы выбрать<br><span class="small">JPG, PNG, PDF, MP4 (видео до 30 МБ, H.264). </span></label>
      <label class="f" style="margin-top:10px;max-width:320px">Куда поставить новые файлы<select id="placeSel"><option value="screen">На весь экран (постеры, ролики)</option><option value="center">В центре экрана</option><option value="banner">Маленький баннер с QR-кодом</option></select></label>
      <input type="file" id="fileIn" accept=".jpg,.jpeg,.png,.pdf,.mp4,image/jpeg,image/png,application/pdf,video/mp4" multiple hidden><div id="um" style="margin-top:10px"></div></div>
    <p class="muted small">Файл можно поставить на весь экран, в центр или в маленький баннер с QR-кодом. Видео проигрывается без звука. Текстовые объявления — в разделе «Объявления».</p>
    <div id="list">${items.map(m => `
      <div class="card media" data-id="${m.id}">
        <div class="thumb">${m.kind === 'image' ? `<img src="${esc(m.url)}" alt="">` : m.kind === 'video' ? `<video src="${esc(m.url)}#t=0.5" muted preload="metadata"></video>` : 'PDF'}</div>
        <div class="fields">
          <label class="f wide">Название<input type="text" data-k="title" value="${esc(m.title)}" maxlength="120"></label>
          <label class="f">${m.kind === 'video' ? 'Длительность ролика, сек (ролик идёт до конца)' : 'Секунд на экране'}<input type="number" data-k="duration" min="3" max="600" value="${m.duration}"></label>
          <label class="f">Приоритет (1–5)<input type="number" data-k="priority" min="1" max="5" value="${m.priority}"></label>
          <label class="f">Показывать с<input type="date" data-k="date_from" value="${esc(m.date_from)}"></label>
          <label class="f">Показывать по<input type="date" data-k="date_to" value="${esc(m.date_to)}"></label>
          <label class="f">Где показывать<select data-k="place">${[['screen', 'На весь экран'], ['center', 'В центре экрана'], ['banner', 'Маленький баннер (QR)']].map(([v, l]) => `<option value="${v}"${m.place === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="check"><input type="checkbox" data-k="break_only" ${m.break_only ? 'checked' : ''}> Только на переменах</label>
          <label class="check"><input type="checkbox" data-k="active" ${m.active ? 'checked' : ''}> Включено</label>
          <div class="wide row"><span class="muted small">${kindLabel[m.kind]} · ${Math.round(m.size / 1024)} КБ · ${esc(m.created_by || '')}, ${fmtDT(m.created_at)}</span>
            <span style="flex:1"></span><button class="btn sm" data-a="up">↑</button><button class="btn sm" data-a="down">↓</button>
            <button class="btn sm primary" data-a="save">Сохранить</button><button class="btn sm danger" data-a="del">Удалить</button></div>
          <div class="wide" data-m></div>
        </div></div>`).join('') || '<div class="card muted">Файлов пока нет. Загрузите первый постер.</div>'}</div>`);
  const um = document.getElementById('um'), drop = document.getElementById('drop'), inp = document.getElementById('fileIn');
  // длину видео узнаём в браузере: он читает заголовок файла без загрузки
  const videoSeconds = f => new Promise(res => { const v = document.createElement('video'); v.preload = 'metadata';
    v.onloadedmetadata = () => { URL.revokeObjectURL(v.src); res(Math.round(v.duration) || 0); };
    v.onerror = () => res(0); v.src = URL.createObjectURL(f); });
  const upload = async files => {
    for (const f of files) {
      msg(um, `Загрузка: ${f.name}…`, 'ok');
      const headers = { 'X-File-Name': encodeURIComponent(f.name), 'X-Place': document.getElementById('placeSel').value, 'Content-Type': 'application/octet-stream' };
      if (/\.mp4$/i.test(f.name)) headers['X-Duration'] = String(await videoSeconds(f));
      try { await api('POST', '/api/admin/media/upload', f, headers); }
      catch (e) { msg(um, `${f.name}: ${e.message}`); return; }
    }
    render();
  };
  inp.onchange = () => upload([...inp.files]);
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
        await api('PATCH', '/api/admin/media/' + id, body); msg(m, 'Сохранено', 'ok'); setTimeout(() => msg(m, ''), 2000);
      } else if (a === 'del') {
        if (btn.dataset.sure !== '1') { btn.dataset.sure = '1'; btn.textContent = 'Точно удалить?'; setTimeout(() => { btn.dataset.sure = ''; btn.textContent = 'Удалить'; }, 4000); return; }
        await api('DELETE', '/api/admin/media/' + id); render();
      } else {
        const cards = [...document.querySelectorAll('.media')], i = cards.indexOf(card), j = a === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= cards.length) return;
        const order = cards.map(c => Number(c.dataset.id)); [order[i], order[j]] = [order[j], order[i]];
        await api('POST', '/api/admin/media/reorder', { ids: order }); render();
      }
    } catch (err) { msg(m, err.message); }
  };
}

// ---------- экраны ----------
async function viewScreens() {
  const rows = await api('GET', '/api/admin/screens');
  shell('Экраны', `<div class="card"><p class="muted" style="margin-top:0">Экран сообщает о себе раз в минуту. Если связи нет больше трёх минут, он помечается как «не на связи». Без интернета экран продолжает показывать сохранённые данные.</p>
    <div class="tbl-wrap"><table><thead><tr><th>Название</th><th>Состояние</th><th>Последний сигнал</th><th>Версия данных</th><th>Устройство</th></tr></thead><tbody>
    ${rows.map(r => { const on = Date.now() - r.last_seen < 180000; return `<tr><td><input type="text" value="${esc(r.name || '')}" placeholder="${esc(r.id)}" data-id="${esc(r.id)}" style="max-width:220px"></td>
      <td>${on ? '<span class="pill ok">на связи</span>' : '<span class="pill bad">не на связи</span>'}</td><td class="num">${esc(ago(r.last_seen))}</td><td class="muted small">${esc(r.version)}</td><td class="muted small">${esc((r.ua || '').slice(0, 60))}<br>${esc(r.ip || '')}</td></tr>`; }).join('') || '<tr><td colspan="5" class="muted">Ни один экран ещё не подключался. Откройте адрес /tv на телевизоре.</td></tr>'}
    </tbody></table></div></div>`, '<button class="btn primary" id="bRef">Обновить все экраны</button>');
  document.getElementById('bRef').onclick = async e => { e.target.disabled = true; try { await api('POST', '/api/admin/refresh-screens'); e.target.textContent = 'Отправлено'; } catch (er) { alert(er.message); } };
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
      <label class="f">Роль<select id="nr">${roleOpts('zavuch')}</select></label>
      <button class="btn primary" type="submit">Создать</button></form><div id="nm" style="margin-top:10px"></div>
      <p class="muted small" style="margin-bottom:0">Директор: всё. IT-администратор: пользователи, настройки, экраны, файлы. Завуч: файлы, обновление экранов, журнал. Просмотр: только обзор и журнал.</p></div>
    <div class="card"><div class="tbl-wrap"><table><thead><tr><th>Имя и логин</th><th>Роль</th><th>Состояние</th><th>Последний вход</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr data-id="${u.id}"><td><b>${esc(u.name)}</b><div class="muted small">${esc(u.login)}</div></td>
      <td><select data-f="role">${roleOpts(u.role)}</select></td>
      <td>${u.active ? '<span class="pill ok">активен</span>' : '<span class="pill off">отключён</span>'}${u.must_change ? ' <span class="pill off">пароль не сменён</span>' : ''}</td>
      <td class="num">${fmtDT(u.last_login)}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-a="reset">Сбросить пароль</button> <button class="btn sm ${u.active ? 'danger' : ''}" data-a="toggle">${u.active ? 'Отключить' : 'Включить'}</button></td></tr>`).join('')}
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
      <li><b>Просмотр</b> — обзор и журнал.</li>
    </ul>

    <h2>Постоянное расписание</h2>
    <ul>
      <li>Меняется только загрузкой нового большого Excel-файла (.xlsx) на вкладке «Расписание». Листы: «Расписание» и «Звонки».</li>
      <li>Сначала показывается проверка: что изменится, что стоит проверить. Записывается только после кнопки «Записать расписание».</li>
      <li>Даты, которые Excel превратил из времени (12.10 → 12 октября), исправляются сами.</li>
    </ul>

    <h2>Звонки на дату</h2>
    <p>Раздел «Замены», карточка «Звонки на дату». Выберите дату или промежуток дат, поправьте время в строке звонка или отметьте «отменён». Обычные звонки не меняются, после этих дат всё возвращается по расписанию. Отменённый урок на экране подсвечивается красным.</p>

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
      <li>Картинки (JPG, PNG), презентации (PDF) и видео (MP4 до 30 МБ) загружаются в «Постеры и ролики».</li>
      <li><b>Где показывать</b>: на весь экран, в центре экрана или маленьким баннером. Маленький баннер может быть картинкой или видео. Видео всегда идёт без звука, зациклено.</li>
      <li><b>Длительность видео</b> определяется при загрузке. Ролик на весь экран идёт до конца.</li>
      <li><b>Только на переменах</b> — файл на весь экран не показывается на уроках.</li>
    </ul>

    <h2>Срочное сообщение</h2>
    <p>Во вкладке «Объявления» сверху. Текст появляется поверх всего на всех экранах на выбранное время (5–120 минут) и закрывает расписание и постеры. Снять раньше можно кнопкой «Снять сообщение». В журнале записывается, кто и когда его включил.</p>

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
async function viewSettings() {
  const s = await api('GET', '/api/admin/settings');
  shell('Настройки', `<form class="card" id="sf" style="display:grid;gap:14px;max-width:640px">
    <label class="f">Название школы на экране<input type="text" id="s2" value="${esc(s.school_name)}" maxlength="80"></label>
    <div class="row"><label class="f">Секунд на экране с расписанием между роликами<input type="number" id="s3" min="10" max="600" value="${esc(s.board_seconds)}"></label>
    <label class="f">Часов подсвечивать изменения<input type="number" id="s4" min="1" max="168" value="${esc(s.change_ttl_hours)}"></label></div>
    <label class="f">Режим экрана<select id="s6">
      <option value="auto" ${(s.display_mode || 'auto') === 'auto' ? 'selected' : ''}>Авто: на уроках статично (логотип и QR-баннеры), на переменах как обычно</option>
      <option value="static" ${s.display_mode === 'static' ? 'selected' : ''}>Всегда статично: логотип и QR-баннеры, ролики и постеры не идут (гости, мероприятия)</option>
      <option value="active" ${s.display_mode === 'active' ? 'selected' : ''}>Всегда активно: ролики и постеры идут и на уроках</option>
    </select></label>
    <label class="f">Тема экрана<select id="s7">
      <option value="auto" ${(s.theme || 'auto') === 'auto' ? 'selected' : ''}>Авто: днём светлая, ночью чёрный экран только с временем и логотипом</option>
      <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Светлая весь день (ночного экрана нет)</option>
      <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Тёмная весь день (ночного экрана нет)</option>
    </select></label>
    <div class="row"><label class="f">Ночь с<input type="text" id="s8" value="${esc(s.night_from || '21:00')}" placeholder="21:00" style="width:110px"></label>
    <label class="f">Ночь до<input type="text" id="s9" value="${esc(s.night_to || '07:00')}" placeholder="07:00" style="width:110px"></label></div>
    <label class="f">Часовой пояс<input type="text" id="s5" value="${esc(s.tz)}" placeholder="Europe/Moscow"></label>
    <div id="sm"></div><div><button class="btn primary" type="submit">Сохранить</button></div></form>`);
  document.getElementById('sf').onsubmit = async e => {
    e.preventDefault(); const m = document.getElementById('sm');
    try { await api('PUT', '/api/admin/settings', { school_name: document.getElementById('s2').value, board_seconds: document.getElementById('s3').value, change_ttl_hours: document.getElementById('s4').value, display_mode: document.getElementById('s6').value, tz: document.getElementById('s5').value, theme: document.getElementById('s7').value, night_from: document.getElementById('s8').value.trim(), night_to: document.getElementById('s9').value.trim() });
      msg(m, 'Сохранено', 'ok'); }
    catch (er) { msg(m, er.message); }
  };
}

function viewProfile() { const p = renderPasswordForm(false); shell('Мой пароль', p.form); p.wire(); }

// ---------- расписание: большой файл и звонки на даты ----------
const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
async function viewSchedule() {
  const d = await api('GET', '/api/admin/schedule');
  const canEdit = me.can.schedule;
  shell('Расписание', `
    <div class="card"><h2>Сдвиг звонков на сегодня</h2>
      <p class="muted small" style="margin-top:0">Для случая, когда занятия возобновляются позже (например, после тревоги). Выберите урок, с которого возобновляем, и на сколько минут сдвинуть. Уроки до него не меняются. С выбранного урока сдвигаются его начало и конец, все перемены после него и конец дня. Действует только сегодня. Сам не возвращается: снимите кнопкой «Вернуть».</p>
      <div id="shiftNow"></div>
      <div class="row" style="align-items:flex-end">
        <label class="f">С какого урока<select id="shFrom">${[...new Set(d.bells.filter(b => !b.meal).map(b => b.n))].sort((a, b) => a - b).map(n => `<option value="${n}">Урок ${n}</option>`).join('')}</select></label>
        <label class="f">На сколько минут<input type="number" id="shMin" min="1" max="120" value="30" style="width:110px"></label>
        <button class="btn primary" id="shGo" type="button">Сдвинуть звонки</button>
      </div>
      <div id="shMsg" style="margin-top:8px"></div></div>
    <div class="card" id="impCard"><h2>Постоянное расписание: загрузить новый файл</h2>
      <p class="muted small" style="margin-top:0">Постоянное расписание меняется только загрузкой нового большого Excel-файла (.xlsx). Листы: «Расписание» (сетка уроков) и «Звонки» (время уроков, завтрак, обед). Сначала система покажет, что изменится, и только после подтверждения запишет данные. Замены на отдельные дни — в разделе «Замены».</p>
      <div class="row"><label class="f" style="flex:1;min-width:240px">Файл<input type="file" id="xf" accept=".xlsx"></label>
        <button class="btn" id="xr" type="button">Проверить файл</button></div>
      <div id="xres" style="margin-top:12px"></div></div>
`);
  if (!canEdit) document.querySelectorAll('button').forEach(b => { if (b.id !== 'xr') b.disabled = true; });
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
  if (shOff) shOff.onclick = async () => { try { await api('PUT', '/api/admin/shift', { reset: true }); render(); } catch (er) { msg(shMsg, er.message); } };
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
}

// ---------- замены ----------
// Что показываем на дате: постоянное расписание + замены этой даты (как на экране)
const dayIndexOf = iso => { const w = new Date(iso + 'T12:00:00').getDay(); return w === 0 ? -1 : w - 1; };
const lessonNumsOf = str => { const out = []; String(str || '').split(',').forEach(part => { const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part); if (m) { for (let i = +m[1]; i <= +m[2]; i++) out.push(i); } else if (/^\s*\d+\s*$/.test(part)) out.push(+part); }); return out; };

async function viewSubs() {
  const [rows, sch] = await Promise.all([api('GET', '/api/admin/subs'), api('GET', '/api/admin/schedule')]);
  const dRange = (a, b) => a.split('-').reverse().join('.') + (b !== a ? ' – ' + b.split('-').reverse().join('.') : '');
  const exRowsList = (sch.exceptions || []).map(x => `<tr data-id="${x.id}"><td>${x.meal ? esc(x.title) : 'Урок ' + x.n}</td><td>${dRange(x.date_from, x.date_to)}</td><td>${x.cancelled ? 'урок отменён' : esc(x.start) + '–' + esc(x.end)}</td><td><button class="btn sm danger" data-bx="del" type="button">Убрать</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Изменений звонков нет</td></tr>';
  const groups = new Map();
  for (const r of rows) {
    const k = [r.date, r.lessons, r.subject, r.room, r.teacher, r.absent, r.note].join('|');
    if (!groups.has(k)) groups.set(k, { ids: [], date: r.date, lessons: r.lessons, subject: r.subject, room: r.room, teacher: r.teacher, absent: r.absent, note: r.note, cls: [] });
    const g = groups.get(k); g.ids.push(r.id); g.cls.push(r.cls);
  }
  const list = [...groups.values()];
  const today = new Date().toISOString().slice(0, 10);
  shell('Замены', `
    <div class="card" id="fileCard"><h2>Файл замен от завуча</h2>
      <p class="muted small" style="margin-top:0">Файл Excel (.xlsx), лист «Замены» или первый лист. Колонки: Урок, Класс, Предмет, Кабинет, Ответственный учитель, Отсутствует, Примечание. Дата — в строке заголовка блока (например «Замена кабинетов на 17.10.2026»). Номер урока «1-6» или «1, 3» сопоставляется с классами по порядку. «8аб» — один урок для 8А и 8Б. Перед записью показываем проверку. Записываются только даты из файла: замены этих дат, загруженные из файла раньше, заменяются; ручные остаются.</p>
      <div class="row"><label class="f" style="flex:1;min-width:240px">Файл<input type="file" id="sfile" accept=".xlsx"></label>
        <button class="btn" id="sfr" type="button">Проверить файл</button></div>
      <div id="sfres" style="margin-top:12px"></div></div>
    <div class="card"><h2>Изменения на дату</h2>
      <p class="muted small" style="margin-top:0">Выберите дату и измените нужные ячейки: предмет, кабинет, учителя. Меняется только эта дата, постоянное расписание не трогается. Чтобы отменить урок у класса, напишите в предмете «отменён». Пустые ячейки не меняются.</p>
      <div class="row"><label class="f">Дата<input type="date" id="dayDate" value="${today}"></label></div>
      <div class="tbl-wrap" style="margin-top:12px"><table class="lessons" id="dayTbl"></table></div>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="daySave" type="button">Сохранить изменения на дату</button></div>
      <div id="dayMsg" style="margin-top:8px"></div></div>
    <div class="card"><h2>Звонки на дату</h2>
      <p class="muted small" style="margin-top:0">Выберите дату (или промежуток дат). В строке поправьте время или отметьте «отменён» (урок или перемену: завтрак, обед). Меняется только выбранный период, обычные звонки не трогаются. Пустые строки не меняются.</p>
      <div class="row"><label class="f">С даты<input type="date" id="bellFrom"></label><label class="f">По дату<input type="date" id="bellTo"></label><button class="btn" id="bellLoad" type="button">Показать звонки</button></div>
      <div class="tbl-wrap" style="margin-top:12px"><table class="lessons" id="bellTbl"></table></div>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="bellSave" type="button">Сохранить звонки на период</button></div>
      <div id="bellMsg" style="margin-top:8px"></div>
      <h3 style="margin:18px 0 8px;font-size:15px">Изменения звонков, которые уже действуют</h3>
      <div class="tbl-wrap"><table class="lessons" id="bxTbl"><thead><tr><th>Звонок</th><th>Даты</th><th>Что</th><th></th></tr></thead><tbody>${exRowsList}</tbody></table></div></div>
    <div class="card"><h2>Одна замена вручную</h2>
      <form class="row" id="sf2">
        <label class="f">Дата<input type="date" id="sd" required></label>
        <label class="f">Уроки<input type="text" id="sl" placeholder="3 или 1-6" maxlength="20" style="width:110px"></label>
        <label class="f" style="flex:1;min-width:200px">Классы<input type="text" id="sc" placeholder="8А, 8Б, 5Б" required></label>
        <label class="f" style="flex:1;min-width:200px">Предмет (если меняется)<input type="text" id="ss" placeholder="пусто — как в расписании" maxlength="120"></label>
        <label class="f">Кабинет<input type="text" id="sr" maxlength="40" style="width:110px"></label>
        <label class="f" style="flex:1;min-width:180px">Учитель<input type="text" id="st" maxlength="80"></label>
        <label class="f" style="flex:1;min-width:180px">Отсутствует<input type="text" id="sa" maxlength="80"></label>
        <label class="f" style="flex:1;min-width:180px">Примечание<input type="text" id="sn" maxlength="120"></label>
        <button class="btn" type="submit">Добавить</button></form><div id="sm2" style="margin-top:10px"></div></div>
    <div class="card"><h2>Замены (последние 400)</h2>
      ${list.length ? `<div class="tbl-wrap"><table><thead><tr><th>Дата</th><th>Уроки</th><th>Классы</th><th>Предмет</th><th>Кабинет</th><th>Учитель</th><th>Вместо</th><th></th></tr></thead><tbody>
        ${list.map(g => `<tr><td class="num">${esc(g.date.split('-').reverse().join('.'))}</td><td class="num">${esc(g.lessons)}</td><td>${esc(g.cls.join(', '))}</td><td>${esc(g.subject)}${g.note ? `<div class="muted small">${esc(g.note)}</div>` : ''}</td><td>${esc(g.room)}</td><td>${esc(g.teacher)}</td><td>${esc(g.absent)}</td>
          <td>${me.can.subs ? `<button class="btn sm danger" data-ids="${g.ids.join(',')}">Убрать</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Замен пока нет.</p>'}</div>`);

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

  // --- изменения на дату: таблица урок × класс ---
  const dayTbl = document.getElementById('dayTbl'), dayMsg = document.getElementById('dayMsg');
  const drawDay = () => {
    const date = document.getElementById('dayDate').value;
    dayMsg.innerHTML = '';
    if (!date) { dayTbl.innerHTML = ''; return; }
    const di = dayIndexOf(date);
    if (di < 0) { dayTbl.innerHTML = '<tr><td class="muted">В воскресенье уроков нет. Выберите другой день.</td></tr>'; return; }
    // эффективные значения на дату = постоянное расписание + уже сохранённые замены этой даты
    const eff = {};
    for (const l of sch.lessons.filter(x => x.day === di)) eff[l.cls + '|' + l.n] = { subject: l.subject || '', room: l.room || '', teacher: l.teacher || '' };
    for (const r of rows.filter(x => x.date === date)) for (const n of lessonNumsOf(r.lessons)) {
      const k = r.cls + '|' + n, cur = eff[k] || { subject: '', room: '', teacher: '' };
      eff[k] = { subject: r.subject || cur.subject, room: r.room || cur.room, teacher: r.teacher || cur.teacher };
    }
    const maxN = Math.max(6, ...Object.keys(eff).map(k => +k.split('|')[1]));
    const inp = (v, k, w, ph) => `<input data-k="${k}" data-o="${esc(v)}" value="${esc(v)}" placeholder="${ph}" style="width:${w}">`;
    dayTbl.innerHTML = `<thead><tr><th>№</th>${sch.classes.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
      [...Array(maxN).keys()].map(i => i + 1).map(n => `<tr data-n="${n}"><td class="num">${n}</td>${sch.classes.map(c => {
        const l = eff[c + '|' + n] || {};
        return `<td data-cls="${esc(c)}">${inp(l.subject || '', 'subject', '150px', '—')}<div class="row" style="gap:4px;margin-top:3px">${inp(l.room || '', 'room', '58px', 'каб.')}${inp(l.teacher || '', 'teacher', '86px', 'учитель')}</div></td>`;
      }).join('')}</tr>`).join('')}</tbody>`;
  };
  document.getElementById('dayDate').onchange = drawDay;
  drawDay();
  document.getElementById('daySave').onclick = async () => {
    const date = document.getElementById('dayDate').value;
    const items = [];
    dayTbl.querySelectorAll('tbody tr').forEach(tr => {
      const n = Number(tr.dataset.n);
      tr.querySelectorAll('td[data-cls]').forEach(td => {
        const g = k => td.querySelector(`[data-k=${k}]`);
        if (['subject', 'room', 'teacher'].some(k => g(k).value.trim() !== (g(k).dataset.o || '').trim()))
          items.push({ cls: td.dataset.cls, n, subject: g('subject').value.trim(), room: g('room').value.trim(), teacher: g('teacher').value.trim() });
      });
    });
    if (!date) return msg(dayMsg, 'Выберите дату');
    if (!items.length) return msg(dayMsg, 'Ничего не изменено');
    try { const r = await api('PUT', '/api/admin/subs/day', { date, items }); msg(dayMsg, `Сохранено ячеек: ${r.saved}. Изменения видны на экране в течение 15 секунд`, 'ok'); setTimeout(render, 900); }
    catch (er) { msg(dayMsg, er.message); }
  };

  // --- звонки на дату: таблица звонков и сохранение на период ---
  const bellTbl = document.getElementById('bellTbl'), bellMsg = document.getElementById('bellMsg');
  const bellsSorted = sch.bells.slice().sort((a, b) => (a.start || '').localeCompare(b.start || ''));
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
  document.getElementById('bxTbl').onclick = async e => {
    const b = e.target.closest('button[data-bx=del]'); if (!b) return;
    try { await api('DELETE', '/api/admin/schedule/bell-exceptions/' + b.closest('tr').dataset.id); render(); } catch (er) { msg(bellMsg, er.message); }
  };
  drawBells();

  // --- одна замена вручную ---
  document.getElementById('sd').value = today;
  document.getElementById('sf2').onsubmit = async e => {
    e.preventDefault(); const m = document.getElementById('sm2');
    try { await api('POST', '/api/admin/subs', { date: document.getElementById('sd').value, lessons: document.getElementById('sl').value, classes: document.getElementById('sc').value, subject: document.getElementById('ss').value, room: document.getElementById('sr').value, teacher: document.getElementById('st').value, absent: document.getElementById('sa').value, note: document.getElementById('sn').value }); render(); }
    catch (er) { msg(m, er.message); }
  };
  document.querySelector('#view').onclick = async e => {
    const b = e.target.closest('button[data-ids]'); if (!b) return;
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Точно убрать?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Убрать'; }, 4000); return; }
    try { await api('DELETE', '/api/admin/subs', { ids: b.dataset.ids.split(',').map(Number) }); render(); } catch (er) { alert(er.message); }
  };
}

// ---------- объявления ----------
async function viewAnn() {
  const rows = await api('GET', '/api/admin/announcements');
  const urgent = await api('GET', '/api/admin/urgent');
  const hrs = urgent.item && urgent.item.since ? (Date.now() - urgent.item.since) / 3600e3 : 0;
  const t2 = ts => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  shell('Объявления', `
    <div class="card"><h2>Срочное сообщение на все экраны</h2>
      <p class="muted small" style="margin-top:0">Нажмите готовый вариант — он сразу появится на всех телевизорах поверх расписания, постеров и ночного экрана. Сообщение висит, пока его не снимут: время окончания никто не угадает. Снимает тот, кто включил, или директор.</p>
      ${urgent.active ? `<div class="msg warn" style="margin-bottom:10px"><b>Сейчас на экранах:</b> «${esc(urgent.item.title)}»${urgent.item.source ? `, источник: ${esc(urgent.item.source)}` : ''}, включено в ${t2(urgent.item.since)}.
        ${hrs >= 2 ? `<br><b>Сообщение висит уже ${Math.floor(hrs)} ч. Проверьте, актуально ли оно, и снимите его.</b>` : ''}
        <div class="row" style="margin-top:8px"><button class="btn" id="uOff" type="button">Снять сообщение</button></div></div>` : ''}
      <div class="row" style="gap:10px">
        ${urgent.presets.map(p => `<button class="btn danger" data-preset="${esc(p.id)}" type="button" style="padding:14px 18px;font-size:15px">${esc(p.title)}</button>`).join('')}
      </div>
      <details style="margin-top:14px"><summary class="muted small">Другой текст</summary>
        <div class="row" style="align-items:flex-end;margin-top:8px">
          <label class="f" style="flex:1;min-width:280px">Заголовок<input type="text" id="ut" maxlength="120" placeholder="Например: Эвакуация"></label>
          <label class="f" style="min-width:200px">Источник<input type="text" id="us" maxlength="80" value="МЧС России"></label>
          <label class="f" style="flex:1;min-width:280px">Пояснение<input type="text" id="un" maxlength="200" placeholder="Что делать"></label>
          <button class="btn danger" id="uOn" type="button">Показать на экранах</button>
        </div></details>
      <div id="um2" style="margin-top:8px"></div></div>
    <div class="card"><h2>Новое объявление</h2><p class="muted small" style="margin-top:0">Текст показывается в центре экрана, между расписанием и постерами. Строка для ролика или картинки — в разделе «Постеры и ролики».</p>
      <form class="row" id="af">
        <label class="f" style="flex:1;min-width:320px">Текст<input type="text" id="at" required maxlength="300" placeholder="Родительское собрание — в четверг в 18:00, актовый зал"></label>
        <label class="f">Секунд<input type="number" id="ad" min="3" max="600" value="10" style="width:90px"></label>
        <label class="f">Приоритет (1–5)<input type="number" id="ap" min="1" max="5" value="1" style="width:90px"></label>
        <label class="f">С даты<input type="date" id="af1"></label>
        <label class="f">По дату<input type="date" id="af2"></label>
        <button class="btn primary" type="submit">Добавить</button></form><div id="am" style="margin-top:10px"></div></div>
    <div class="card">${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>Текст</th><th>Секунд</th><th>Приоритет</th><th>С</th><th>По</th><th>Включено</th><th></th></tr></thead><tbody>
      ${rows.map(a => `<tr data-id="${a.id}"><td><input type="text" data-k="title" value="${esc(a.title)}" maxlength="300" style="min-width:260px"></td>
        <td><input type="number" data-k="duration" min="3" max="600" value="${a.duration}" style="width:80px"></td>
        <td><input type="number" data-k="priority" min="1" max="5" value="${a.priority}" style="width:70px"></td>
        <td><input type="date" data-k="date_from" value="${esc(a.date_from)}"></td><td><input type="date" data-k="date_to" value="${esc(a.date_to)}"></td>
        <td><input type="checkbox" data-k="active" ${a.active ? 'checked' : ''}></td>
        <td style="white-space:nowrap"><button class="btn sm primary" data-a="save" type="button">Сохранить</button> <button class="btn sm danger" data-a="del" type="button">Удалить</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Объявлений пока нет.</p>'}<div id="al" style="margin-top:8px"></div></div>`);
  const um2 = document.getElementById('um2');
  const sendUrgent = async body => {
    try { await api('PUT', '/api/admin/urgent', body); msg(um2, 'Сообщение отправлено на экраны', 'ok'); setTimeout(render, 600); }
    catch (er) { msg(um2, er.message); }
  };
  document.querySelectorAll('button[data-preset]').forEach(btn => btn.onclick = () => {
    const title = btn.textContent.trim();
    if (!confirm(`Показать на всех экранах: «${title}»?`)) return;
    sendUrgent({ preset: btn.dataset.preset });
  });
  document.getElementById('uOn').onclick = () => {
    const title = document.getElementById('ut').value.trim();
    if (!title) return msg(um2, 'Напишите заголовок сообщения');
    if (!confirm(`Показать на всех экранах: «${title}»?`)) return;
    sendUrgent({ title, source: document.getElementById('us').value.trim(), note: document.getElementById('un').value.trim() });
  };
  const uo = document.getElementById('uOff');
  if (uo) uo.onclick = async () => { try { await api('PUT', '/api/admin/urgent', { title: '' }); render(); } catch (er) { msg(um2, er.message); } };
  document.getElementById('af').onsubmit = async e => {
    e.preventDefault(); const m = document.getElementById('am');
    try { await api('POST', '/api/admin/announcements', { title: document.getElementById('at').value, duration: document.getElementById('ad').value, priority: document.getElementById('ap').value, date_from: document.getElementById('af1').value, date_to: document.getElementById('af2').value }); render(); }
    catch (er) { msg(m, er.message); }
  };
  const al = document.getElementById('al');
  document.querySelector('#view').onclick = async e => {
    const b = e.target.closest('button[data-a]'); if (!b) return; const tr = b.closest('tr[data-id]'); if (!tr) return;
    const id = tr.dataset.id;
    try {
      if (b.dataset.a === 'save') {
        const body = {}; tr.querySelectorAll('[data-k]').forEach(i => { body[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value; });
        await api('PATCH', '/api/admin/announcements/' + id, body); msg(al, 'Сохранено', 'ok'); setTimeout(() => msg(al, ''), 1500);
      } else {
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Точно удалить?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Удалить'; }, 4000); return; }
        await api('DELETE', '/api/admin/announcements/' + id); render();
      }
    } catch (er) { msg(al, er.message); }
  };
}

// ---------- запуск ----------
const VIEWS = { overview: viewOverview, schedule: viewSchedule, subs: viewSubs, ann: viewAnn, audit: viewAudit, media: viewMedia, screens: viewScreens, users: viewUsers, settings: viewSettings, help: viewHelp, profile: viewProfile };
async function render() {
  if (!me) return renderLogin();
  if (me.must_change) { const p = renderPasswordForm(true); $app.innerHTML = `<div class="login"><div style="width:100%;max-width:440px"><h1 style="margin-bottom:14px">Новый пароль</h1>${p.form}</div></div>`; return p.wire(); }
  const allowed = NAV.filter(n => n[2](me)).map(n => n[0]);
  if (!allowed.includes(view)) view = 'overview';
  try { await VIEWS[view](); } catch (e) { if (me) shell('Ошибка', `<div class="msg err">${esc(e.message)}</div>`); }
}
window.addEventListener('hashchange', () => { view = location.hash.slice(1) || 'overview'; render(); });

async function boot() {
  try { const st = await (await fetch('/api/state')).json(); brand = { logo: st.logo || '', school: st.schoolName || '' }; } catch { /* нет связи */ }
  try { me = await api('GET', '/api/auth/me'); } catch { me = null; }
  view = location.hash.slice(1) || 'overview';
  render();
}
boot();
