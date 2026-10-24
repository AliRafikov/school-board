// Читатель .xlsx без внешних зависимостей: это zip с XML внутри, распаковка — встроенный zlib.
// Возвращает { name: rows }, где rows — массив строк, а ячейка — строка, число, Date (если формат ячейки — дата) или ''.
// Объединённые ячейки читаются как значение верхней левой ячейки (остальные пусты), как и в Excel.
const zlib = require('zlib');

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Файл не похож на xlsx (нет оглавления архива)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Повреждённый архив xlsx');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const loc = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const dstart = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
    const raw = buf.subarray(dstart, dstart + csize);
    files[name] = method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: 40 * 1024 * 1024 }) : raw; // защита от «zip-бомбы»
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(+c)).replace(/&amp;/g, '&');
const xmlText = s => unesc((s.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(''));
const attr = (s, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(s); return m ? unesc(m[1]) : null; };

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function dateFormats(styles) {
  const custom = {};
  for (const m of (styles.match(/<numFmt\s[^>]*\/>/g) || [])) custom[attr(m, 'numFmtId')] = attr(m, 'formatCode') || '';
  const xfs = (styles.match(/<cellXfs[\s\S]*?<\/cellXfs>/) || [''])[0];
  return (xfs.match(/<xf\s[^>]*?(?:\/>|>)/g) || []).map(x => {
    const id = Number(attr(x, 'numFmtId') || 0);
    if (BUILTIN_DATE.has(id)) return true;
    const code = custom[id];
    return code !== undefined && /[dmy]/i.test(code.replace(/"[^"]*"/g, '')) && !/0\.0/.test(code);
  });
}

function colIndex(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

function readXlsx(buf) {
  const f = unzip(buf);
  const get = n => (f[n] ? f[n].toString('utf8') : '');
  const shared = (get('xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) || []).map(xmlText);
  const isDate = dateFormats(get('xl/styles.xml'));
  const rels = {};
  for (const r of (get('xl/_rels/workbook.xml.rels').match(/<Relationship\s[^>]*\/>/g) || [])) rels[attr(r, 'Id')] = attr(r, 'Target');
  const out = {};
  for (const sh of (get('xl/workbook.xml').match(/<sheet\s[^>]*\/>/g) || [])) {
    const name = attr(sh, 'name'), rid = attr(sh, 'r:id');
    let target = rels[rid] || '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    const xml = get(target);
    const rows = [];
    for (const m of xml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = " " + m[1], body = m[2] || '';
      const ref = attr(a, 'r'), t = attr(a, 't'), s = Number(attr(a, 's') || 0);
      const rm = /^([A-Z]+)(\d+)$/.exec(ref || ''); if (!rm) continue;
      const r = Number(rm[2]) - 1, c = colIndex(rm[1]);
      const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = xmlText(body);
      else if (t === 'str') val = unesc(v || '');
      else if (t === 'b') val = v === '1';
      else if (t === 'e') val = '';
      else if (v !== undefined && v !== '') {
        const num = Number(v);
        val = isDate[s] && Number.isFinite(num) ? new Date(Date.UTC(1899, 11, 30) + Math.floor(num) * 86400000) : num;
      }
      if (val === '' || val === null) continue;
      (rows[r] ||= [])[c] = val;
    }
    out[name] = Array.from({ length: rows.length }, (_, i) => rows[i] ? Array.from({ length: rows[i].length }, (_, j) => rows[i][j] ?? '') : []);
  }
  return out;
}

module.exports = { readXlsx };
