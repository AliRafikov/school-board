// Резервная копия: база (целостный снимок), загруженные постеры/ролики и служебные файлы.
// Запуск: npm run backup   (на сервере — раз в неделю по таймеру systemd)
// Куда: BACKUP_DIR (по умолчанию ./backups рядом с data), хранится KEEP последних копий (по умолчанию 8).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sqlite = require('node:sqlite');
const { db, DATA } = require('../lib/db');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA, '..', 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 8);

(async () => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const stage = fs.mkdtempSync(path.join(BACKUP_DIR, '.stage-'));
  try {
    // 1. база: встроенный backup() даёт целостный снимок даже при работающем сервере
    if (typeof sqlite.backup === 'function') await sqlite.backup(db, path.join(stage, 'app.db'));
    else { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); fs.copyFileSync(path.join(DATA, 'app.db'), path.join(stage, 'app.db')); }
    // 2. файлы
    for (const f of ['snapshot.json', 'changes.json']) if (fs.existsSync(path.join(DATA, f))) fs.copyFileSync(path.join(DATA, f), path.join(stage, f));
    if (fs.existsSync(path.join(DATA, 'media'))) fs.cpSync(path.join(DATA, 'media'), path.join(stage, 'media'), { recursive: true });
    if (fs.existsSync(path.join(DATA, 'brand'))) fs.cpSync(path.join(DATA, 'brand'), path.join(stage, 'brand'), { recursive: true });
    // 3. архив
    const out = path.join(BACKUP_DIR, `school-board-${stamp}.tar.gz`);
    execFileSync('tar', ['-czf', out, '-C', stage, '.']);
    fs.chmodSync(out, 0o600); // в базе хэши паролей — копия не должна быть читаема всеми
    const mb = (fs.statSync(out).size / 1048576).toFixed(1);
    console.log(`Копия создана: ${out} (${mb} МБ)`);
    // 4. удаляем старые
    const all = fs.readdirSync(BACKUP_DIR).filter(f => /^school-board-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - KEEP))) { fs.unlinkSync(path.join(BACKUP_DIR, f)); console.log('Удалена старая копия:', f); }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
})().catch(e => { console.error('Ошибка резервного копирования:', e.message); process.exit(1); });
