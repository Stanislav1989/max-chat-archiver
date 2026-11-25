/* MAX Chat Archiver — сбор переписки прямо из DOM.
 *
 * web.max.ru общается с сервером по бинарному WebSocket (protobuf), поэтому
 * JSON-перехват ловит не всё. Зато DOM всегда содержит то, что видит
 * пользователь. Здесь два разборщика:
 *
 *   1. scanMax     — точный, под реальную разметку web.max.ru (Svelte):
 *                    .item -> .block[role=listitem], .messageWrapper--isOut,
 *                    .bubbleContent span.text[data-message-markup],
 *                    .meta--text (время), .capsuleSeparator (дата), .reaction.
 *   2. scanGeneric — эвристика на случай, если разметку поменяют.
 *
 * Модуль чистый: работает с переданным элементом-контейнером.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__maxArchiverDom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MONTHS = {
    'января': 0, 'январь': 0, 'янв': 0,
    'февраля': 1, 'февраль': 1, 'фев': 1, 'февр': 1,
    'марта': 2, 'март': 2, 'мар': 2,
    'апреля': 3, 'апрель': 3, 'апр': 3,
    'мая': 4, 'май': 4,
    'июня': 5, 'июнь': 5, 'июн': 5,
    'июля': 6, 'июль': 6, 'июл': 6,
    'августа': 7, 'август': 7, 'авг': 7,
    'сентября': 8, 'сентябрь': 8, 'сен': 8, 'сент': 8,
    'октября': 9, 'октябрь': 9, 'окт': 9,
    'ноября': 10, 'ноябрь': 10, 'ноя': 10, 'нояб': 10,
    'декабря': 11, 'декабрь': 11, 'дек': 11
  };

  var EN_MONTHS = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11
  };

  var TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*[✓✔]{1,2})?\s*$/;
  var TIME_ANY_RE = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/;
  var TIME_EXTRACT = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;

  var FILE_RE = /([^\s\\/:*?"<>|]{1,120}\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|txt|csv|json|xml|djvu|epub|fb2|jpe?g|png|webp|gif|heic|mp4|mov|webm|avi|mkv|mp3|ogg|m4a|wav|opus))(?![a-z0-9])/i;

  /* ===================== базовые утилиты ===================== */

  function textOf(el) {
    if (!el) return '';
    var t = el.innerText;
    if (t == null) t = el.textContent;
    return String(t).replace(/\u00a0/g, ' ').replace(/\u200b/g, '').trim();
  }

  function docOrder(a, b) {
    var pos = a.compareDocumentPosition(b);
    if (pos & 4) return -1;   // DOCUMENT_POSITION_FOLLOWING
    if (pos & 2) return 1;    // DOCUMENT_POSITION_PRECEDING
    return 0;
  }

  function hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h;
  }

  function dayKeyOf(ms) {
    var d = new Date(ms);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function parseDaySeparator(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 40) return null;
    if (/^(сегодня|today)$/i.test(t)) return { today: true };
    if (/^(вчера|yesterday)$/i.test(t)) return { yesterday: true };
    var m = /^(\d{1,2})\s+([а-яёa-z]+)\.?,?\s*(\d{4})?\s*(?:г\.?)?$/i.exec(t);
    if (!m) return null;
    var word = m[2].toLowerCase().replace(/\.$/, '');
    var month = MONTHS[word];
    if (month == null) month = EN_MONTHS[word];
    if (month == null) return null;
    return { day: Number(m[1]), month: month, year: m[3] ? Number(m[3]) : null };
  }

  /* Состояние календаря: разделители дней идут по возрастанию даты. */
  function makeDateTracker(now) {
    return {
      date: null,
      year: new Date(now).getFullYear(),
      prevMonth: null,
      apply: function (sep) {
        if (sep.today) {
          var d = new Date(now);
          this.date = { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
          return;
        }
        if (sep.yesterday) {
          var y = new Date(now - 86400000);
          this.date = { year: y.getFullYear(), month: y.getMonth(), day: y.getDate() };
          return;
        }
        var yr = sep.year;
        if (yr == null) {
          yr = this.year;
          var guess = new Date(yr, sep.month, sep.day);
          if (guess.getTime() > now + 86400000) yr = yr - 1;
          if (this.prevMonth != null && sep.month < this.prevMonth) yr = this.year + 1;
        }
        this.date = { year: yr, month: sep.month, day: sep.day };
        this.year = yr;
        this.prevMonth = sep.month;
      },
      ms: function (hour, minute) {
        var base = this.date;
        if (!base) {
          var d = new Date(now);
          base = { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
        }
        return new Date(base.year, base.month, base.day, hour || 0, minute || 0, 0, 0).getTime();
      }
    };
  }

  /* ===================== точный разбор web.max.ru ===================== */

  function maxText(block) {
    var nodes = block.querySelectorAll('.bubbleContent span.text[data-message-markup]');
    if (!nodes.length) nodes = block.querySelectorAll('.bubbleContent span.text');
    var parts = [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].closest('.meta')) continue;          // время, а не текст
      var t = textOf(nodes[i]);
      if (t) parts.push(t);
    }
    if (parts.length) return parts.join('\n');
    // запасной вариант: весь пузырь без меты
    var bc = block.querySelector('.bubbleContent');
    return bc ? textOf(bc) : '';
  }

  function maxAttachments(block, text) {
    var out = [];

    var imgs = block.querySelectorAll('.bubbleContent img, .bubble img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (img.closest('a.container')) continue;         // превью ссылки
      if (img.closest('.reactions, .animoji, .messageControls')) continue;
      var src = img.currentSrc || img.src || '';
      if (!src) continue;
      var w = img.naturalWidth || 0;
      var rw = 0;
      try { rw = img.getBoundingClientRect().width || 0; } catch (e) {}
      if ((w && w < 70) || (!w && rw && rw < 70)) continue;   // смайлик/аватар
      out.push({ kind: 'image', url: src, name: img.getAttribute('alt') || '' });
    }

    var videos = block.querySelectorAll('.bubbleContent video, .bubble video');
    for (var v = 0; v < videos.length; v++) {
      var vsrc = videos[v].currentSrc || videos[v].src || '';
      if (vsrc) out.push({ kind: 'video', url: vsrc, name: '' });
    }

    var audios = block.querySelectorAll('.bubbleContent audio, .bubble audio');
    for (var a = 0; a < audios.length; a++) {
      var asrc = audios[a].currentSrc || audios[a].src || '';
      if (asrc) out.push({ kind: 'audio', url: asrc, name: '' });
    }

    var link = block.querySelector('a.container[href]');
    if (link) {
      var title = textOf(link.querySelector('.title'));
      var desc = textOf(link.querySelector('.description'));
      var host = textOf(link.querySelector('.host'));
      out.push({
        kind: 'link',
        url: link.getAttribute('href'),
        name: title || host || link.getAttribute('href'),
        text: desc
      });
    }

    var fm = FILE_RE.exec(text || '');
    if (fm) {
      var dup = out.some(function (x) { return x.name === fm[1]; });
      if (!dup) out.push({ kind: 'file', url: '', name: fm[1] });
    }
    return out;
  }

  function maxReactions(block) {
    var out = [];
    var nodes = block.querySelectorAll('.reaction');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var emoji = textOf(n.querySelector('.animoji')) || n.getAttribute('data-emoji') || '';
      var count = textOf(n.querySelector('.counter'));
      if (!emoji && !count) continue;
      out.push((emoji + (count ? ' ' + count : '')).trim());
    }
    return out;
  }

  function scanMax(container, opts) {
    if (!container || !container.querySelectorAll) return null;
    // .item — группа сообщений, поэтому идём по плоскому списку в порядке документа:
    // разделители дней и все блоки сообщений (querySelectorAll сохраняет порядок)
    var nodes = container.querySelectorAll('.capsuleSeparator, .block');
    if (!nodes.length) return null;

    var now = opts.nowMs || Date.now();
    var chatTitle = opts.chatTitle || 'Собеседник';
    var selfLabel = opts.selfLabel || 'Вы';
    var tracker = makeDateTracker(now);
    var messages = [];
    var occurrences = {};
    var lastMs = null;

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];

      if (node.classList && node.classList.contains('capsuleSeparator')) {
        var capText = textOf(node.querySelector('.systemCapsule') || node);
        var sep = parseDaySeparator(capText);
        if (sep) { tracker.apply(sep); continue; }
        if (!capText) continue;
        // системное сообщение («Иван добавил Марию в чат»)
        var sms = lastMs != null ? lastMs + 1 : tracker.ms(0, 0);
        messages.push({
          source: 'dom',
          id: 'dom-sys-' + Math.abs(hash(sms + '|' + capText)),
          timeMs: sms,
          own: false,
          author: 'Система',
          text: capText,
          edited: false,
          reactions: [],
          attachments: []
        });
        lastMs = sms;
        continue;
      }

      var block = node;
      var own = !!block.querySelector('.messageWrapper--isOut, .message--isOut');
      var text = maxText(block);
      var metaEl = block.querySelector('.meta--text') || block.querySelector('.meta');
      var metaText = metaEl ? textOf(metaEl) : '';
      var tm = TIME_EXTRACT.exec(metaText) || TIME_EXTRACT.exec(textOf(block));
      var hour = tm ? Number(tm[1]) : 0;
      var minute = tm ? Number(tm[2]) : 0;
      var ms = tracker.ms(hour, minute);

      var atts = maxAttachments(block, text);
      var author = own ? selfLabel : (textOf(block.querySelector('.senderName, .sender, .authorName, .author .name')) || chatTitle);
      var isForwarded = !!block.querySelector('.link .forward, .forward');
      if (isForwarded && !text) {
        text = textOf(block.querySelector('.forward .text, .mark .text'));
      }
      var edited = /ред\.|изменено/i.test(metaText);
      var reactions = maxReactions(block);

      // сообщение без текста и вложений тоже сохраняем (плейсхолдер/удалённое),
      // но только если это действительно блок сообщения
      if (!text && !atts.length && !block.querySelector('.messageWrapper, .bubbleContent')) continue;

      var signature = dayKeyOf(ms) + '|' + hour + ':' + minute + '|' + author + '|' + text.slice(0, 120) + '|' + atts.length;
      occurrences[signature] = (occurrences[signature] || 0) + 1;
      var unique = signature + '#' + occurrences[signature];

      messages.push({
        source: 'dom',
        id: 'dom-' + Math.abs(hash(unique)),
        timeMs: ms,
        own: own,
        author: author,
        text: text,
        edited: edited,
        reactions: reactions,
        attachments: atts
      });
      lastMs = ms;
    }

    messages.sort(function (a, b) { return a.timeMs - b.timeMs; });
    return messages;
  }

  /* ===================== эвристический разбор (запасной) ===================== */

  function isCandidate(el, container) {
    if (!el || el === container) return false;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SVG' ||
      tag === 'PATH' || tag === 'IMG' || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SCRIPT' ||
      tag === 'STYLE' || tag === 'A') return false;

    var text = textOf(el);
    var m = TIME_RE.exec(text);
    var media = el.querySelector && el.querySelector('img,video,audio');

    if (!m) {
      if (!media) return false;
      if (!hasBigMedia(el)) return false;
      if (text.length > 2500) return false;
      var rr = el.getBoundingClientRect();
      return rr.width >= 60 && rr.height >= 40;
    }

    var rest = text.slice(0, m.index).trim();
    if (!rest && !media) return false;
    if (text.length > 8000) return false;

    var r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 12) return false;
    return true;
  }

  function hasBigMedia(el) {
    var media = el.querySelectorAll('img,video');
    for (var i = 0; i < media.length; i++) {
      var r = media[i].getBoundingClientRect();
      if (r.width >= 80 && r.height >= 60) return true;
    }
    return false;
  }

  function collectCandidates(container) {
    var all = container.querySelectorAll('*');
    var cands = [];
    for (var i = 0; i < all.length; i++) {
      if (isCandidate(all[i], container)) cands.push(all[i]);
    }
    var set = new Set(cands);
    return cands.filter(function (el) {
      for (var i = 0; i < cands.length; i++) {
        var other = cands[i];
        if (other !== el && set.has(other) && el.contains(other)) return false;
      }
      return true;
    });
  }

  function collectMedia(el) {
    var out = [];
    var images = el.querySelectorAll('img');
    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      var r = img.getBoundingClientRect();
      var src = img.currentSrc || img.src || '';
      if (!src) continue;
      if (r.width < 70 || r.height < 70) continue;
      out.push({ kind: 'image', url: src, name: img.getAttribute('alt') || '' });
    }
    var videos = el.querySelectorAll('video');
    for (var v = 0; v < videos.length; v++) {
      var vsrc = videos[v].currentSrc || videos[v].src || '';
      if (vsrc) out.push({ kind: 'video', url: vsrc, name: '' });
    }
    var audios = el.querySelectorAll('audio');
    for (var a = 0; a < audios.length; a++) {
      var asrc = audios[a].currentSrc || audios[a].src || '';
      if (asrc) out.push({ kind: 'audio', url: asrc, name: '' });
    }
    var fm = FILE_RE.exec(textOf(el));
    if (fm) out.push({ kind: 'file', url: '', name: fm[1] });
    return out;
  }

  function cleanText(text) {
    var t = String(text || '');
    var m = TIME_RE.exec(t);
    if (m) t = t.slice(0, m.index);
    t = t.replace(/^\s*ред\.?\s*$/gim, '');
    t = t.replace(/\s*ред\.\s*$/i, '');
    t = t.replace(/\s*[✓✔]{1,2}\s*$/g, '');
    return t.trim();
  }

  function isOwn(el, container) {
    try {
      var r = el.getBoundingClientRect();
      var c = container.getBoundingClientRect();
      if (!c.width) return false;
      return (r.left + r.width / 2) > (c.left + c.width / 2) + 10;
    } catch (e) { return false; }
  }

  function authorOf(el, container) {
    var p = el.parentElement;
    for (var depth = 0; depth < 3 && p && p !== container; depth++, p = p.parentElement) {
      var kids = p.children;
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k === el || k.contains(el)) break;
        var t = textOf(k);
        if (!t || t.length > 60) continue;
        if (t.length <= 2) continue;
        if (TIME_ANY_RE.test(t)) continue;
        if (/^[\d\s.,:]+$/.test(t)) continue;
        try {
          var rk = k.getBoundingClientRect();
          if (rk.width > 0 && rk.width <= 46 && rk.height <= 46) continue;
        } catch (e) {}
        return t;
      }
    }
    return null;
  }

  function scanGeneric(container, opts) {
    var now = opts.nowMs || Date.now();
    var chatTitle = opts.chatTitle || 'Собеседник';
    var selfLabel = opts.selfLabel || 'Вы';

    var cands = collectCandidates(container);
    var items = cands.map(function (el) { return { type: 'msg', el: el }; });

    var all = container.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children && el.children.length > 1) continue;
      var t = textOf(el);
      if (!t || t.length > 40) continue;
      var sep = parseDaySeparator(t);
      if (sep) items.push({ type: 'day', el: el, sep: sep });
    }

    items.sort(function (a, b) { return docOrder(a.el, b.el); });

    var tracker = makeDateTracker(now);
    var messages = [];
    var seen = new Set();

    for (var k = 0; k < items.length; k++) {
      var item = items[k];
      if (item.type === 'day') { tracker.apply(item.sep); continue; }

      var block = item.el;
      var full = textOf(block);
      var tm = TIME_EXTRACT.exec(full);
      var hour = tm ? Number(tm[1]) : 0;
      var minute = tm ? Number(tm[2]) : 0;
      var ms = tracker.ms(hour, minute);

      var text = cleanText(full);
      var media = collectMedia(block);
      for (var f = 0; f < media.length; f++) {
        if (media[f].kind === 'file' && media[f].name) {
          text = text.split(media[f].name).join(' ').replace(/\s{2,}/g, ' ').trim();
        }
      }
      text = text.replace(/\b(скачать|сохранить|открыть)\b/gi, ' ').replace(/\s{2,}/g, ' ').trim();
      if (!text && !media.length) continue;

      var own = isOwn(block, container);
      var author = authorOf(block, container) || (own ? selfLabel : chatTitle);

      var signature = dayKeyOf(ms) + '|' + hour + ':' + minute + '|' + author + '|' + text.slice(0, 120) + '|' + media.length;
      if (seen.has(signature)) continue;
      seen.add(signature);

      messages.push({
        source: 'dom',
        id: 'dom-' + Math.abs(hash(signature)),
        timeMs: ms,
        own: own,
        author: author,
        text: text,
        edited: false,
        reactions: [],
        attachments: media
      });
    }

    messages.sort(function (a, b) { return a.timeMs - b.timeMs; });
    return messages;
  }

  function scan(container, opts) {
    opts = opts || {};
    if (!container) return [];
    var exact = scanMax(container, opts);
    if (exact && exact.length) return exact;
    return scanGeneric(container, opts);
  }

  return {
    scan: scan,
    scanMax: scanMax,
    scanGeneric: scanGeneric,
    parseDaySeparator: parseDaySeparator,
    dayKeyOf: dayKeyOf
  };
});
