// Срочные сообщения на экранах: готовые тревоги, включение и отбой.
// Общий для сайта (админка) и Telegram-бота, чтобы правила и журнал были одинаковыми.
const { getSetting, setSetting, audit } = require('./db');
const S = require('./sync');

const PRESETS = [
  { id: 'missile', title: 'Ракетная опасность', end: 'Отбой ракетной опасности', source: 'МЧС России', note: 'Пройдите в укрытие. Следуйте указаниям учителей и администрации.' },
  { id: 'drone', title: 'Угроза атаки БПЛА', end: 'Отбой угрозы атаки БПЛА', source: 'МЧС России', note: 'Пройдите в укрытие. Следуйте указаниям учителей и администрации.' },
  { id: 'air', title: 'Воздушная тревога: всем в укрытие', end: 'Отбой воздушной тревоги', source: 'МЧС России', note: 'Следуйте указаниям учителей и администрации.' },
];

// Включить срочное сообщение. item: {title, source, note, end}
function start(item, user, source = 'admin') {
  setSetting('urgent_end', item.end || '');
  const since = Date.now();
  setSetting('urgent_title', item.title); setSetting('urgent_source', item.source || ''); setSetting('urgent_note', item.note || ''); setSetting('urgent_since', String(since));
  audit({ source, user, action: 'urgent_started', target: item.title, details: item.source || '' });
  S.bump();
  return { ok: true, active: true, since };
}

// Отключить: зелёный отбой держится на экранах пять минут, как и раньше
function stop(user, source = 'admin') {
  const prev = getSetting('urgent_title') || '';
  if (prev) {
    const low = prev.charAt(0).toLowerCase() + prev.slice(1);
    const t = Date.now();
    setSetting('clear_title', getSetting('urgent_end') || ('Отбой: ' + low));
    setSetting('clear_source', getSetting('urgent_source') || '');
    setSetting('clear_since', String(t));
    setSetting('clear_until', String(t + 5 * 60e3));
  }
  setSetting('urgent_title', ''); setSetting('urgent_since', '0');
  audit({ source, user, action: 'urgent_stopped', target: prev });
  S.bump();
  return { ok: true, active: false };
}

// Скрыть зелёный отбой сразу, не дожидаясь пяти минут
function hideClear(user, source = 'admin') {
  const until = Number(getSetting('clear_until')) || 0;
  if (until > Date.now()) {
    setSetting('clear_until', '0');
    audit({ source, user, action: 'clear_hidden', target: getSetting('clear_title') || 'отбой' });
    S.bump();
  }
  return { ok: true, active: false };
}

function status() {
  const title = getSetting('urgent_title') || '';
  return { active: !!title, title, source: getSetting('urgent_source') || '', since: Number(getSetting('urgent_since')) || 0 };
}

module.exports = { PRESETS, start, stop, hideClear, status };
