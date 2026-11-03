// Сквозная проверка API. Запуск: BASE=http://localhost:3111 PASS=<пароль директора> node test/api.test.js
const BASE = process.env.BASE || 'http://localhost:3000';
let fails = 0;
let ADMIN_COOKIE = ''; // состояние читаем со входом директора (как предпросмотр в админке)
const stateJ = async () => (await fetch(BASE + '/api/state', { headers: { Cookie: ADMIN_COOKIE } })).json();
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };
class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, headers = {}) {
    const h = { 'X-Requested-With': 'sb', ...headers };
    if (body !== undefined && !(body instanceof Buffer)) h['Content-Type'] = 'application/json';
    if (this.cookie) h.Cookie = this.cookie;
    const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    let j = null; try { j = await r.json(); } catch {}
    return { s: r.status, j };
  }
}
(async () => {
  const d = new Client();
  let r = await d.req('GET', '/api/admin/overview'); ok(r.s === 401, 'без входа админка закрыта (401)');
  r = await d.req('POST', '/api/auth/login', { login: 'director', password: 'wrong' }); ok(r.s === 401, 'неверный пароль отклонён');
  r = await d.req('POST', '/api/auth/login', { login: 'director', password: process.env.PASS }); ok(r.s === 200 && r.j.must_change, 'вход директора, требуется смена пароля');
  r = await d.req('GET', '/api/admin/overview'); ok(r.s === 403, 'до смены пароля админка закрыта (403)');
  r = await d.req('POST', '/api/auth/password', { old: process.env.PASS, new: 'short' }); ok(r.s === 400, 'слабый пароль отклонён');
  const NEWPW = 'Licey24-secure';
  r = await d.req('POST', '/api/auth/password', { old: process.env.PASS, new: NEWPW }); ok(r.s === 200, 'пароль сменён');
  ADMIN_COOKIE = d.cookie;
  {
    // привязка телевизора: без привязки данных и пинга нет; код → подтверждение → cookie
    const tv = new Client();
    let rr = await tv.req('GET', '/api/state'); ok(rr.s === 401, 'без привязки табло данных не получает');
    rr = await tv.req('POST', '/api/ping', { version: 'x' }); ok(rr.s === 401, 'без привязки пинг не засчитывается');
    rr = await tv.req('POST', '/api/pair/request', { id: 'tvtest-01' }); ok(rr.s === 200 && /^\d{6}$/.test(rr.j.code), 'телевизор получил код привязки');
    const code = rr.j.code;
    rr = await tv.req('POST', '/api/pair/claim', { id: 'tvtest-01' }); ok(rr.j.status === 'waiting', 'до подтверждения телевизор ждёт');
    rr = await d.req('POST', '/api/admin/screens/pair', { code: '000000', name: 'x' }); ok(rr.s === 404, 'неверный код отклонён');
    rr = await d.req('POST', '/api/admin/screens/pair', { code, name: 'Холл тест' }); ok(rr.s === 200, 'директор подтвердил код');
    rr = await tv.req('POST', '/api/pair/claim', { id: 'tvtest-01' }); ok(rr.j.status === 'ok' && tv.cookie.startsWith('sb_screen='), 'телевизор получил cookie');
    rr = await tv.req('GET', '/api/state'); ok(rr.s === 200, 'привязанный экран получает данные');
    rr = await tv.req('POST', '/api/ping', { version: 't' }); ok(rr.s === 200, 'привязанный экран засчитывается');
    { let last429 = false; for (let i = 0; i < 25; i++) { const x = await tv.req('POST', '/api/ping', { version: 't' }); if (x.s === 429) last429 = true; }
      ok(last429, 'слишком частые пинги одного экрана ограничиваются'); }
    const list = await d.req('GET', '/api/admin/screens'); ok(list.j.some(x => x.name === 'Холл тест') && list.j.every(x => !('token_hash' in x)), 'экран виден в админке, секрет не отдаётся');
    rr = await d.req('POST', '/api/admin/screens/tvtest-01/unpair'); ok(rr.s === 200, 'экран отвязан');
    rr = await tv.req('GET', '/api/state'); ok(rr.s === 401, 'после отвязки данных нет');
    rr = await tv.req('POST', '/api/pair/claim', { id: 'tvtest-01' }); ok(rr.j.status !== 'ok', 'без нового кода cookie не выдаётся');
  }
  r = await d.req('GET', '/api/admin/overview'); ok(r.s === 200 && r.j.sync, 'обзор доступен после смены пароля');

  r = await d.req('POST', '/api/admin/users', { login: 'it1', name: 'Айдар (IT)', role: 'it' }); ok(r.s === 201 && r.j.temp_password, 'создан IT-администратор');
  const itPw = r.j.temp_password;
  r = await d.req('POST', '/api/admin/users', { login: 'zav', name: 'Завуч', role: 'zavuch' }); const zavPw = r.j.temp_password; ok(r.s === 201, 'создан завуч');
  r = await d.req('POST', '/api/admin/users', { login: 'zav', name: 'Дубль', role: 'viewer' }); ok(r.s === 409, 'дубликат логина отклонён');
  r = await d.req('POST', '/api/admin/users', { login: 'x', name: 'x', role: 'viewer' }); ok(r.s === 400, 'короткий логин отклонён');

  // завуч: может медиа, не может пользователей и настройки
  const z = new Client();
  r = await z.req('POST', '/api/auth/login', { login: 'zav', password: zavPw }); ok(r.s === 200, 'вход завуча');
  await z.req('POST', '/api/auth/password', { old: zavPw, new: 'Zavuch-2026x' });
  r = await z.req('GET', '/api/admin/users'); ok(r.s === 403, 'завуч не видит пользователей');
  r = await z.req('PUT', '/api/admin/settings', { board_seconds: 30 }); ok(r.s === 403, 'завуч не меняет настройки');
  r = await z.req('GET', '/api/admin/media'); ok(r.s === 200, 'завуч видит медиатеку');
  r = await z.req('GET', '/api/admin/schedule'); ok(r.s === 200, 'завуч видит расписание');
  r = await z.req('PUT', '/api/admin/schedule/lesson', { cls: '5А', day: 0, n: 1, subject: 'Тест', teacher: '', room: '1' }); ok(r.s === 404, 'постоянный урок больше не правится в админке');
  r = await z.req('PUT', '/api/admin/schedule/day', { day: 0, items: [] }); ok(r.s === 404, 'постоянный день больше не правится в админке');
  r = await z.req('PUT', '/api/admin/subs/day', { date: '2026-12-04', items: [{ cls: '5А', n: 1, subject: 'Тест день', teacher: '', room: '2' }, { cls: '5Б', n: 1, subject: 'Тест день', teacher: '', room: '2' }] });
  ok(r.s === 200 && r.j.saved === 2, 'замены на дату сохранены пачкой (2 ячейки)');
  r = await z.req('PUT', '/api/admin/subs/day', { date: '2026-12-04', items: [{ cls: '5А', n: 1, subject: 'отменён', teacher: '', room: '' }] }); ok(r.s === 200, 'урок отменён для класса на дату');
  let st0 = await stateJ();
  ok(st0.overlay && st0.overlay['2026-12-04'] && st0.overlay['2026-12-04']['5А'][1].cancelled === true, 'отмена попала в состояние экрана');
  r = await z.req('PUT', '/api/admin/subs/day', { date: '2026-13-40', items: [{ cls: '5А', n: 1, subject: 'x' }] }); ok(r.s === 400, 'неверная дата отклонена');
  r = await z.req('PUT', '/api/admin/subs/day', { date: '2026-12-04', items: [] }); ok(r.s === 400, 'пустые изменения отклонены');
  r = await z.req('PUT', '/api/admin/subs/day', { date: '2026-12-04', items: [{ cls: '5А', n: 1, subject: 'x' }] }, { 'X-Requested-With': 'evil' }); ok(r.s === 403, 'замены на дату без метки отклонены (CSRF)');
  r = await z.req('GET', '/api/admin/subs'); const dayRows = r.j.filter(x => x.date === '2026-12-04');
  r = await z.req('DELETE', '/api/admin/subs', { ids: dayRows.map(x => x.id) }); ok(r.s === 200, 'тестовые замены на дату убраны');
  st0 = await stateJ(); ok(!(st0.overlay || {})['2026-12-04'], 'после удаления экран без замен на дату');

  // IT: не может трогать директора
  const it = new Client();
  await it.req('POST', '/api/auth/login', { login: 'it1', password: itPw });
  await it.req('POST', '/api/auth/password', { old: itPw, new: 'It-Admin-2026x' });
  r = await it.req('GET', '/api/admin/users'); ok(r.s === 200, 'IT видит пользователей');
  const dirId = r.j.users.find(u => u.login === 'director').id;
  r = await it.req('PATCH', '/api/admin/users/' + dirId, { active: false }); ok(r.s === 403, 'IT не может отключить директора');
  r = await it.req('POST', '/api/admin/users', { login: 'dir2', name: 'Д2', role: 'director' }); ok(r.s === 403, 'IT не создаёт директора');
  r = await d.req('PATCH', '/api/admin/users/' + dirId, { active: false }); ok(r.s === 400, 'нельзя отключить себя / единственного директора');

  // медиа: загрузка картинки
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  r = await z.req('POST', '/api/admin/media/upload', png, { 'X-File-Name': encodeURIComponent('Постер.png'), 'Content-Type': 'application/octet-stream' }); ok(r.s === 201 && r.j.kind === 'image', 'загружен постер');
  const mid = r.j && r.j.id;
  r = await z.req('POST', '/api/admin/media/upload', Buffer.from('<?php echo 1; ?>' + ' '.repeat(40)), { 'X-File-Name': 'a.php' }); ok(r.s === 400, 'не-медиа файл отклонён');
  r = await z.req('PATCH', '/api/admin/media/' + mid, { duration: 15, date_from: '2026-10-01', date_to: '2026-09-01' }); ok(r.s === 400, 'неверные даты отклонены');
  r = await z.req('PATCH', '/api/admin/media/' + mid, { duration: 15, priority: 3 }); ok(r.s === 200 && r.j.duration === 15, 'параметры показа сохранены');
  let st = await stateJ(); ok(st.carousel.some(c => c.id === 'm' + mid && c.fullscreen), 'постер попал в карусель ТВ на весь экран');
  r = await z.req('DELETE', '/api/admin/media/' + mid); ok(r.s === 200, 'постер удалён');

  // журнал
  r = await d.req('PUT', '/api/admin/settings', { display_mode: 'bogus' }); ok(r.s === 400, 'неизвестный режим экрана отклонён');
  r = await d.req('PUT', '/api/admin/settings', { display_mode: 'active' }); ok(r.s === 200 && r.j.display_mode === 'active', 'режим экрана сохранён');
  r = await d.req('PUT', '/api/admin/settings', { display_mode: 'auto' });
  r = await d.req('GET', '/api/admin/audit?hide_logins=1&limit=100'); ok(r.s === 200 && r.j.rows.some(x => x.action === 'user_created'), 'в журнале видны действия админки');
  ok(r.j.rows.some(x => x.action === 'media_uploaded') && r.j.rows.some(x => x.action === 'media_deleted'), 'в журнале загрузка и удаление медиа');
  ok(r.j.rows.some(x => x.action === 'substitution_added'), 'в журнале замены на дату');

  // расписание: импорт файла (если есть пример), предпросмотр и подтверждение
  const XLSX = process.env.XLSX;
  if (XLSX) {
    const fs = require('fs');
    r = await d.req('POST', '/api/admin/schedule/import', fs.readFileSync(XLSX), { 'Content-Type': 'application/octet-stream' });
    ok(r.s === 200 && r.j.counts.lessons > 0 && r.j.counts.bells > 0, 'файл расписания разобран (уроки, звонки)');
    ok(r.j.counts.meals >= 1, 'завтрак/обед найдены в звонках');
    r = await d.req('POST', '/api/admin/schedule/import/commit', { token: r.j.token, mark: true }); ok(r.s === 200 && r.j.ok, 'расписание записано после подтверждения');
    r = await d.req('POST', '/api/admin/schedule/import/commit', { token: 'nope', mark: false }); ok(r.s === 400, 'повторное подтверждение по старому токену отклонено');
    // исключение звонка на дату переживает повторный импорт того же файла
    r = await d.req('GET', '/api/admin/schedule'); const lesson = r.j.bells.find(b => !b.meal);
    r = await d.req('POST', '/api/admin/schedule/bell-exceptions', { bell_id: lesson.id, date_from: '2026-12-01', date_to: '2026-12-01', cancelled: true });
    ok(r.s === 200 || r.s === 201, 'исключение звонка добавлено');
    r = await d.req('POST', '/api/admin/schedule/import', fs.readFileSync(XLSX), { 'Content-Type': 'application/octet-stream' });
    r = await d.req('POST', '/api/admin/schedule/import/commit', { token: r.j.token, mark: false });
    r = await d.req('GET', '/api/admin/schedule');
    const kept = r.j.exceptions.find(e => e.date_from === '2026-12-01' && e.n === lesson.n);
    ok(!!kept && kept.cancelled === true, 'исключение звонка сохранилось после повторного импорта');
  }
  r = await d.req('GET', '/api/admin/schedule'); ok(r.s === 200 && Array.isArray(r.j.bells), 'расписание отдаётся админке');
  r = await d.req('PUT', '/api/admin/schedule/bells', { bells: [] }); ok(r.s === 404, 'постоянные звонки больше не правятся в админке');

  // замены
  r = await d.req('POST', '/api/admin/subs', { date: '2026-10-22', lessons: '3', classes: '8А, 8Б', subject: 'Музыка', room: '201', teacher: 'Петрова', absent: 'Иванов', note: '' });
  ok(r.s === 201 || r.s === 200, 'замена добавлена сразу для двух классов');
  // воскресенье — выходной: ни замена, ни изменение звонка на него не ставятся (2026-11-01 — воскресенье)
  r = await d.req('POST', '/api/admin/subs', { date: '2026-11-01', lessons: '1', classes: '8А', subject: 'Химия', room: '110' });
  ok(r.s === 400, 'замена на воскресенье отклонена');
  r = await d.req('POST', '/api/admin/subs', { date: '2026-12-03', lessons: '', classes: '8А', subject: 'Химия', room: '110' });
  ok(r.s === 400, 'замена без урока отклонена');
  r = await d.req('POST', '/api/admin/subs', { date: '', lessons: '2', classes: '8А', subject: 'Химия', room: '110' });
  ok(r.s === 400, 'замена без даты отклонена');
  r = await d.req('GET', '/api/admin/schedule'); const anyBell = r.j.bells[0];
  if (anyBell) { // звонки есть только если загружен файл расписания (переменная XLSX)
    r = await d.req('POST', '/api/admin/schedule/bell-exceptions', { bell_id: anyBell.id, date_from: '2026-11-01', date_to: '2026-11-01', cancelled: true });
    ok(r.s === 400, 'изменение звонка на воскресенье отклонено');
  } else console.log('SKIP звонки не загружены (задайте XLSX=путь к файлу расписания)');
  r = await d.req('GET', '/api/admin/subs'); const mine = r.j.filter(x => x.subject === 'Музыка');
  // публичная страница не должна показывать, кого заменили
  r = await d.req('POST', '/api/admin/subs', { date: '2026-12-02', lessons: '2', classes: '8А', subject: 'Химия', room: '110', teacher: 'Сидорова', absent: 'ТестОтсутствующий', note: '' });
  const pub = await new Client().req('GET', '/api/public/state');
  ok(pub.s === 200 && pub.j.substitutions.some(x => x.subject === 'Химия') && !JSON.stringify(pub.j).includes('ТестОтсутствующий'), 'публичная страница без фамилии заменяемого учителя');
  // ручная замена «1-3» на три класса: по порядку, не всем сразу
  r = await d.req('POST', '/api/admin/subs', { date: '2026-10-27', lessons: '1-3', classes: '6Б, 5Б, 5А', subject: 'Физика', room: '105' });
  r = await d.req('GET', '/api/admin/subs'); const ph = r.j.filter(x => x.subject === 'Физика' && x.date === '2026-10-27');
  const at = c => (ph.find(x => x.cls === c) || {}).lessons;
  ok(ph.length === 3 && at('6Б') === '1' && at('5Б') === '2' && at('5А') === '3', 'ручная замена «1-3» раскладывается по порядку: 6Б-1, 5Б-2, 5А-3');
  r = await d.req('DELETE', '/api/admin/subs', { ids: ph.map(x => x.id) });
  r = await d.req('POST', '/api/admin/subs', { date: '2026-10-27', lessons: '1-3', classes: '6Б, 5Б', subject: 'Физика', room: '105' }); ok(r.s === 400, 'несовпадение уроков и классов отклонено');
  r = await d.req('POST', '/api/admin/subs', { date: '2026-10-27', lessons: '2', classes: '8аб', subject: 'Музыка', room: '201' }); ok(r.s === 201 || r.s === 200, '«8аб» на один урок — оба класса');
  r = await d.req('GET', '/api/admin/subs'); const ab = r.j.filter(x => x.date === '2026-10-27' && x.subject === 'Музыка');
  ok(ab.length === 2 && ab.every(x => x.lessons === '2'), '«8аб» получили один урок'); 
  r = await d.req('DELETE', '/api/admin/subs', { ids: ab.map(x => x.id) });

  ok(mine.length === 2, 'замена записана одной строкой на класс');
  r = await d.req('DELETE', '/api/admin/subs', { ids: mine.map(x => x.id) }); ok(r.s === 200, 'замена удалена');

  // файл замен завуча: проверка → запись → повтор по старому токену отклонён
  if (process.env.SUBS_XLSX) {
    const fs = require('fs');
    r = await d.req('POST', '/api/admin/subs/import', fs.readFileSync(process.env.SUBS_XLSX), { 'Content-Type': 'application/octet-stream' });
    ok(r.s === 200 && r.j.token && r.j.rows.length > 0, 'файл замен разобран и показан для проверки');
    const tok = r.j.token;
    r = await d.req('POST', '/api/admin/subs/import/commit', { token: tok }); ok(r.s === 200 && r.j.saved > 0, 'замены из файла записаны');
    r = await d.req('POST', '/api/admin/subs/import/commit', { token: tok }); ok(r.s === 400, 'повторная запись по тому же токену отклонена');
    r = await d.req('GET', '/api/admin/subs'); const fromFile = r.j.filter(x => /^Файл завуча/.test(x.created_by));
    ok(fromFile.length > 0, 'строки помечены как «Файл завуча»');
    r = await d.req('DELETE', '/api/admin/subs', { ids: fromFile.map(x => x.id) }); ok(r.s === 200, 'замены из файла убраны после проверки');
  }
  r = await d.req('POST', '/api/admin/subs/import', Buffer.from('не xlsx'), { 'Content-Type': 'application/octet-stream' }); ok(r.s === 400, 'не-Excel файл замен отклонён');

  // тема, ночь, погода
  r = await d.req('PUT', '/api/admin/settings', { theme: 'neon' }); ok(r.s === 400, 'неизвестная тема отклонена');
  // оформление экрана: цвет только в формате #RRGGBB, размер 80–130, переключатели; завуч не меняет
  r = await d.req('PUT', '/api/admin/settings', { look_bg: 'red' }); ok(r.s === 400, 'цвет не в формате #RRGGBB отклонён');
  r = await z.req('PUT', '/api/admin/settings', { look_bg: '#112233' }); ok(r.s === 403, 'завуч не меняет оформление экрана');
  r = await d.req('PUT', '/api/admin/settings', { look_bg: '#112233', look_font: 500, look_weather: false });
  ok(r.s === 200 && r.j.look_bg === '#112233' && r.j.look_font === '130' && r.j.look_weather === '0', 'оформление сохранено, размер ограничен 130 %');
  st = await stateJ(); ok(st.look && st.look.bg === '#112233' && st.look.weather === false && st.look.font === 130, 'оформление попало на экран');
  r = await d.req('PUT', '/api/admin/settings', { look_bg: '', look_font: 100, look_weather: true });
  st = await stateJ(); ok(st.look && st.look.bg === '' && st.look.weather === true, 'оформление сброшено к стандартному');
  // каникулы: обе даты или ни одной; «по» не раньше «с»; сегодня в каникулах — на экране название и дата возвращения
  const tIso = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  r = await d.req('PUT', '/api/admin/settings', { holiday_from: tIso }); ok(r.s === 400, 'каникулы без второй даты отклонены');
  r = await d.req('PUT', '/api/admin/settings', { holiday_from: tIso, holiday_to: '2000-01-01' }); ok(r.s === 400, 'каникулы «по» раньше «с» отклонены');
  r = await d.req('PUT', '/api/admin/settings', { holiday_from: tIso, holiday_to: tIso, holiday_title: 'Осенние каникулы' });
  ok(r.s === 200, 'каникулы сохранены');
  st = await stateJ(); ok(st.holiday && st.holiday.title === 'Осенние каникулы' && st.holiday.back > tIso, 'каникулы попали на экран с датой возвращения');
  r = await d.req('PUT', '/api/admin/settings', { holiday_from: '', holiday_to: '', holiday_title: '' });
  st = await stateJ(); ok(r.s === 200 && !st.holiday, 'каникулы сняты, экран снова показывает расписание');
  r = await d.req('PUT', '/api/admin/settings', { night_from: '9pm' }); ok(r.s === 400, 'неверное время ночи отклонено');
  r = await d.req('PUT', '/api/admin/settings', { theme: 'dark', night_from: '21:00', night_to: '07:00' }); ok(r.s === 200, 'тема и ночь сохранены');
  r = await d.req('PUT', '/api/admin/settings', { theme: 'auto' }); ok(r.s === 200, 'тема возвращена в «авто»');
  const wx = await fetch(BASE + '/api/weather'); const wj = await wx.json().catch(() => null);
  ok(wx.status === 200 && wj && typeof wj === 'object' && !('error' in wj), 'погода отвечает без ошибки сервера (данные или пусто, если нет сети)');

  // срочное сообщение: готовый вариант, своя формулировка, снятие
  r = await d.req('PUT', '/api/admin/urgent', { preset: 'missile' }); ok(r.s === 400 && !(await stateJ()).urgent, 'готовая тревога без второго подтверждения не уходит на экраны');
  r = await d.req('PUT', '/api/admin/urgent', { preset: 'missile', confirmed: true }); ok(r.s === 200 && r.j.active === true, 'готовый вариант «Ракетная опасность» включён одним нажатием');
  st = await stateJ(); ok(st.urgent && st.urgent.title === 'Ракетная опасность' && st.urgent.source === 'МЧС России' && st.urgent.since > 0, 'вариант попал на экран с источником и временем включения');
  r = await d.req('PUT', '/api/admin/urgent', { preset: 'nope' }); ok(r.s === 400, 'неизвестный готовый вариант отклонён');
  r = await d.req('PUT', '/api/admin/urgent', { title: 'Тест', source: 'Школа' }); ok(r.s === 200 && r.j.active === true, 'свой текст включён');
  r = await d.req('PUT', '/api/admin/urgent', { preset: 'drone' }, { 'X-Requested-With': 'evil' }); ok(r.s === 403, 'срочное сообщение без метки отклонено (CSRF)');
  r = await new Client().req('PUT', '/api/admin/urgent', { preset: 'drone' }); ok(r.s === 401 || r.s === 403, 'срочное сообщение без входа отклонено');
  r = await d.req('GET', '/api/admin/urgent'); ok(r.s === 200 && Array.isArray(r.j.presets) && r.j.presets.length >= 2, 'готовые варианты отдаются админке');
  r = await d.req('PUT', '/api/admin/urgent', { title: '' }); ok(r.s === 200 && r.j.active === false, 'срочное сообщение снято');
  st = await stateJ(); ok(!st.urgent, 'после снятия экран без срочного сообщения');
  ok(st.clear && /^Отбой: /.test(st.clear.title) && st.clear.until > Date.now(), 'после снятия на 5 минут появляется зелёный отбой');
  r = await d.req('GET', '/api/admin/urgent'); ok(r.s === 200 && r.j.clear && r.j.clear.until > Date.now(), 'админка видит, что отбой показан');
  r = await d.req('GET', '/api/admin/overview'); ok(r.s === 200 && r.j.status && r.j.status.clear && r.j.status.urgent === null, 'обзор показывает отбой и отсутствие тревоги');
  ok(r.j.status && typeof r.j.status.subs_today === 'number' && Array.isArray(r.j.status.screens_offline), 'обзор отдаёт замены на сегодня и список экранов не на связи');
  r = await new Client().req('PUT', '/api/admin/urgent', { hide_clear: true }); ok(r.s === 401 || r.s === 403, 'скрыть отбой без входа нельзя');
  r = await d.req('PUT', '/api/admin/urgent', { hide_clear: true }, { 'X-Requested-With': 'evil' }); ok(r.s === 403, 'скрыть отбой без метки отклонено (CSRF)');
  r = await d.req('PUT', '/api/admin/urgent', { hide_clear: true }); ok(r.s === 200, 'отбой скрыт');
  st = await stateJ(); ok(!st.clear, 'после скрытия зелёного отбоя на экране его нет');
  r = await d.req('GET', '/api/admin/urgent'); ok(r.s === 200 && r.j.clear === null, 'в админке отбоя тоже нет');
  const toM = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

  // сдвиг звонков на сегодня: с 4-го урока на 30 минут, уроки до него не меняются
  const base = (await stateJ()).bells;
  if (base.some(b => !b.meal)) { // сдвиг нужен уроки из файла расписания (переменная XLSX)
    r = await d.req('PUT', '/api/admin/shift', { from: 4, minutes: 30 }); ok(r.s === 200 && r.j.active === true, 'сдвиг звонков с 4-го урока на 30 минут');
    st = await stateJ();
    const lesson = (bells, n) => bells.find(b => !b.meal && b.n === n);
    ok(lesson(st.bells, 3).start === lesson(base, 3).start, 'урок 3 (до сдвига) не меняется');
    ok(toM(lesson(st.bells, 4).start) === toM(lesson(base, 4).start) + 30 && toM(lesson(st.bells, 4).end) === toM(lesson(base, 4).end) + 30, 'урок 4 и его конец сдвинуты на 30 минут');
    ok(st.bellsNote.includes('сдвинуты на 30'), 'на экране подпись про сдвиг');
    r = await d.req('GET', '/api/admin/shift'); ok(r.s === 200 && r.j && r.j.from === 4 && r.j.minutes === 30, 'админка видит текущий сдвиг');
    r = await d.req('PUT', '/api/admin/shift', { from: 99, minutes: 30 }); ok(r.s === 400, 'сдвиг с несуществующего урока отклонён');
    r = await d.req('PUT', '/api/admin/shift', { from: 4, minutes: 0 }); ok(r.s === 400, 'нулевой сдвиг отклонён');
    r = await d.req('PUT', '/api/admin/shift', { reset: true }); ok(r.s === 200 && r.j.active === false, 'сдвиг возвращён');
    st = await stateJ(); ok(toM(lesson(st.bells, 4).start) === toM(lesson(base, 4).start), 'после «Вернуть» звонки как по расписанию');
    r = await d.req('PUT', '/api/admin/shift', { from: 4, minutes: 30 }, { 'X-Requested-With': 'evil' }); ok(r.s === 403, 'сдвиг без метки отклонён (CSRF)');
    r = await d.req('PUT', '/api/admin/shift', { reset: true });
  } else console.log('SKIP сдвиг звонков: нет уроков в расписании');

  // объявления
  r = await d.req('POST', '/api/admin/announcements', { title: 'Тест объявление', duration: 10, priority: 1, date_from: '', date_to: '' });
  ok(r.s === 201 || r.s === 200, 'объявление создано');
  const annId = r.j && r.j.id;
  r = await d.req('PATCH', '/api/admin/announcements/' + annId, { title: 'Тест объявление', duration: 2, priority: 1, date_from: '', date_to: '', active: true }); ok(r.s === 200 && r.j.ok, 'слишком короткая длительность поднята до допустимой');
  r = await d.req('GET', '/api/admin/announcements'); ok(r.j.find(a => a.id === annId).duration === 3, 'длительность сохранена как 3 с');
  st = await stateJ(); ok(st.carousel.some(c => c.id === 'a' + annId && c.place === 'center'), 'объявление попало на экран в центр');
  r = await d.req('DELETE', '/api/admin/announcements/' + annId); ok(r.s === 200, 'объявление удалено');

  // звонки на даты: отмена урока на сегодня и возврат (в воскресенье изменения звонков не ставятся — блок пропускаем)
  const todayIso = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // дата по Москве, как на сервере
  const sundayToday = new Date(todayIso + 'T12:00:00Z').getUTCDay() === 0;
  if (sundayToday) console.log('ПРОПУСК звонков на сегодня: сегодня воскресенье, изменения звонков не ставятся');
  const hasBells = (await d.req('GET', '/api/admin/schedule')).j.bells.some(b => !b.meal);
  if (!sundayToday && !hasBells) console.log('SKIP звонки на дату: нет уроков в расписании');
  if (!sundayToday && hasBells) {
  r = await d.req('GET', '/api/admin/schedule'); const lessonBell = r.j.bells.find(b => !b.meal);
  r = await d.req('POST', '/api/admin/schedule/bell-exceptions', { bell_id: lessonBell.id, date_from: todayIso, date_to: '', cancelled: true }); ok(r.s === 201, 'урок отменён на дату');
  const exId = r.j.id;
  st = await stateJ(); ok(st.bells.some(b => b.n === lessonBell.n && b.cancelled), 'отмена попала на экран (звонки)');
  r = await d.req('POST', '/api/admin/schedule/bell-exceptions', { bell_id: lessonBell.id, date_from: todayIso, date_to: todayIso, cancelled: false, start: '25:00', end: '08:00' }); ok(r.s === 400, 'неверное время звонка на дату отклонено');
  r = await d.req('GET', '/api/admin/schedule'); const mealBell = r.j.bells.find(b => b.meal);
  if (mealBell) {
    r = await d.req('POST', '/api/admin/schedule/bell-exceptions', { bell_id: mealBell.id, date_from: todayIso, date_to: todayIso, cancelled: true }); ok(r.s === 201, 'перемена (завтрак/обед) отменена на дату');
    const mid = r.j.id;
    st = await stateJ(); ok(st.bells.some(b => b.meal && b.cancelled), 'отмена перемены попала на экран');
    r = await d.req('DELETE', '/api/admin/schedule/bell-exceptions/' + mid); ok(r.s === 200, 'отмена перемены убрана');
  }
  r = await d.req('DELETE', '/api/admin/schedule/bell-exceptions/' + exId); ok(r.s === 200, 'отмена на дату убрана');
  st = await stateJ(); ok(!st.bells.some(b => b.cancelled), 'после удаления урок снова идёт');
  }

  // «выйти на всех устройствах»: вторая сессия того же директора тоже закрывается
  { const d2 = new Client(); r = await d2.req('POST', '/api/auth/login', { login: 'director', password: NEWPW }); ok(r.s === 200, 'вторая сессия директора открыта');
    r = await d2.req('GET', '/api/admin/overview'); ok(r.s === 200, 'вторая сессия работает');
    r = await d.req('POST', '/api/auth/logout-all'); ok(r.s === 200, 'выход на всех устройствах выполнен');
    r = await d2.req('GET', '/api/admin/overview'); ok(r.s === 401, 'вторая сессия закрыта');
    r = await d.req('GET', '/api/admin/overview'); ok(r.s === 401, 'текущая сессия тоже закрыта');
    r = await d.req('POST', '/api/auth/login', { login: 'director', password: NEWPW }); ok(r.s === 200, 'после выхода везде вход работает заново'); }
  // выход
  r = await d.req('POST', '/api/auth/logout'); r = await d.req('GET', '/api/admin/overview'); ok(r.s === 401, 'после выхода доступ закрыт');
  // блокировка перебора
  const b = new Client(); let last; for (let i = 0; i < 6; i++) last = await b.req('POST', '/api/auth/login', { login: 'zav', password: 'nope' + i });
  ok(last.s === 401 && /Слишком много/.test(last.j.error), 'после 5 неудач вход блокируется');
  console.log(fails ? `\nПровалено: ${fails}` : '\nВсе проверки пройдены'); process.exit(fails ? 1 : 0);
})();
