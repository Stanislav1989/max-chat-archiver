/* Демо-архив: прогоняет реалистичный ответ API через extract.js и common.js,
 * складывает dist/demo/chat.html + файлы + dist/demo-archive.zip.
 * Запуск: node test/make-demo.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('../common.js');
const X = require('../extract.js');

/* ---------- генератор PNG без зависимостей ---------- */
function png(width, height, color) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = (color[0] + Math.round((x / width) * 50)) & 0xff;
      raw[o + 1] = (color[1] + Math.round((y / height) * 40)) & 0xff;
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

const t = (day, hh, mm) => Date.UTC(2026, 10, day, hh - 5, mm, 0); // Екатеринбург, UTC+5

const api = {
  data: {
    chat: {
      id: 'chat-42', title: 'Проект «Северный»', type: 'CHAT', participantsCount: 3,
      participants: [
        { id: 'u1', name: 'Анна Петрова' },
        { id: 'u2', name: 'Иван Сидоров' },
        { id: 'u3', name: 'Мария Ковалёва' }
      ]
    },
    messages: [
      { id: 'd1', time: t(18, 9, 12), senderId: 'u1', text: 'Коллеги, добрый день! Скидываю финальную версию сметы на согласование.',
        attachments: [{ type: 'FILE', file: { url: 'https://cdn.max.ru/f/smeta.xlsx', name: 'Смета_2026.xlsx', size: 184320 } }] },
      { id: 'd2', time: t(18, 9, 40), senderId: 'u2', text: 'Спасибо, посмотрел. По разделу 3 есть вопросы — скину комментарии отдельно.' },
      { id: 'd3', time: t(18, 9, 41), senderId: 'u1', text: 'Ок, жду до вечера.' },
      { id: 'd4', time: t(19, 8, 55), senderId: 'u3', text: 'Доброе утро! Пара кадров со вчерашней встречи.' },
      { id: 'd5', time: t(19, 8, 56), senderId: 'u3', text: '',
        attachments: [
          { type: 'PHOTO', photo: { url: 'https://cdn.max.ru/f/meet1.jpg' }, name: 'встреча-1.jpg', size: 245760 },
          { type: 'PHOTO', photo: { url: 'https://cdn.max.ru/f/meet2.jpg' }, name: 'встреча-2.jpg', size: 262144 }
        ] },
      { id: 'd6', time: t(19, 9, 3), senderId: 'u2', text: 'Спасибо! Пришлите ещё презентацию, пожалуйста.' },
      { id: 'd7', time: t(19, 9, 10), senderId: 'u3', text: 'Вот она.',
        attachments: [{ type: 'FILE', file: { url: 'https://cdn.max.ru/f/deck.pdf', name: 'Презентация.pdf', size: 3481600 } }] },
      { id: 'd8', time: t(19, 9, 30), senderId: 'u1', text: '',
        attachments: [{ type: 'VOICE', voice: { url: 'https://cdn.max.ru/f/voice.ogg' }, duration: 42, size: 88000 }] },
      { id: 'd9', time: t(19, 10, 5), senderId: 'u2', edited: true,
        text: 'Ссылка на регламент: https://max.ru/docs/regulations — посмотрите п. 4.2.\nТам как раз про сроки согласования.' },
      { id: 'd10', time: t(19, 10, 7), senderId: 'u1', text: 'Принято 👍', reactions: [{ emoji: '👍', count: 2 }, { emoji: '🔥', count: 1 }] },
      { id: 'd11', time: t(20, 11, 2), text: 'Иван добавил Марию Ковалёву в чат' },
      { id: 'd12', time: t(20, 11, 15), senderId: 'u3',
        text: 'Коллеги, я собрала все правки в один список:\n1. Уточнить смету по разделу 3.\n2. Согласовать сроки до 25 ноября.\n3. Отправить финальную презентацию заказчику.\n\nЕсли что-то упустила — допишите.' },
      { id: 'd13', time: t(20, 11, 40), senderId: 'u2', forwardedFrom: { name: 'Сергей Кузнецов' },
        text: 'Пересылаю ответ подрядчика: «Сроки сдвигаются на неделю из-за поставки».' },
      { id: 'd14', time: t(20, 11, 45), senderId: 'u1', text: 'Тогда фиксируем: до 25 ноября смета, до 28-го — презентация.' }
    ]
  }
};

const exp = X.createExtractor();
exp.ingest('https://web.max.ru/api/graphql', JSON.stringify(api));
const model = exp.getModel();

const outDir = path.join(__dirname, '..', 'dist', 'demo');
const filesDir = path.join(outDir, 'files');
fs.mkdirSync(filesDir, { recursive: true });

const mediaFiles = {
  'https://cdn.max.ru/f/meet1.jpg': { name: '0001_2026-11-19_встреча-1.jpg', data: png(720, 420, [70, 110, 170]) },
  'https://cdn.max.ru/f/meet2.jpg': { name: '0002_2026-11-19_встреча-2.jpg', data: png(640, 640, [150, 90, 60]) },
  'https://cdn.max.ru/f/smeta.xlsx': { name: '0003_2026-11-18_Смета_2026.xlsx', data: Buffer.from('PK\u0003\u0004 demo xlsx') },
  'https://cdn.max.ru/f/deck.pdf': { name: '0004_2026-11-19_Презентация.pdf', data: Buffer.from('%PDF-1.4 demo') },
  'https://cdn.max.ru/f/voice.ogg': { name: '0005_2026-11-19_voice.ogg', data: Buffer.from('OggS demo') }
};

for (const key of Object.keys(mediaFiles)) {
  fs.writeFileSync(path.join(filesDir, mediaFiles[key].name), mediaFiles[key].data);
}

const html = C.renderArchive({
  chat: model.chat,
  messages: model.messages,
  stats: { participants: 3, filesIncluded: 5, filesSkipped: 0 },
  media: function (att) {
    const m = mediaFiles[att.url];
    if (m) return { href: 'files/' + m.name, downloaded: true };
    return att.url ? { href: att.url, downloaded: false } : null;
  },
  warnings: [],
  createdAt: Date.UTC(2026, 10, 20, 12, 0, 0),
  pageUrl: 'https://web.max.ru/',
  version: '1.0.0'
});

fs.writeFileSync(path.join(outDir, 'chat.html'), html, 'utf8');

const enc = new TextEncoder();
const entries = [{ name: 'chat.html', data: enc.encode(html) }];
for (const key of Object.keys(mediaFiles)) entries.push({ name: 'files/' + mediaFiles[key].name, data: new Uint8Array(mediaFiles[key].data) });
entries.push({ name: 'README.txt', data: enc.encode('Демонстрационный архив переписки MAX\r\nОткройте chat.html после распаковки.') });

(async () => {
  const blob = C.makeZip(entries);
  const buf = Buffer.from(await blob.arrayBuffer());
  fs.writeFileSync(path.join(__dirname, '..', 'dist', 'demo-archive.zip'), buf);
  console.log('сообщений:', model.messages.length, '| участников:', model.stats.participants, '| чат:', model.chat.title);
  console.log('dist/demo/chat.html, dist/demo-archive.zip (' + buf.length + ' байт)');
})();
