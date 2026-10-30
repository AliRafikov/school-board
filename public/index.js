// Публичная страница «/» для родителей: класс, день недели, замены, звонки и объявления. Без входа.
let S = null, day = 0;
const $ = id => document.getElementById(id);
const grade = c => parseInt(c, 10) || 0;

// дата урока для дня недели: текущая неделя; в воскресенье показываем следующую
function isoForDay(i) {
  const t = schoolNow(S.tz);
  const cur = t.day > 5 ? -1 : t.day;
  const d = new Date(t.iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + (i - cur));
  return d.toISOString().slice(0, 10);
}
const fmtDate = iso => iso.split('-').reverse().join('.');

// звонок, который относится к параллели класса (диапазон классов из листа «Звонки»)
function bellFor(n, cls) {
  return S.bells.find(b => {
    if (b.meal || b.n !== n) return false;
    const nums = (String(b.label || '').match(/\d+/g) || []).map(Number);
    return !nums.length || (grade(cls) >= Math.min(...nums) && grade(cls) <= Math.max(...nums));
  });
}

// уроки класса на день: постоянное расписание + замены этой даты
function lessonsFor(cls, i) {
  const iso = isoForDay(i);
  const base = (S.schedule[cls] || {})[i] || [];
  const ov = ((S.overlay || {})[iso] || {})[cls] || {};
  const out = base.map(l => {
    const o = ov[l.n];
    if (!o) return l;
    return o.cancelled ? { ...l, cancelled: true } : { ...l, ...o };
  });
  for (const k of Object.keys(ov)) if (!base.some(l => String(l.n) === k)) out.push({ ...ov[k] });
  return out.sort((a, b) => a.n - b.n);
}

function lessonRow(l, cls) {
  const b = bellFor(l.n, cls);
  const time = b ? `${b.start}–${b.end}` : '';
  const cls2 = [l.was ? 'chg' : '', l.cancelled ? 'off' : ''].filter(Boolean).join(' ');
  const body = l.cancelled
    ? '<b>Урок отменён</b>'
    : `<b>${esc(l.subject)}</b><small>${esc([l.teacher, l.room && 'каб. ' + l.room].filter(Boolean).join(' · '))}</small>`;
  const was = l.was ? `<span class="was">было: ${esc(l.was.subject)}${l.was.room ? ', каб. ' + esc(l.was.room) : ''}</span>` : '';
  return `<div class="les ${cls2}"><div class="n">${esc(l.n)}<small>${esc(time)}</small></div><div>${body}${was}</div></div>`;
}

function render() {
  if (!S) { $('day').textContent = 'Данные пока недоступны'; return; }
  const cls = $('cls').value;
  store.set('cls', cls);
  const t = schoolNow(S.tz);
  $('now').textContent = `${DAYS_FULL[t.day]}, ${pad(t.h)}:${pad(t.m)}`;
  $('tabs').innerHTML = DAYS.map((d, i) => `<button class="${i === day ? 'active' : ''}" data-d="${i}">${d}</button>`).join('');

  // замены этого класса на сегодня (без фамилий отсутствующих учителей)
  const subs = S.substitutions.filter(x => x.date === t.iso && x.classes.some(c => c.cls === cls));
  $('subsCard').hidden = !subs.length;
  $('subs').innerHTML = subs.map(x => {
    const note = (x.classes.find(c => c.cls === cls) || {}).note || '';
    return `<div class="sub"><b>${esc(x.lessons)} урок · ${esc(x.subject)}${x.room ? ' · каб. ' + esc(x.room) : ''}</b><small>${esc(x.teacher)}${note ? ' · ' + esc(note) : ''}</small></div>`;
  }).join('');

  // каникулы: вместо уроков — название и дата возвращения
  $('holidayCard').hidden = !S.holiday;
  $('holidayCard').innerHTML = S.holiday ? holidayHtml(S.holiday) : '';
  $('dayCard').hidden = !!S.holiday;
  $('dayTitle').textContent = `${DAYS_FULL[day]}, ${fmtDate(isoForDay(day))}, ${cls}`;
  const list = lessonsFor(cls, day);
  $('day').innerHTML = list.length ? list.map(l => lessonRow(l, cls)).join('') : '<p class="dim">Уроков нет</p>';

  $('bells').innerHTML = S.bells.map(b => `<tr class="${b.was || b.cancelled ? 'chg' : ''}"><td class="t">${esc(b.start)}–${esc(b.end)}</td><td>${b.meal ? esc(b.title) : 'Урок ' + esc(b.n)}${b.label ? ` <small>${esc(b.label)}</small>` : ''}${b.cancelled ? ' · отменён' : ''}</td></tr>`).join('');

  // объявления и постеры, которые действуют сегодня
  const posters = S.carousel.filter(i => i.kind === 'image' && (i.place === 'center' || i.place === 'banner')
    && (!i.from || i.from <= t.iso) && (!i.to || i.to >= t.iso));
  $('postersCard').hidden = !posters.length;
  $('posters').innerHTML = posters.slice(0, 12).map(i => `<img src="${esc(i.url)}" alt="${esc(i.title)}" loading="lazy">`).join('');

  $('upd').textContent = 'Обновлено: ' + new Date(S.updatedAt).toLocaleString('ru-RU');
}

async function load() {
  const r = await loadState('/api/public/state');
  $('offline').hidden = !r.offline;
  if (!r.state) return render();
  const first = !S;
  S = r.state;
  if (S.logo) { $('logo').src = S.logo; $('logo').hidden = false; }
  if (S.schoolName) $('school').textContent = S.schoolName;
  const keep = $('cls').value || store.get('cls');
  $('cls').innerHTML = S.classes.map(c => `<option>${esc(c)}</option>`).join('');
  if (S.classes.includes(keep)) $('cls').value = keep;
  if (first) { const n = schoolNow(S.tz).day; day = n > 5 ? 0 : n; }
  render();
}

$('cls').onchange = render;
$('tabs').onclick = e => { const d = e.target.dataset.d; if (d != null) { day = +d; render(); } };
load();
setInterval(load, 60000);
