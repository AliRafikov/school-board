// Погода для табло: Open-Meteo (бесплатно, без ключа). Город задан координатами (Нижнекамск).
// Ответ кэшируется на 15 минут. Если сети нет, отдаётся последнее известное значение.
const LAT = 55.63, LON = 51.82;
const TEXT = c => c === 0 ? 'ясно' : c <= 2 ? 'переменная облачность' : c === 3 ? 'пасмурно' : (c === 45 || c === 48) ? 'туман'
  : (c >= 51 && c <= 67) || (c >= 80 && c <= 82) ? 'дождь' : (c >= 71 && c <= 77) || c === 85 || c === 86 ? 'снег' : c >= 95 ? 'гроза' : '';
let cache = { at: 0, data: null };
async function weather() {
  if (cache.data && Date.now() - cache.at < 15 * 60e3) return cache.data;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,weather_code&timezone=Europe%2FMoscow`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('сервис погоды ответил кодом ' + r.status);
    const j = await r.json();
    const c = j.current || {};
    if (typeof c.temperature_2m !== 'number') throw new Error('нет данных');
    cache = { at: Date.now(), data: { temp: Math.round(c.temperature_2m), code: c.weather_code, text: TEXT(c.weather_code) } };
  } catch (e) {
    // в терминал пишем причину, чтобы её было видно; экран покажет прошлое значение или скроет погоду
    console.warn('Погода не загружена:', e.message || e, '(попробую снова через 15 минут или при следующем обращении)');
    cache.at = Date.now() - 10 * 60e3; // повтор через 5 минут, а не через 15
  }
  return cache.data;
}
module.exports = { weather };
