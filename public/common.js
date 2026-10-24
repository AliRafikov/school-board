// Общий код: загрузка состояния (с офлайн-запасом), время, текущий урок.
const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DAYS_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* квота/приватный режим */ } }
};

// Возвращает {state, offline}. При ошибке сети — последняя сохранённая версия.
async function loadState(url = '/api/state') {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 401) return { state: null, offline: false, unpaired: true }; // экран не привязан
    if (!r.ok) throw new Error(r.status);
    const state = await r.json();
    store.set('state', state);
    return { state, offline: false };
  } catch {
    return { state: store.get('state'), offline: true };
  }
}

const pad = n => String(n).padStart(2, '0');
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Локальное время школы (часовой пояс из сервера), независимо от настроек устройства.
function schoolNow(tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'Europe/Moscow', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
  }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  return {
    day: wd, iso: `${parts.year}-${parts.month}-${parts.day}`,
    h: +parts.hour % 24, m: +parts.minute, s: +parts.second,
    minutes: (+parts.hour % 24) * 60 + +parts.minute, seconds: ((+parts.hour % 24) * 60 + +parts.minute) * 60 + +parts.second
  };
}

// Что сейчас: {phase:'before'|'lesson'|'break'|'after'|'off', left (сек)}.
// У 5–7 и 8–11 классов звонки пересекаются — урок идёт, пока активен хотя бы один слот.
function currentSlot(bells, now) {
  bells = bells.filter(b => !b.meal); // завтрак и обед — не уроки
  if (now.day === 6 || !bells.length) return { phase: 'off' };
  const t = now.seconds, S = b => toMin(b.start) * 60, E = b => toMin(b.end) * 60;
  const active = bells.filter(b => t >= S(b) && t < E(b));
  if (active.length) return { phase: 'lesson', left: Math.min(...active.map(E)) - t, n: active[0].n };
  const next = bells.filter(b => S(b) > t).sort((a, b) => S(a) - S(b))[0];
  if (!next) return { phase: 'after' };
  const anyBefore = bells.some(b => E(b) <= t);
  return { phase: anyBefore ? 'break' : 'before', left: S(next) - t, n: next.n };
}

function fmtLeft(sec) { const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return h ? `${h}:${pad(m)}:${pad(sec % 60)}` : `${pad(m)}:${pad(sec % 60)}`; }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function lessonCell(l, compact) {
  if (!l) return '';
  const was = l.was ? `<span class="was">было: ${esc(l.was.subject)}${l.was.room ? ', к.' + esc(l.was.room) : ''}</span>` : '';
  const cls = l.was ? ' changed' : '';
  const sub = [l.teacher, l.room && 'к.' + l.room].filter(Boolean).join(' · ');
  return `<div class="lesson${cls}"><b>${esc(l.subject)}</b>${compact || !sub ? '' : `<small>${esc(sub)}</small>`}${was}${l.was ? '<i class="badge">изм.</i>' : ''}</div>`;
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
