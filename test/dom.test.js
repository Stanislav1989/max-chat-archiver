/* Тесты DOM-сбора: jsdom + подставные размеры элементов (layout в jsdom нет). */
'use strict';

const path = require('path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  ({ JSDOM } = require('./.deps/node_modules/jsdom'));
}

const HTML = `<!doctype html><html><body>
<div id="scroller">
  <div class="day">18 июля</div>
  <div class="row own"><div class="bubble"><div class="txt">Добрый день ещё раз. Пришлось зарегаться тут)</div><div class="tm">11:01 ✓✓</div></div></div>
  <div class="row other"><div class="ava">А</div><div class="bubble"><div class="txt">Пробку уберу</div><div class="tm">11:01 ✓✓</div></div></div>
  <div class="row other"><div class="ava">А</div><div class="bubble"><img src="/img/dom1.png" alt="фото участка"><div class="txt">В первый раз вывозим, надеюсь проблем не будет</div><div class="tm">11:01 ✓✓</div></div></div>
  <div class="row own"><div class="bubble"><div class="txt">Хорошо, отпишусь как всё прошло</div><div class="tm">11:03 ✓✓</div></div></div>
  <div class="row other"><div class="bubble"><div class="file"><span>Смета_2026.xlsx</span></div><div class="txt">Смотрите смету</div><div class="tm">11:04</div></div></div>
  <div class="day">20 июля</div>
  <div class="row other"><div class="bubble"><div class="txt">Добрый день, не забыли про нас?)</div><div class="tm">15:28 ✓✓</div></div></div>
</div>
</body></html>`;

const dom = new JSDOM(HTML, { url: 'https://web.max.ru/chat/1' });
const { window } = dom;
global.Node = window.Node;
global.document = window.document;

// подставные размеры: jsdom не считает layout
const rects = new WeakMap();
const orig = window.Element.prototype.getBoundingClientRect;
window.Element.prototype.getBoundingClientRect = function () {
  const r = rects.get(this);
  if (!r) return orig.call(this);
  return { left: r.left, top: r.top || 0, width: r.width, height: r.height, right: r.left + r.width, bottom: (r.top || 0) + r.height };
};
const rectFor = (el) => {
  if (el.id === 'scroller') return { left: 0, width: 1000, height: 600 };
  if (el.classList.contains('row')) return el.classList.contains('own') ? { left: 620, width: 320, height: 60 } : { left: 20, width: 420, height: 60 };
  if (el.classList.contains('bubble')) return el.closest('.row').classList.contains('own') ? { left: 620, width: 320, height: 55 } : { left: 20, width: 420, height: 55 };
  if (el.tagName === 'IMG') return { left: 30, width: 200, height: 150 };
  if (el.classList.contains('ava')) return { left: 0, width: 40, height: 40 };
  return { left: 0, width: 100, height: 18 };
};
document.querySelectorAll('*').forEach((el) => rects.set(el, rectFor(el)));

const Dom = require('../dom.js');

let checks = 0, fails = 0;
function ok(cond, label, extra) {
  checks++;
  if (!cond) { fails++; console.log('  FAIL: ' + label + (extra ? ' -> ' + extra : '')); }
  else console.log('  ok:   ' + label);
}
function eq(a, b, label) { ok(a === b, label, 'получено ' + JSON.stringify(a) + ', ожидалось ' + JSON.stringify(b)); }

console.log('\n[DOM] сбор сообщений с экрана');
const container = document.getElementById('scroller');
const msgs = Dom.scan(container, { chatTitle: 'Ассенизатор П БОРОВСКИЙ-ВИНЗИЛЫ', selfLabel: 'Вы', nowMs: Date.UTC(2026, 10, 25) });

console.log('  найдено:', msgs.length);
eq(msgs.length, 6, 'шесть сообщений');
eq(msgs.filter(m => m.own).length, 2, 'два своих сообщения');
eq(msgs.filter(m => m.author === 'Вы').length, 2, 'свои подписаны «Вы»');
eq(msgs[0].text, 'Добрый день ещё раз. Пришлось зарегаться тут)', 'текст очищен от времени и галочек');
eq(msgs[1].text, 'Пробку уберу', 'текст второго сообщения');

const photo = msgs.find(m => m.attachments.some(a => a.kind === 'image'));
ok(!!photo, 'сообщение с картинкой найдено');
eq(photo && photo.attachments[0].url, 'https://web.max.ru/img/dom1.png', 'ссылка на картинку');
eq(photo && photo.attachments[0].name, 'фото участка', 'alt картинки как имя');
ok(photo && photo.text.indexOf('В первый раз') === 0, 'текст рядом с картинкой сохранён');

const fileMsg = msgs.find(m => m.attachments.some(a => a.kind === 'file'));
ok(!!fileMsg, 'сообщение с файлом найдено');
eq(fileMsg && fileMsg.attachments[0].name, 'Смета_2026.xlsx', 'имя файла из карточки');
eq(fileMsg && fileMsg.text, 'Смотрите смету', 'имя файла убрано из текста');

const d1 = new Date(msgs[0].timeMs);
eq(d1.getFullYear(), 2026, 'год определён');
eq(d1.getMonth(), 6, 'месяц — июль');
eq(d1.getDate(), 18, 'день — 18');
eq(new Date(msgs[0].timeMs).getHours(), 11, 'часы');
eq(new Date(msgs[0].timeMs).getMinutes(), 1, 'минуты');

const last = msgs[msgs.length - 1];
eq(new Date(last.timeMs).getDate(), 20, 'второй разделитель дня применился');

const sorted = msgs.every((m, i, arr) => i === 0 || arr[i - 1].timeMs <= m.timeMs);
ok(sorted, 'порядок по времени');

// повторное сканирование не должно дублировать
const again = Dom.scan(container, { chatTitle: 'Ассенизатор', selfLabel: 'Вы', nowMs: Date.UTC(2026, 10, 25) });
eq(again.length, 6, 'повторный скан даёт те же 6 (дедуп по подписи)');

/* ===== точный разбор реальной разметки MAX (Svelte) ===== */

console.log('\n[MAX] точный разбор разметки web.max.ru');

const MAX_HTML = `<!doctype html><html><body><div id="c">
  <div class="item" data-index="0">
    <div class="capsuleSeparator"><span class="systemCapsule">18 июля</span></div>
    <div role="listitem" class="block">
      <div class="messageWrapper messageWrapper--isOut"><div class="message message--isOut"><div class="bubble"><div class="bubbleContent"><span class="text" data-message-markup="">Ок</span></div></div></div></div>
      <span class="meta"><div class="meta--text"><span class="text">11:01</span></div></span>
    </div>
    <div role="listitem" class="block">
      <div class="messageWrapper messageWrapper--isOut"><div class="message message--isOut"><div class="bubble"><div class="bubbleContent"><span class="text" data-message-markup="">Ок</span></div></div></div></div>
      <span class="meta"><div class="meta--text"><span class="text">11:01</span></div></span>
    </div>
  </div>
  <div class="item" data-index="1">
    <div class="capsuleSeparator"><span class="systemCapsule">Иван добавил Марию в чат</span></div>
    <div role="listitem" class="block">
      <div class="messageWrapper"><div class="message"><div class="bubble"><div class="bubbleContent"><div class="media"><img src="/img/photo.png" alt="фото"></div></div></div></div>
      <span class="meta"><div class="meta--text"><span class="text">11:05</span></div></span>
    </div>
  </div>
</div></body></html>`;

const maxDom = new JSDOM(MAX_HTML, { url: 'https://web.max.ru/' });
const maxContainer = maxDom.window.document.getElementById('c');
const maxMsgs = Dom.scan(maxContainer, { chatTitle: 'Тестовый чат', selfLabel: 'Вы', nowMs: Date.UTC(2026, 10, 25) });

eq(maxMsgs.length, 4, 'четыре сообщения (два одинаковых «Ок» сохранены)');
eq(maxMsgs.filter(m => m.text === 'Ок').length, 2, 'одинаковые сообщения не склеиваются');
eq(maxMsgs.filter(m => m.author === 'Система').length, 1, 'системная плашка распознана');
const foto = maxMsgs.find(m => m.attachments.some(a => a.kind === 'image'));
ok(!!foto, 'сообщение-картинка без текста сохранено');
eq(foto && foto.attachments[0].url, 'https://web.max.ru/img/photo.png', 'ссылка на картинку из разметки MAX');
eq(new Date(maxMsgs[0].timeMs).getDate(), 18, 'дата из capsuleSeparator');

console.log('\nИтог DOM: проверок ' + checks + ', ошибок ' + fails);
process.exit(fails ? 1 : 0);