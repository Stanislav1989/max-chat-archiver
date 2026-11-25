/* Сборка .xpi: ZIP без внешних зависимостей (используется common.makeZip).
 * Запуск: npm run build
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('../common.js');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const FILES = [
  'manifest.json',
  'background.js',
  'page-hook.js',
  'common.js',
  'extract.js',
  'dom.js',
  'content.js',
  'README.md',
  'LICENSE'
];

function build() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  // проверяем, что все скрипты из манифеста на месте
  const declared = new Set();
  for (const cs of manifest.content_scripts || []) for (const f of cs.js || []) declared.add(f);
  for (const f of (manifest.background && manifest.background.scripts) || []) declared.add(f);
  const missing = [...declared].filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    console.error('В манифесте указаны отсутствующие файлы: ' + missing.join(', '));
    process.exit(1);
  }

  const enc = new TextEncoder();
  const entries = FILES.map((name) => {
    const full = path.join(ROOT, name);
    if (!fs.existsSync(full)) throw new Error('нет файла: ' + name);
    return { name: name, data: enc.encode(fs.readFileSync(full, 'utf8')) };
  });

  return C.makeZip(entries).arrayBuffer().then((buf) => {
    fs.mkdirSync(DIST, { recursive: true });
    const out = path.join(DIST, 'max-chat-archiver-' + manifest.version + '.xpi');
    fs.writeFileSync(out, Buffer.from(buf));
    // копия с постоянным именем — удобно для ссылок
    fs.writeFileSync(path.join(DIST, 'max-chat-archiver.xpi'), Buffer.from(buf));

    // чистая папка с тем же содержимым — её удобно подписывать через web-ext sign,
    // не рискуя затащить в пакет тесты, dist и node_modules
    const pkgDir = path.join(DIST, 'package');
    fs.rmSync(pkgDir, { recursive: true, force: true });
    fs.mkdirSync(pkgDir, { recursive: true });
    for (const name of FILES) fs.copyFileSync(path.join(ROOT, name), path.join(pkgDir, name));

    console.log('собрано: ' + out + ' (' + buf.byteLength + ' байт), версия ' + manifest.version);
    console.log('для подписи: dist/package/');
  });
}

build().catch((e) => {
  console.error('ошибка сборки: ' + e.message);
  process.exit(1);
});
