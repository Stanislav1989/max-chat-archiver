/* E2E-стенд: локальная страница, повторяющая поведение web.max.ru —
 * история подгружается порциями при прокрутке вверх, DOM размечен как чат
 * (пузыри, свои/чужие, разделители дней, картинки, карточки файлов).
 * Сетевого API нет намеренно: проверяем именно сбор с экрана.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('../../common.js');

const TOTAL = 40;
const PAGE = 20;
const PORT = 8765;

/* ---------- PNG без зависимостей ---------- */
function png(width, height, color) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = (color[0] + Math.round((x / width) * 40)) & 0xff;
      raw[o + 1] = (color[1] + Math.round((y / height) * 30)) & 0xff;
      raw[o + 2] = color[2] & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw);
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(C.crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const IMG = png(320, 240, [70, 110, 170]);

function msg(i) {
  const day = i <= 20 ? 18 : 20;
  const time = Date.UTC(2026, 6, day, 8, 0, 0) + i * 60000; // июль 2026
  const d = new Date(time);
  const hh = d.getUTCHours();
  const mm = d.getUTCMinutes();
  return {
    i: i,
    text: 'Сообщение #' + i + (i % 6 === 0 ? '\nвторая строка' : ''),
    own: i % 2 === 0,
    hh: hh,
    mm: mm,
    img: i % 5 === 0,
    file: i % 7 === 0 ? 'файл-' + i + '.pdf' : null
  };
}

function pageHtml() {
  const all = [];
  for (let i = 1; i <= TOTAL; i++) all.push(msg(i));

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Ассенизатор П БОРОВСКИЙ-ВИНЗИЛЫ</title>
<style>
body{margin:0;font:14px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif;background:#cfe8fb}
header{padding:10px 16px;background:#fff;border-bottom:1px solid #ddd}
#scroller{height:560px;overflow-y:auto;padding:10px}
.capsuleSeparator{text-align:center;margin:10px 0}
.systemCapsule{background:#dbe7f0;border-radius:10px;padding:2px 10px;font-size:12px;color:#456}
.block{margin:4px 0}
.messageWrapper{display:flex}
.messageWrapper--isOut{justify-content:flex-end}
.bubble{background:#fff;border-radius:12px;padding:8px 10px;max-width:65%}
.message--isOut .bubble{background:#d9f7c4}
.meta--text{color:#789;font-size:11px;text-align:right;margin-top:2px}
.bubbleContent img{display:block;width:240px;height:180px;border-radius:8px;margin-bottom:4px}
</style></head><body>
<header><b>Ассенизатор П БОРОВСКИЙ-ВИНЗИЛЫ</b></header>
<div id="scroller"></div>
<script>
var ALL = ${JSON.stringify(all)};
var PAGE = ${PAGE};
var loadedFrom = ALL.length - PAGE;
var sc = document.getElementById('scroller');

function render(m) {
  var item = document.createElement('div');
  item.className = 'item';
  var block = document.createElement('div');
  block.className = 'block'; block.setAttribute('role', 'listitem');

  var wrap = document.createElement('div');
  wrap.className = 'messageWrapper' + (m.own ? ' messageWrapper--isOut' : '');
  var msg = document.createElement('div');
  msg.className = 'message' + (m.own ? ' message--isOut' : '');
  var bubble = document.createElement('div');
  bubble.className = 'bubble';
  var content = document.createElement('div');
  content.className = 'bubbleContent';

  if (m.img) {
    var media = document.createElement('div'); media.className = 'media';
    var im = document.createElement('img'); im.src = '/img/' + m.i + '.png'; im.alt = 'фото ' + m.i;
    media.appendChild(im); content.appendChild(media);
  }
  if (m.text) {
    var tx = document.createElement('span');
    tx.className = 'text'; tx.setAttribute('data-message-markup', '');
    tx.textContent = m.text;
    content.appendChild(tx);
  }
  bubble.appendChild(content);
  msg.appendChild(bubble);
  wrap.appendChild(msg);
  block.appendChild(wrap);

  var meta = document.createElement('span'); meta.className = 'meta';
  var metaText = document.createElement('div'); metaText.className = 'meta--text';
  var tm = document.createElement('span'); tm.className = 'text';
  tm.textContent = (m.hh < 10 ? '0' + m.hh : m.hh) + ':' + (m.mm < 10 ? '0' + m.mm : m.mm);
  metaText.appendChild(tm);
  meta.appendChild(metaText);
  block.appendChild(meta);

  item.appendChild(block);
  return item;
}

function dayLabel(m) { return m.i <= 20 ? '18 июля' : '20 июля'; }

function sepEl(label) {
  var item = document.createElement('div'); item.className = 'item';
  var sep = document.createElement('div'); sep.className = 'capsuleSeparator';
  var cap = document.createElement('span'); cap.className = 'systemCapsule'; cap.textContent = label;
  sep.appendChild(cap); item.appendChild(sep);
  return item;
}

function appendChunk(from, to, prepend) {
  var frag = document.createDocumentFragment();
  var lastDay = null;
  for (var i = from; i < to; i++) {
    var m = ALL[i];
    var dl = dayLabel(m);
    if (dl !== lastDay) { frag.appendChild(sepEl(dl)); lastDay = dl; }
    frag.appendChild(render(m));
  }
  if (prepend) sc.insertBefore(frag, sc.firstChild);
  else sc.appendChild(frag);
}
appendChunk(loadedFrom, ALL.length, false);

var loading = false;
sc.addEventListener('scroll', function () {
  if (loading || sc.scrollTop > 40 || loadedFrom <= 0) return;
  loading = true;
  var to = loadedFrom;
  loadedFrom = Math.max(0, loadedFrom - PAGE);
  var before = sc.scrollHeight;
  appendChunk(loadedFrom, to, true);
  sc.scrollTop += (sc.scrollHeight - before);
  loading = false;
});
</script></body></html>`;
}

function startServer() {
  const logFile = path.join(__dirname, 'log.txt');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
    if (url.pathname === '/log') {
      const msg = url.searchParams.get('m') || '';
      fs.appendFileSync(logFile, Date.now() + ' ' + msg + '\n');
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pageHtml());
      return;
    }
    if (url.pathname.indexOf('/img/') === 0) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
      res.end(IMG);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

module.exports = { startServer: startServer };
