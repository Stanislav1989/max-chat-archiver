/* Тесты MAX Chat Archiver: извлечение сообщений, рендер HTML, сборка ZIP.
 * Запуск: node test/test.js  (из папки max-archiver)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('../common.js');
const X = require('../extract.js');

let failures = 0;
let checks = 0;

function ok(cond, label, extra) {
  checks++;
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + label + (extra ? '  -> ' + extra : ''));
  } else {
    console.log('  ok:   ' + label);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, 'получено ' + JSON.stringify(actual) + ', ожидалось ' + JSON.stringify(expected));
}

/* ===================== фикстуры ===================== */

const gql = {
  data: {
    chat: {
      id: 'chat1',
      title: 'Рабочий чат',
      type: 'CHAT',
      participantsCount: 3,
      participants: [
        { id: 'u1', name: 'Анна Петрова' },
        { id: 'u2', name: 'Иван Сидоров' }
      ]
    },
    messages: [
      {
        id: 'm1', time: 1690000000000, senderId: 'u1', text: 'Привет! Вот документ',
        attachments: [{ type: 'FILE', file: { url: 'https://cdn.max.ru/files/doc.pdf', name: 'Договор.pdf', size: 123456 } }]
      },
      {
        id: 'm2', time: 1690000060000, senderId: 'u2', text: 'Спасибо, посмотрю',
        attachments: [{ type: 'PHOTO', photo: { url: 'https://cdn.max.ru/f/photo1.jpg' }, name: 'photo1.jpg', size: 54321 }]
      },
      {
        id: 'm3', time: 1690000120000, senderId: 'u1', text: 'И ещё голосовое',
        attachments: [{ type: 'VOICE', voice: { url: 'https://cdn.max.ru/f/voice.ogg' }, duration: 12 }]
      },
      {
        id: 'sys1', time: 1690000180000, text: 'Анна создала чат'
      }
    ]
  }
};

const tamtam = {
  messages: [
    {
      sender: { id: 'u2', name: 'Иван Сидоров' },
      timestamp: 1690100000000,
      body: {
        mid: 'tm1', seq: 1, text: 'Второй источник',
        attachments: [{ type: 'image', payload: { photo: { url: 'https://cdn.max.ru/t/photo2.jpg' } } }]
      }
    }
  ]
};

const wsUpdate = {
  updateType: 'MESSAGE_CREATED',
  message: {
    id: 'm1', time: 1690000000000, senderId: 'u1', text: 'Привет! Вот документ',
    attachments: [{ type: 'FILE', file: { url: 'https://cdn.max.ru/files/doc.pdf', name: 'Договор.pdf', size: 123456 } }]
  }
};

const wsNew = {
  updates: [{
    type: 'MESSAGE_CREATED',
    payload: { id: 987654321, timestamp: 1690200000, senderId: 'u2', text: 'Сообщение из вебсокета' }
  }]
};

/* Тот же текст/время, но другой id — должен склеиться по сигнатуре. */
const dupDifferentId = {
  messages: [{
    id: 'other-id', time: 1690000060000, senderId: 'u2', text: 'Спасибо, посмотрю',
    attachments: [{ type: 'PHOTO', photo: { url: 'https://cdn.max.ru/f/photo1.jpg' }, name: 'photo1.jpg', size: 54321 }]
  }]
};

const injection = {
  messages: [{
    id: 'xss1', time: 1690300000000, senderId: 'u1',
    text: '<script>alert(1)</script> и ссылка https://example.com/a?b=1&c=2'
  }]
};

/* ===================== извлечение ===================== */

console.log('\n[1] Извлечение сообщений');
const exp = X.createExtractor();
exp.ingest('https://web.max.ru/api/graphql', JSON.stringify(gql));
exp.ingest('https://web.max.ru/api/messages', JSON.stringify(tamtam));
exp.ingest('wss://web.max.ru/ws', JSON.stringify(wsUpdate));
exp.ingest('wss://web.max.ru/ws', JSON.stringify(wsNew));
exp.ingest('https://web.max.ru/api/dup', JSON.stringify(dupDifferentId));
exp.ingest('https://web.max.ru/api/xss', JSON.stringify(injection));

const model = exp.getModel();
console.log('  сообщений:', model.messages.length, '| участников:', model.stats.participants, '| чат:', model.chat && model.chat.title);

eq(model.chat && model.chat.title, 'Рабочий чат', 'название чата распознано');
eq(model.messages.length, 7, 'семь уникальных сообщений');
eq(model.messages.filter(m => m.text === 'Спасибо, посмотрю').length, 1, 'дубль с другим id склеен по сигнатуре');
ok(model.stats.participants >= 2, 'участники собраны', 'их ' + model.stats.participants);

const m1 = model.messages.find(m => m.id === 'm1');
ok(!!m1, 'сообщение m1 найдено');
eq(m1 && m1.author, 'Анна Петрова', 'автор m1 подставлен из справочника');
eq(m1 && m1.attachments.length, 1, 'у m1 одно вложение');
eq(m1 && m1.attachments[0].name, 'Договор.pdf', 'имя файла вложения');
eq(m1 && m1.attachments[0].size, 123456, 'размер вложения');
eq(m1 && m1.attachments[0].url, 'https://cdn.max.ru/files/doc.pdf', 'ссылка на файл');
eq(m1 && m1.attachments[0].kind, 'file', 'тип вложения file');

const m2 = model.messages.find(m => m.id === 'm2');
eq(m2 && m2.attachments[0].kind, 'image', 'фото распознано как image');
eq(m2 && m2.attachments[0].url, 'https://cdn.max.ru/f/photo1.jpg', 'ссылка на фото');

const m3 = model.messages.find(m => m.id === 'm3');
eq(m3 && m3.attachments[0].kind, 'audio', 'голосовое распознано как audio');

const tm1 = model.messages.find(m => m.id === 'tm1');
ok(!!tm1, 'сообщение из второго формата (body.mid) найдено');
eq(tm1 && tm1.author, 'Иван Сидоров', 'автор tm1 из sender.name');
eq(tm1 && tm1.text, 'Второй источник', 'текст tm1 из body.text');

const ws = model.messages.find(m => m.text === 'Сообщение из вебсокета');
ok(!!ws, 'сообщение из вебсокета найдено');
eq(ws && ws.timeMs, 1690200000000, 'время в секундах переведено в миллисекунды');
eq(ws && ws.id, '987654321', 'числовой id приведён к строке');

const sysMsg = model.messages.find(m => m.id === 'sys1');
eq(sysMsg && sysMsg.author, 'Система', 'системное сообщение без автора');

const sorted = model.messages.every((m, i, arr) => i === 0 || arr[i - 1].timeMs <= m.timeMs);
ok(sorted, 'сообщения отсортированы по времени');

/* ===================== рендер ===================== */

console.log('\n[2] Рендер HTML');
const html = C.renderArchive({
  chat: model.chat,
  messages: model.messages,
  stats: { participants: model.stats.participants, filesIncluded: 3, filesSkipped: 1 },
  media: function (att) {
    return att.url ? { href: 'files/' + (att.name || 'file'), downloaded: att.kind !== 'file' } : null;
  },
  warnings: ['Тестовое предупреждение'],
  createdAt: 1690400000000,
  version: '1.0.0'
});

ok(html.startsWith('<!DOCTYPE html>'), 'HTML начинается с doctype');
ok(html.indexOf('Рабочий чат') > 0, 'название чата в HTML');
ok(html.indexOf('Договор.pdf') > 0, 'имя файла в HTML');
ok(html.indexOf('files/Договор.pdf') > 0, 'ссылка на файл заменена на локальную');
ok(html.indexOf('<script>alert(1)</script>') < 0, 'XSS-текст экранирован');
ok(html.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') > 0, 'XSS-текст показан как текст');
ok(html.indexOf('href="https://example.com/a?b=1&amp;c=2"') > 0, 'ссылка в тексте стала кликабельной');
ok(html.indexOf('class="day"') > 0, 'разделители по дням есть');
ok(html.indexOf('id="q"') > 0, 'поиск по переписке есть');
ok(html.indexOf('в архиве') > 0, 'сводка по файлам есть');

/* ===================== ZIP ===================== */

console.log('\n[3] ZIP');
const enc = new TextEncoder();
const pdfBytes = new Uint8Array(2048);
for (let i = 0; i < pdfBytes.length; i++) pdfBytes[i] = (i * 37) & 0xff;
const jpgBytes = new Uint8Array(512);
for (let i = 0; i < jpgBytes.length; i++) jpgBytes[i] = (i * 11) & 0xff;

const blob = C.makeZip([
  { name: 'chat.html', data: enc.encode(html) },
  { name: 'README.txt', data: enc.encode('тест') },
  { name: 'files/Договор.pdf', data: pdfBytes },
  { name: 'files/photo1.jpg', data: jpgBytes }
]);

ok(blob && blob.size > html.length, 'ZIP собран', 'размер ' + blob.size);

const outDir = path.join(__dirname, '..', 'dist');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const buf = Buffer.from(await blob.arrayBuffer());
  fs.writeFileSync(path.join(outDir, 'test-archive.zip'), buf);
  fs.writeFileSync(path.join(outDir, 'demo-chat.html'), html, 'utf8');

  // сигнатура и EOCD на месте
  eq(buf.readUInt32LE(0), 0x04034b50, 'сигнатура локального заголовка');
  eq(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'сигнатура EOCD');
  eq(buf.readUInt16LE(buf.length - 22 + 10), 4, 'в EOCD записано 4 файла');

  console.log('\nИтог: проверок ' + checks + ', ошибок ' + failures);
  console.log('Файлы: dist/test-archive.zip, dist/demo-chat.html');
  process.exit(failures ? 1 : 0);
})();
