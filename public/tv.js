// Экран показа (ТВ). Работает автономно: данные берутся из сети или из последней сохранённой копии.
const REFRESH_MS = 15 * 1000;      // экран спрашивает сервер каждые 15 секунд
const MAX_PER_VISIT = 1;           // постеров и роликов на весь экран за один заход
const BELL_MARGIN_S = 20;          // за сколько секунд до звонка ролики уже не начинаем
let S = null, slot = { phase: 'off' }, offline = false;
const $ = id => document.getElementById(id);

// ---------- Верхняя панель: дата, время, текущий урок, обратный отсчёт ----------
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const t0 = t => String(t).replace(/^0/, '');
let lastIso = '';
function tick() {
  const now = schoolNow(S && S.tz);
  const [y, mo, d] = now.iso.split('-');
  $('dt').textContent = `${WD[now.day]}, ${d}.${mo}.${y.slice(2)} ${pad(now.h)}:${pad(now.m)}`;
  $('fsClock').textContent = `${pad(now.h)}:${pad(now.m)}`;
  if (!S) return;
  renderUrgent();
  if (lastIso && lastIso !== now.iso) renderAll(); // наступил новый день
  lastIso = now.iso;
  slot = currentSlot(S.bells, now);
  const st = staticNow(), nt = (inNightWindow() ? 'w' : '') + (nightNow() ? 's' : '');
  if (st !== lastStatic || nt !== lastNight) { lastStatic = st; lastNight = nt; applyTheme(); renderAll(); showCenter(); }
  const L = { lesson: 'Идёт урок · до звонка', break: 'Перемена · до звонка', before: 'До начала уроков', after: 'Уроки закончились', off: 'Выходной' }[slot.phase];
  $('nowLabel').textContent = L;
  $('nowCount').textContent = slot.left != null ? fmtLeft(slot.left) : '';
  $('fsNow').textContent = slot.left != null ? ' · ' + ({ lesson: 'до звонка ', break: 'перемена ', before: 'до уроков ' }[slot.phase] || '') + fmtLeft(slot.left) : '';
  document.querySelectorAll('#bells .bl').forEach(el => { el.classList.toggle('now', now.day < 6 && !el.classList.contains('off') && now.minutes >= toMin(el.dataset.s) && now.minutes < toMin(el.dataset.e)); });
  // в 04:00 перезагружаем страницу — защита от утечек памяти за недели работы
  if (now.h === 4 && now.m === 0 && now.s < 2 && !window.__reloaded) { window.__reloaded = 1; location.reload(); }
}

// Названия предметов на экране. Полное название — если помещается; сокращение — если нет, и одинаково везде.
// Правила идут по порядку, первое подошедшее побеждает. Подгруппы (С/К, З/И и т.д.) пишем как в файле.
const cap = t => t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
const SUBJ_RULES = [
  [/^пр\.?\s+(.+)$/, (m, t) => { const rest = cap(t.replace(/^пр\.?\s+/i, '')); return { full: 'Пр. ' + rest, short: 'Пр. ' + rest }; }],
  [/^(английский|англ\.?)(?:\s+(.*))?$/, (m, t) => { const tail = ((/^(английский|англ\.?)(?:\s+(.*))?$/i.exec(t) || [])[2]) || ''; return { full: 'Английский' + (tail ? ' ' + tail : ''), short: 'Англ.' + (tail ? ' ' + tail : '') }; }],
  [/^родная лит/, () => ({ full: 'Родная литература', short: 'Родная лит.' })],
  [/^родной язык/, () => ({ full: 'Родной язык', short: 'Род. яз.' })],
  [/^русский язык/, () => ({ full: 'Русский язык', short: 'Русский язык' })],
  [/^литератур|^литер\.?$/, () => ({ full: 'Литература', short: 'Литер.' })],
  [/^математика|^матем\.?$/, () => ({ full: 'Математика', short: 'Матем.' })],
  [/^физкультура|^физ-?ра$/, () => ({ full: 'Физкультура', short: 'Физ-ра' })],
  [/^география|^геогр\.?$/, () => ({ full: 'География', short: 'Геогр.' })],
  [/^биология|^биол\.?$/, () => ({ full: 'Биология', short: 'Биол.' })],
  [/^информатика|^информ\.?$/, () => ({ full: 'Информатика', short: 'Информ.' })],
  [/^разговор о важном/, () => ({ full: 'Разговор о важном', short: 'Разг. о важном' })],
  [/^обществознание|^общество$/, () => ({ full: 'Общество', short: 'Общество' })],
  [/^(алгебра|геометрия|вероятность|история|физика|химия|изо|музыка|обзр)$/, (m) => ({ full: cap(m[1]).replace(/^Обзр$/i, 'ОБЗР').replace(/^Изо$/i, 'ИЗО'), short: null })],
];
// Сочетание через «/» (например «Труд / информатика», «Англ. С / труд»): каждую часть называем по правилам выше,
// части идут в одном порядке: английский, информатика, труд, остальные — как есть. Так одна пара пишется одинаково везде.
const PART_ORDER = [/^англ/i, /^информ/i, /^труд/i];
function comboName(t) {
  const parts = t.split(/\s*\/\s*/).map(x => x.trim()).filter(Boolean).map(x => {
    const low = x.toLowerCase().replace(/ё/g, 'е');
    const rank = PART_ORDER.findIndex(re => re.test(low));
    return { n: subjName(x), rank: rank < 0 ? 99 : rank };
  }).sort((a, b) => a.rank - b.rank);
  const full = parts.map(p => p.n.full).join(' / ');
  const short = parts.map(p => p.n.short).join(' / ');
  return { key: full, full, short };
}
// Номер кабинета, записанный в названии («Англ. К / труд 316/103»): убираем из названия и ставим в колонку кабинета
function splitRoom(subject, room) {
  const s = String(subject || '').replace(/\s+/g, ' ').trim();
  const m = /\s+(\d{3}(?:\s*\/\s*\d{3})?)$/.exec(s);
  if (!m) return { subject: s, room: room || '' };
  return { subject: s.slice(0, m.index).trim(), room: room || m[1].replace(/\s+/g, '') };
}
// Кабинеты: между совместными кабинетами ровно один «/» («108103» → «108/103»). Нет кабинета у физкультуры — «СЗ» (спортзал)
function roomText(room, subject) {
  let r = String(room || '').trim();
  if (!r) return /физкультура|физ-?ра/i.test(String(subject || '')) ? 'СЗ' : '';
  if (/^\d{6}$/.test(r)) r = r.slice(0, 3) + '/' + r.slice(3);
  return r.split(/\s*\/\s*/).filter(Boolean).join('/');
}
function subjName(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return { key: '', full: '', short: '' };
  if (t.includes('/')) return comboName(t);
  const low = t.toLowerCase().replace(/ё/g, 'е');
  for (const [re, f] of SUBJ_RULES) {
    const m = re.exec(low);
    if (m) { const r = f(m, t); const full = r.full, short = r.short || full; return { key: full, full, short }; }
  }
  return { key: cap(t), full: cap(t), short: cap(t) };
}
const esc2 = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- Блоки табло ----------
let clsPage = 0, clsTimer = null;


let shortKeys = new Set(); // предметы, которые везде показываем сокращённо
let fontsChecked = false;
function renderClasses() {
  clearTimeout(clsTimer);
  // шрифт грузится с задержкой: замер до загрузки даёт неверную ширину, поэтому повторяем после неё
  if (!fontsChecked && document.fonts) { fontsChecked = true; document.fonts.ready.then(() => renderClasses()); }
  const now = schoolNow(S.tz), day = now.day;
  // каникулы: вместо уроков название и дата возвращения (экран не пустой)
  if (S.holiday) { clsPage = 0; $('classes').innerHTML = holidayHtml(S.holiday); return; }
  // в воскресенье уроков нет: расписание понедельника на выходной не показываем
  if (now.day > 5) { clsPage = 0; $('classes').innerHTML = '<div class="empty">Выходной</div>'; return; }
  const list = S.classes, MAXC = 8;
  if (!list.length) { $('classes').innerHTML = '<div class="empty">Расписание пока не загружено. Его заполняет администратор в панели.</div>'; return; }
  const pagesN = Math.ceil(list.length / MAXC), per = Math.ceil(list.length / pagesN), pg = clsPage % pagesN;
  const part = list.slice(pg * per, (pg + 1) * per);
  // на экране дата сегодня (или завтра, если сегодня воскресенье): замены этой даты уже внутри расписания
  const ov = (S.overlay || {})[now.day > 5 ? S.tomorrow : S.today] || {};
  const cancelledN = new Set(S.bells.filter(b => b.cancelled && !b.meal).map(b => b.n));
  const lessonsOf = c => {
    const o = ov[c] || {};
    const base = ((S.schedule[c] || {})[day] || []).map(l => o[l.n] || l);
    return [...base, ...Object.values(o).filter(x => !base.some(l => l.n === x.n))].sort((a, b) => a.n - b.n);
  };
  const maxN = Math.max(1, ...list.flatMap(c => lessonsOf(c).map(l => l.n)));
  const ns = [...Array(maxN).keys()].map(i => i + 1);
  const gut = `<div class="gut"><div class="cn">0</div><div class="ls" style="grid-template-rows:repeat(${maxN},minmax(0,1fr))">${ns.map(n => `<span>${n}</span>`).join('')}</div></div>`;
  const draw = () => {
    const cols = part.map(c => {
      const by = Object.fromEntries(lessonsOf(c).map(l => [l.n, l]));
      return `<div class="col" style="grid-template-rows:auto 1fr"><div class="cn">${esc(c)}</div><div class="ls" style="grid-template-rows:repeat(${maxN},minmax(0,1fr))">` +
        ns.map(n => {
          const l = by[n];
          if (cancelledN.has(n) || (l && l.cancelled)) return '<div class="c chg off"><span>отменён</span></div>';
          if (!l) return '<div class="c"></div>';
          const sr = splitRoom(l.subject, l.room), nm = subjName(sr.subject), text = shortKeys.has(nm.key) ? nm.short : nm.full;
          const sur = t => esc(String(t || '').split(' ')[0]);
          return `<div class="c${l.was ? ' chg' : ''}"><span data-key="${esc2(nm.key)}">${esc(text)}${l.note ? ` <i>(${esc(l.note)})</i>` : ''}${l.was && l.teacher ? `<em>${sur(l.teacher)}</em>` : ''}</span><b>${esc(roomText(sr.room, sr.subject))}</b></div>`;
        }).join('') + '</div></div>';
    }).join('');
    $('classes').innerHTML = gut + `<div class="cols" style="grid-template-columns:repeat(${part.length},1fr)">${cols}</div>` + gut +
      (pagesN > 1 ? `<div class="pdots">${[...Array(pagesN).keys()].map(i => `<i${i === pg ? ' class="on"' : ''}></i>`).join('')}</div>` : '');
  };
  // шаг 1: рисуем полными названиями; шаг 2: если хоть одно не помещается — этот предмет сокращаем везде
  shortKeys = new Set();
  draw();
  const over = new Set();
  $('classes').querySelectorAll('.c > span[data-key]').forEach(sp => { if (sp.scrollWidth > sp.clientWidth + 1) over.add(sp.dataset.key); });
  const fresh = [...over].filter(k => !shortKeys.has(k));
  if (fresh.length) { fresh.forEach(k => shortKeys.add(k)); draw(); }
  // шаг 3: обычные уроки всегда в одну строку. Если название всё ещё не влезает, уменьшаем шрифт только в этой
  // клетке, но не меньше 60% от обычного. Остальные клетки остаются крупными. Перенос — только у замен и отмен.
  const host = $('classes');
  host.querySelectorAll('.c:not(.chg) > span[data-key]').forEach(sp => {
    sp.style.fontSize = '';
    const base = parseFloat(getComputedStyle(sp).fontSize);
    let fs = base;
    const fits = () => sp.scrollWidth <= sp.clientWidth + 1;
    while (!fits() && fs > base * 0.6) { fs *= 0.97; sp.style.fontSize = fs + 'px'; }
  });
  host.querySelectorAll('.c.chg > span[data-key]').forEach(sp => {
    const base = parseFloat(getComputedStyle(sp).fontSize);
    let fs = base;
    const fits = () => sp.scrollWidth <= sp.clientWidth + 1 && sp.scrollHeight <= sp.clientHeight + 2;
    while (!fits() && fs > base * 0.6) { fs *= 0.95; sp.style.fontSize = fs + 'px'; }
    if (!fits()) { sp.style.whiteSpace = 'normal'; sp.style.lineHeight = '1.05'; }
  });
  if (pagesN > 1) clsTimer = setTimeout(() => { clsPage++; renderClasses(); }, 12000);
}

function renderBells() {
  const note = $('bnote'); note.textContent = S.bellsNote || ''; note.hidden = !S.bellsNote;
  $('bells').innerHTML = S.bells.map(b => `<div class="bl${b.was ? ' chg' : ''}${b.cancelled ? ' off' : ''}" data-s="${esc(b.start)}" data-e="${esc(b.end)}"><span>${b.meal ? esc(b.title.toUpperCase()) : b.n}${b.label ? `<small>${esc(b.label.replace(/\s*классов?|\s*классы/i, ' кл'))}</small>` : ''}</span><i></i><span>${b.cancelled ? 'отменён' : `${t0(b.start)}–${t0(b.end)}`}</span></div>`).join('');
}
// Логотип: на тёмном фоне (тёмная тема или ночной экран) — тёмный логотип, если он загружен
const darkBg = () => !!S && (S.theme === 'dark' || inNightWindow());
const logoSrc = () => (darkBg() && S.logoDark) || S.logo || '';
function renderBrand() {
  const src = logoSrc();
  $('school').textContent = src ? '' : (S.schoolName || '');
  [$('logo'), $('logoBig')].forEach(img => { if (src) { img.src = src; img.hidden = false; } else img.hidden = true; });
  $('nightLogo').src = S.logoDark || S.logo || ''; $('nightLogo').hidden = !(S.logoDark || S.logo);
}
// Тема и ночной режим: тёмный фон, на ночь — только время и логотип на весь экран
function applyTheme() {
  const night = nightNow();
  document.body.classList.toggle('dark', darkBg());
  document.body.classList.toggle('night', night);
  $('night').hidden = !night;
  if (night) { $('fs').classList.remove('on'); layers.forEach(l => l.classList.remove('on')); cl.forEach(l => l.classList.remove('on')); }
  applyLook();
}
// Оформление из админки: свои цвета для светлой и для тёмной темы (тёмная ещё и ночью), размер таблицы и что показывать
function applyLook() {
  if (!S) return;
  const L = S.look || {}, b = document.body, st = b.style;
  const p = b.classList.contains('dark') ? 'd' : '';   // какой набор цветов сейчас на экране
  const set = (name, v) => { if (v) st.setProperty(name, v); else st.removeProperty(name); };
  set('--bg', L[p + 'bg']); set('--panel', L[p + 'panel']); set('--text', L[p + 'text']);
  set('--accent', L[p + 'accent']); set('--red', L[p + 'accent']);
  document.documentElement.style.setProperty('--fs', String((L.font || 100) / 100));
  b.classList.toggle('no-wx', L.weather === false);
  b.classList.toggle('no-bells', L.bells === false);
}
// Срочное сообщение: закрывает основную часть экрана, шапка остаётся; пока не сняли в админке.
// После снятия 5 минут показываем зелёный «Отбой».
function renderUrgent() {
  const el = $('urgent');
  const hhmm = ts => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: (S && S.tz) || 'Europe/Moscow' });
  let view = null;
  if (S && S.urgent) {
    const u = S.urgent;
    view = { ok: false, key: ['u', u.title, u.source, u.note, u.since].join('|'), title: u.title,
      sub: [u.source && 'Источник: ' + u.source, u.since && 'введено в ' + hhmm(u.since)].filter(Boolean).join(' · '), note: u.note || '' };
  } else if (S && S.clear && Date.now() < S.clear.until) {
    const c = S.clear;
    view = { ok: true, key: ['c', c.title, c.since].join('|'), title: c.title,
      sub: [c.source && 'Источник: ' + c.source, c.since && 'отбой в ' + hhmm(c.since)].filter(Boolean).join(' · '), note: '' };
  }
  el.hidden = !view;
  document.body.classList.toggle('urgent', !!view);
  el.classList.toggle('ok', !!(view && view.ok));
  if (!view) { el.dataset.k = ''; return; }
  if (el.dataset.k === view.key) return;
  el.dataset.k = view.key;
  el.querySelector('.ut').textContent = view.title;
  el.querySelector('.us').textContent = view.sub;
  el.querySelector('.un').textContent = view.note;
}

function renderAll() { showBanners(); renderClasses(); renderBells(); renderBrand(); tick(); }

// Статичный экран: на уроках (если включено в настройках) или весь день (если включено «держать»)
let lastStatic = null, lastNight = null;
// Ночь: время между «ночь с» и «ночь до» (может идти через полночь), если ночной режим не «как днём».
// Тема днём (светлая или тёмная) и ночной режим не зависят друг от друга.
function inNightWindow() {
  if (!S || (S.nightMode || 'screen') === 'same') return false;
  if (isPreview && S.previewNight != null) return S.previewNight; // предпросмотр в админке: показать ночь или день, когда захочется
  const n = schoolNow(S.tz).minutes, a = toMin(S.nightFrom || '21:00'), b = toMin(S.nightTo || '07:00');
  return a <= b ? (n >= a && n < b) : (n >= a || n < b);
}
// Чёрный ночной экран (время и логотип): только в режиме «screen»
const nightNow = () => !!S && (S.nightMode || 'screen') === 'screen' && inNightWindow();
const staticNow = () => !!S && (nightNow() || S.displayMode === 'static' || (S.displayMode !== 'active' && slot.phase === 'lesson'));

// ---------- Показ: таблица → постеры/ролики на весь экран → таблица ----------
// Постеры, презентации и видео занимают весь экран. Текстовые объявления — на узкой полосе сбоку.
const layers = [$('layerA'), $('layerB')];
let front = 0, mediaIdx = 0, started = false;

const eligible = i => {
  const today = schoolNow(S.tz).iso;
  return (!i.from || i.from <= today) && (!i.to || i.to >= today) && !(i.breakOnly && slot.phase === 'lesson');
};
const weighted = list => list.flatMap(i => Array(i.priority || 1).fill(i)); // приоритет = вес в ротации
const wait = ms => new Promise(r => setTimeout(r, ms));

function build(item, layer) {
  layer.innerHTML = '';
  return new Promise(resolve => {
    let el;
    if (item.kind === 'video') {
      el = document.createElement('video'); el.muted = true; el.playsInline = true; el.preload = 'auto'; // со звуком Safari не даёт автозапуск
      el.setAttribute('muted', ''); el.setAttribute('playsinline', '');
      el.oncanplay = () => resolve(el); el.onerror = () => resolve(null);
    } else if (item.kind === 'pdf') {
      el = document.createElement('iframe'); el.style.cssText = 'width:100%;height:100%;border:0;background:#fff';
      el.onload = () => resolve(el);
    } else {
      el = document.createElement('img'); el.onload = () => resolve(el); el.onerror = () => resolve(null);
    }
    el.src = item.kind === 'pdf' ? item.url + '#toolbar=0&navpanes=0' : item.url;
    layer.append(el);
    setTimeout(() => resolve(null), 15000); // битый файл не должен вешать показ
  });
}

// Показывает один ролик/постер на весь экран; ждёт окончания. Следующий готовится «за кадром» — чёрного экрана нет.
async function playFullscreen(item) {
  const back = layers[1 - front];
  const el = await build(item, back);
  if (!el) return false;
  back.classList.add('on'); layers[front].classList.remove('on');
  const old = layers[front].querySelector('video'); if (old) setTimeout(() => old.pause(), 900);
  front = 1 - front;
  $('fs').classList.add('on');
  if (item.kind === 'video') {
    await new Promise(res => { let done = false; const end = () => { if (!done) { done = true; res(); } };
      el.onended = end; el.onerror = end; el.play().catch(end);
      setTimeout(end, Math.max(item.duration, 5) * 1000 + 60000); });
  } else await wait(item.duration * 1000);
  return true;
}

async function runShow() {
  for (;;) {
    await wait(Math.max(10, S.boardSeconds || 45) * 1000);        // таблица на экране
    if (staticNow() || nightNow()) continue;                        // статичный режим и ночь: постеры не идут
    const list = weighted(S.carousel.filter(i => i.fullscreen && eligible(i)));
    if (!list.length) continue;
    // Расписание главное: на перемене за один заход идёт один материал (≈15–20% времени), а не три подряд.
    // Материал, который не закончится за 20 секунд до звонка, не запускаем: ученик не должен остаться без расписания.
    const n = Math.min(MAX_PER_VISIT, new Set(list.map(i => i.id)).size);
    let played = 0;
    for (let k = 0; k < list.length * 2 && played < n; k++) {
      const item = list[mediaIdx++ % list.length];
      if (!eligible(item)) continue;
      if (slot.phase === 'break' && slot.left != null && Math.max(item.duration || 10, 5) > slot.left - BELL_MARGIN_S) continue;
      if (await playFullscreen(item)) played++;
    }
    $('fs').classList.remove('on'); layers.forEach(l => l.classList.remove('on'));
    await wait(1000); layers.forEach(l => { const v = l.querySelector('video'); if (v) v.pause(); l.innerHTML = ''; });
  }
}

// Центральный блок: картинки, ролики и текст с местом «центр» сменяют друг друга
const cl = [$('cA'), $('cB')];
let cFront = 0, cIdx = 0, cTimer = null, bIdx = 0, bTimer = null;
// номер текущего показа: если за время загрузки постера запустили новый показ, старый не трогает слой
let centerSeq = 0;
async function showCenter() {
  clearTimeout(cTimer);
  const seq = ++centerSeq;
  if (nightNow()) { cl.forEach(l => l.classList.remove('on')); return; }
  // постеры центра идут и на уроках (в статичном режиме тоже); логотип — только когда постеров нет
  const list = weighted(S.carousel.filter(i => i.place === 'center' && eligible(i)));
  // логотип прячем только когда постер уже показан, а не пока он грузится (иначе видна пустая рамка)
  if (!list.length) { $('center').classList.remove('hasc'); cl.forEach(l => l.classList.remove('on')); cTimer = setTimeout(showCenter, 5000); return; }
  const item = list[cIdx++ % list.length], back = cl[1 - cFront];
  let ok = true;
  if (item.kind === 'text') { back.innerHTML = `<div class="ctext">${esc(item.title)}</div>`; }
  else { const el = await build(item, back); if (seq !== centerSeq) return; ok = !!el; if (el && item.kind === 'video') el.play().catch(() => {}); }
  if (!ok) { cTimer = setTimeout(showCenter, 3000); return; }
  back.classList.add('on'); cl[cFront].classList.remove('on');
  $('center').classList.add('hasc');
  const old = cl[cFront].querySelector('video'); if (old) setTimeout(() => old.pause(), 900);
  cFront = 1 - cFront;
  cTimer = setTimeout(showCenter, Math.max(3, item.duration || 10) * 1000);
}

// Маленькие баннеры с QR-кодами: по два на экране, если их больше — листаются
let bannerKey = '';
function showBanners() {
  clearTimeout(bTimer);
  const list = (S.look && S.look.banners === false) ? [] : S.carousel.filter(i => i.place === 'banner' && (i.kind === 'image' || i.kind === 'video') && eligible(i));
  $('banners').hidden = !list.length;
  document.querySelector('.mid').classList.toggle('nob', !list.length); // без баннеров центр занимает всю ширину
  if (!list.length) { bannerKey = ''; return; }
  const base = staticNow() ? 0 : bIdx;                  // статичный режим: всегда первые два баннера
  const show = [0, 1].slice(0, Math.min(2, list.length)).map(k => list[(base + k) % list.length]);
  const key = show.map(x => x.url).join('|');
  if (key !== bannerKey) { bannerKey = key; $('banners').innerHTML = show.map(x => x.kind === 'video' ? `<video src="${esc(x.url)}" muted loop autoplay playsinline></video>` : `<img src="${esc(x.url)}" alt="${esc(x.title)}">`).join('');
    $('banners').querySelectorAll('video').forEach(v => { v.muted = true; v.play().catch(() => {}); }); }
  if (list.length > 2 && !staticNow()) { bIdx += 2; bTimer = setTimeout(showBanners, 12000); }
}

// Предзагрузка медиа в кэш Service Worker — для работы без интернета.
function prefetch() { (S.carousel || []).forEach(i => i.url && fetch(i.url).catch(() => {})); }

// «Обновить все экраны» из админки: меняется число refreshEpoch — страница перезагружается.
function checkEpoch() {
  const e = String(S.refreshEpoch || 0);
  const had = store.get('epoch');
  store.set('epoch', e);
  if (had != null && had !== e) location.reload();
}

const screenId = (() => { let id = store.get('screenId'); if (!id) { id = 's' + Math.random().toString(36).slice(2, 10); store.set('screenId', id); } return id; })();
// предпросмотр в админке (во фрейме или с ?preview=1) — не экран, его не считаем
const isPreview = window.top !== window.self || /[?&]preview\b/.test(location.search);
const ping = () => isPreview ? Promise.resolve() : fetch('/api/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: screenId, version: S ? S.version : '' }) }).catch(() => {});

// ---------- Обновление данных ----------
// Погода в шапке: обновляется раз в 15 минут, если данных нет — строка скрыта
let wxAt = 0;
async function loadWeather() {
  if (Date.now() - wxAt < 15 * 60e3) return;
  wxAt = Date.now();
  try {
    const w = await (await fetch('/api/weather', { cache: 'no-store' })).json();
    const el = $('wx');
    if (w && typeof w.temp === 'number') { el.textContent = `${w.temp > 0 ? '+' : ''}${w.temp}°C${w.text ? ' · ' + w.text : ''}`; el.hidden = false; }
    else el.hidden = true;
  } catch { wxAt = 0; }
}
// ---- привязка: без доступа экран показывает код, админка его подтверждает, и экран получает доступ ----
let pairTimer = null;
async function requestCode() {
  try {
    const j = await (await fetch('/api/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: screenId }) })).json();
    if (j.code) {
      $('pairCode').textContent = j.code.slice(0, 3) + ' ' + j.code.slice(3);
      // QR ведёт в админку с кодом: телефон откроет «Привязать экран» с уже введённым кодом
      if (window.QRCode) {
        const qr = new window.QRCode(-1, 0); qr.addData(location.origin + '/admin?pair=' + j.code); qr.make();
        const n = qr.getModuleCount(), m = 4; let d = '';
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
        const size = n + 2 * m;
        $('pairQr').innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path d="${d}" fill="#16181f"/></svg>`;
      }
    }
  } catch { /* нет связи — повторим */ }
}
function showPairing() {
  $('pair').hidden = false; $('pairHost').textContent = location.host;
  if (pairTimer) return;
  requestCode();
  pairTimer = setInterval(async () => {
    try {
      const j = await (await fetch('/api/pair/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: screenId }) })).json();
      if (j.status === 'ok') location.reload(); // cookie получена — открываем табло
      else if (j.status === 'expired') requestCode(); // код устарел — берём новый
    } catch { /* нет связи — проверим ещё раз */ }
  }, 3000);
}

async function refresh() {
  loadWeather();
  const r = await loadState();
  if (r.unpaired) return showPairing();
  offline = r.offline; $('offline').hidden = !offline;
  if (!r.state) return;
  const changed = !S || S.version !== r.state.version;
  S = r.state;
  if (changed) { checkEpoch(); applyTheme(); renderAll(); prefetch(); }
  if (!started) { started = true; showCenter(); runShow(); }
  ping();
}

// Предпросмотр из админки («Оформление»): страница в рамке получает настройки сразу, до сохранения.
// На настоящих экранах ничего не делает: isPreview там ложь.
window.previewSettings = patch => {
  if (!S || !isPreview) return;
  S = { ...S, ...patch, look: { ...(S.look || {}), ...(patch.look || {}) } };
  applyTheme(); renderAll(); showCenter();
};
setInterval(tick, 1000);
setInterval(refresh, REFRESH_MS);
// ночью (в 03:00) повторно прогреваем кэш медиа
setInterval(() => { const n = schoolNow(S && S.tz); if (S && n.h === 3 && n.m === 0 && n.s < 30) prefetch(); }, 30000);
refresh().then(tick);
