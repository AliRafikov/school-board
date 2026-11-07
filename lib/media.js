// Загрузка постеров и видео. Общая для админки и Telegram-бота: одни и те же проверки, сжатие и запись в журнал.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, audit } = require('./db');
const S = require('./sync');

let sharp = null; try { sharp = require('sharp'); } catch { /* сжатие картинок включится, если установить sharp */ }

const MAX_IMAGE = 15 * 1024 * 1024, MAX_VIDEO = 30 * 1024 * 1024, MAX_PDF = 30 * 1024 * 1024;
const PLACES = ['screen', 'center', 'banner'];
const KIND_RU = { image: 'картинка', video: 'видео', pdf: 'презентация' };

class MediaError extends Error { constructor(message, code = 400) { super(message); this.code = code; } }

// тип файла определяем по началу содержимого, а не по имени
function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', ext: '.jpg' };
  if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', ext: '.png' };
  if (buf.slice(0, 5).toString() === '%PDF-') return { kind: 'pdf', ext: '.pdf' };
  if (buf.length > 12 && buf.slice(4, 8).toString() === 'ftyp') return { kind: 'video', ext: '.mp4' };
  return null;
}

async function compressImage(buf, ext) {
  if (!sharp || buf.length <= 500 * 1024) return { buf, ext };
  let q = 82, out = buf;
  for (let i = 0; i < 5; i++) {
    out = await sharp(buf).rotate().resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (out.length <= 500 * 1024) break; q -= 12;
  }
  return { buf: out, ext: '.jpg' };
}

// Сохраняет файл и ставит его в показ. user — кто загрузил; source — откуда ('admin' или 'telegram').
async function saveMedia({ buf, name = '', title = '', place = 'screen', duration = 0, user, source = 'admin' }) {
  const info = sniff(buf);
  if (!info) throw new MediaError('Поддерживаются JPG, PNG, PDF и MP4', 400);
  const limit = info.kind === 'video' ? MAX_VIDEO : info.kind === 'pdf' ? MAX_PDF : MAX_IMAGE;
  if (buf.length > limit) throw new MediaError(`Файл больше ${Math.round(limit / 1048576)} МБ`, 413);
  let { ext } = info, data = buf;
  if (info.kind === 'image') ({ buf: data, ext } = await compressImage(buf, ext));
  const file = crypto.randomBytes(10).toString('hex') + ext;
  fs.writeFileSync(path.join(S.MEDIA, file), data);
  const label = String(title || '').slice(0, 120) || String(name || 'Без названия').replace(/\.[^.]+$/, '').slice(0, 120) || 'Без названия';
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM media').get().m;
  // длительность ролика берёт браузер админки при загрузке; если не получилось — 30 с. Картинке — 10 с
  const reqDur = Math.round(Number(duration));
  const dur = info.kind === 'video' ? (reqDur >= 1 ? Math.max(3, Math.min(600, reqDur)) : 30) : 10;
  const r = db.prepare('INSERT INTO media(file,kind,title,duration,sort,size,created_by,created_at,place) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(file, info.kind, label, dur, maxSort + 1, data.length, user.name, Date.now(), PLACES.includes(place) ? place : 'screen');
  audit({ source, user, action: 'media_uploaded', target: label, now: `${KIND_RU[info.kind]}, ${Math.round(data.length / 1024)} КБ` });
  S.bump();
  return db.prepare('SELECT * FROM media WHERE id=?').get(Number(r.lastInsertRowid));
}

// Убирает файл из показа и с диска
function deleteMedia(id, user, source = 'admin') {
  const row = db.prepare('SELECT * FROM media WHERE id=?').get(Number(id));
  if (!row) return null;
  db.prepare('DELETE FROM media WHERE id=?').run(row.id);
  try { fs.unlinkSync(path.join(S.MEDIA, row.file)); } catch { /* файла уже нет */ }
  audit({ source, user, action: 'media_deleted', target: row.title });
  S.bump();
  return row;
}

module.exports = { MediaError, MAX_IMAGE, MAX_VIDEO, MAX_PDF, PLACES, sniff, saveMedia, deleteMedia, hasSharp: !!sharp };
