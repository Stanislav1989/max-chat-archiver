/* MAX Chat Archiver — контроллер (ISOLATED world).
 *
 * Отвечает за: панель управления на странице, автопрокрутку истории,
 * скачивание вложений, сборку ZIP с чатом в виде HTML.
 */
(function () {
  'use strict';

  var C = globalThis.__maxArchiverCommon;
  var X = globalThis.__maxArchiverExtract;
  var D = globalThis.__maxArchiverDom;
  if (!C || !X || globalThis.__maxArchiverContentLoaded) return;
  globalThis.__maxArchiverContentLoaded = true;

  var TAG_IN = 'max-archiver-hook';
  var TAG_OUT = 'max-archiver-content';

  var state = {
    exp: X.createExtractor(),
    busy: false,
    cancel: false,
    diag: [],
    diagBytes: 0,
    panel: null,
    pendingFetches: new Map(),
    fetchSeq: 0,
    bytes: 0,
    dom: new Map()
  };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function q(panelOrRoot, id) {
    var root = panelOrRoot && panelOrRoot.root ? panelOrRoot.root : panelOrRoot;
    return root ? root.querySelector('#' + id) : null;
  }

  /* ===================== приём перехваченных ответов ===================== */

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object') return;

    if (d.source === TAG_IN && typeof d.body === 'string') {
      if (d.kind === 'wsbin') {
        if (state.diagBytes < 30 * 1024 * 1024) {
          var b64 = d.body.length > 20000 ? d.body.slice(0, 20000) : d.body;
          state.diag.push({ kind: 'wsbin', url: d.url, ts: d.ts || Date.now(), base64: b64 });
          state.diagBytes += b64.length;
        }
        return;
      }
      try {
        state.exp.ingest(d.url, d.body);
      } catch (e) { /* битый ответ — не повод падать */ }
      if (state.diagBytes < 30 * 1024 * 1024) {
        var sample = d.body.length > 250000 ? d.body.slice(0, 250000) : d.body;
        state.diag.push({ kind: d.kind || 'http', url: d.url, ts: d.ts || Date.now(), sample: sample });
        state.diagBytes += sample.length;
      }
      if (state.panel && state.busy) refreshStatus();
      return;
    }

    if (d.source === TAG_OUT + '-fetch' && d.id != null) {
      var resolve = state.pendingFetches.get(d.id);
      if (resolve) { state.pendingFetches.delete(d.id); resolve(d); }
    }
  }, false);

  function pageFetch(url) {
    return new Promise(function (resolve) {
      var id = ++state.fetchSeq;
      var timer = setTimeout(function () {
        state.pendingFetches.delete(id);
        resolve(null);
      }, 120000);
      state.pendingFetches.set(id, function (d) {
        clearTimeout(timer);
        if (d && d.ok && d.buffer) {
          try { resolve(new Uint8Array(d.buffer)); return; } catch (e) {}
        }
        resolve(null);
      });
      try {
        window.postMessage({ source: TAG_OUT, type: 'fetch-file', id: id, url: url }, '*');
      } catch (e) {
        clearTimeout(timer);
        state.pendingFetches.delete(id);
        resolve(null);
      }
    });
  }

  async function fetchBinary(url) {
    if (!url) return null;
    if (/^data:/i.test(url)) return null;
    try {
      var res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
      if (res && res.ok) {
        var buf = await res.arrayBuffer();
        if (buf && buf.byteLength) return new Uint8Array(buf);
      }
    } catch (e) { /* CORS/401 — пробуем из контекста страницы */ }
    return await pageFetch(url);
  }

  /* ===================== панель ===================== */

  var PANEL_CSS = [
    ':host{all:initial}',
    '.panel{width:340px;max-width:92vw;background:#15181d;color:#e8eaee;border:1px solid #2b313b;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.45);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;overflow:hidden}',
    '.hdr{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1b1f26;border-bottom:1px solid #2b313b}',
    '.logo{font-weight:800;font-size:11px;letter-spacing:.08em;background:#2f6fed;color:#fff;border-radius:6px;padding:3px 6px}',
    '.ttl{font-weight:600;font-size:13px}',
    '.x{margin-left:auto;background:transparent;border:0;color:#9aa4b2;font-size:18px;line-height:1;cursor:pointer;padding:2px 4px}',
    '.x:hover{color:#fff}',
    '.status{padding:9px 12px;font-size:12.5px;color:#9aa4b2;border-bottom:1px solid #23282f}',
    '.row{padding:6px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
    '.row.two label{flex:1 1 120px}',
    'label{display:flex;align-items:center;gap:6px;font-size:12.5px;color:#c2c9d4;cursor:pointer}',
    'input[type=checkbox]{accent-color:#2f6fed;margin:0}',
    'input[type=number]{width:68px;background:#0f1216;border:1px solid #2b313b;border-radius:7px;color:#e8eaee;padding:4px 6px;font:inherit;font-size:12.5px}',
    '.btns{display:flex;gap:8px;padding:6px 12px 4px}',
    'button{flex:1;font:inherit;font-size:12.5px;font-weight:600;padding:8px 10px;border-radius:9px;border:1px solid #2b313b;background:#232831;color:#e8eaee;cursor:pointer}',
    'button:hover:not(:disabled){border-color:#3d4654;background:#2a303a}',
    'button:disabled{opacity:.45;cursor:default}',
    'button.primary{background:#2f6fed;border-color:#2f6fed;color:#fff}',
    'button.primary:hover:not(:disabled){background:#3d7bf5;border-color:#3d7bf5}',
    'button.ghost{background:transparent;font-weight:500;color:#c2c9d4}',
    '#log{margin:8px 0 0;padding:8px 12px 12px;max-height:150px;overflow:auto;font:11.5px/1.5 ui-monospace,Consolas,monospace;color:#8f9aa8;white-space:pre-wrap;word-break:break-word;border-top:1px solid #23282f}',
    '.hidden{display:none}'
  ].join('\n');

  /* Панель собирается через DOM API, а не через innerHTML: линтер AMO
     предупреждает о «unsafe assignment to innerHTML» даже для статической строки. */
  function node(tag, opts) {
    var n = document.createElement(tag);
    opts = opts || {};
    if (opts.cls) n.className = opts.cls;
    if (opts.id) n.id = opts.id;
    if (opts.text != null) n.textContent = opts.text;
    if (opts.title) n.title = opts.title;
    if (opts.type) n.type = opts.type;
    if (opts.value != null) n.value = opts.value;
    if (opts.checked) n.checked = true;
    for (var a in opts.attrs || {}) {
      if (Object.prototype.hasOwnProperty.call(opts.attrs, a)) n.setAttribute(a, opts.attrs[a]);
    }
    var kids = opts.children || [];
    for (var i = 0; i < kids.length; i++) if (kids[i]) n.appendChild(kids[i]);
    return n;
  }

  function buildPanelDom() {
    var media = node('input', { type: 'checkbox', id: 'opt-media', checked: true });
    var maxfile = node('input', { type: 'number', id: 'opt-maxfile', value: '100', attrs: { min: '0', step: '10' } });
    var cap = node('input', { type: 'number', id: 'opt-cap', value: '800', attrs: { min: '0', step: '100' } });

    return node('div', {
      cls: 'panel', children: [
        node('div', {
          cls: 'hdr', children: [
            node('span', { cls: 'logo', text: 'MAX' }),
            node('span', { cls: 'ttl', text: 'Chat Archiver' }),
            node('button', { cls: 'x', id: 'close', text: '×', title: 'Свернуть' })
          ]
        }),
        node('div', { cls: 'status', id: 'status', text: 'Готов. Откройте нужный чат.' }),
        node('div', {
          cls: 'row', children: [
            node('label', { children: [media, document.createTextNode(' скачивать файлы и медиа')] })
          ]
        }),
        node('div', {
          cls: 'row two', children: [
            node('label', { children: [document.createTextNode('макс. файл, МБ '), maxfile] }),
            node('label', { children: [document.createTextNode('лимит архива, МБ '), cap] })
          ]
        }),
        node('div', {
          cls: 'btns', children: [
            node('button', { cls: 'primary', id: 'btn-scroll', text: '1. Вся история' }),
            node('button', { id: 'btn-build', text: '2. Собрать архив' })
          ]
        }),
        node('div', {
          cls: 'btns', children: [
            node('button', { cls: 'ghost', id: 'btn-diag', text: 'Диагностика' }),
            node('button', { cls: 'ghost', id: 'btn-stop', text: 'Стоп' })
          ]
        }),
        node('pre', { id: 'log' })
      ]
    });
  }

  function ensurePanel() {
    if (state.panel && document.contains(state.panel.host)) return state.panel;

    var host = document.createElement('div');
    host.id = 'max-archiver-root';
    host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;';
    var root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = PANEL_CSS;
    root.appendChild(style);
    root.appendChild(buildPanelDom());
    (document.body || document.documentElement).appendChild(host);

    var el = function (id) { return q(panel, id); };
    var panel = { host: host, root: root, visible: true };

    el('close').addEventListener('click', function () { host.style.display = 'none'; panel.visible = false; });
    el('btn-scroll').addEventListener('click', function () { runScroll(); });
    el('btn-build').addEventListener('click', function () { runBuild(); });
    el('btn-stop').addEventListener('click', function () { state.cancel = true; log('Останавливаюсь…'); });
    el('btn-diag').addEventListener('click', function () { saveDiagnostics(); });

    state.panel = panel;
    refreshStatus();
    return panel;
  }

  function showPanel() {
    var p = ensurePanel();
    p.host.style.display = '';
    p.visible = true;
    return p;
  }

  function log(msg) {
    if (!state.panel) return;
    var pre = q(state.panel, 'log');
    if (!pre) return;
    var d = new Date();
    pre.textContent += '[' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '] ' + msg + '\n';
    pre.scrollTop = pre.scrollHeight;
  }

  function refreshStatus(extra) {
    if (!state.panel) return;
    var node = q(state.panel, 'status');
    if (!node) return;
    var parts = [];
    parts.push('Сеть: ' + state.exp.count());
    parts.push('с экрана: ' + state.dom.size);
    if (state.exp.usersCount()) parts.push('участников: ' + state.exp.usersCount());
    node.textContent = parts.join(' · ') + (extra ? ' · ' + extra : '');
    var b1 = q(state.panel, 'btn-scroll');
    var b2 = q(state.panel, 'btn-build');
    if (b1) b1.disabled = state.busy;
    if (b2) b2.disabled = state.busy;
  }

  function setBusy(v) {
    state.busy = v;
    refreshStatus();
  }

  /* ===================== автопрокрутка истории ===================== */

  function findMessageList() {
    var nodes = document.querySelectorAll('div,main,section,ul,ol,article');
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var sh = el.scrollHeight;
      var ch = el.clientHeight;
      if (sh - ch < 120) continue;
      var cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (!cs || !/(auto|scroll|overlay)/.test(cs.overflowY)) continue;
      var score = sh;
      try {
        var txt = (el.innerText || '').slice(0, 3000);
        if (/\b\d{1,2}:\d{2}\b/.test(txt)) score += 1e9;
      } catch (e) {}
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  async function loadAllHistory() {
    var el = findMessageList();
    if (!el) throw new Error('Не нашёл прокручиваемый список сообщений. Откройте чат и попробуйте снова.');

    scanVisible(el);
    log('Список найден. Кручу историю вверх…');
    var stagnant = 0;
    var t0 = Date.now();
    var iter = 0;

    while (!state.cancel) {
      iter++;
      if (Date.now() - t0 > 60 * 60 * 1000) { log('Остановка по таймауту (1 час).'); break; }
      if (iter > 20000) { log('Остановка: слишком много шагов.'); break; }

      var before = el.scrollHeight + '|' + state.exp.count();

      try {
        el.scrollTop = Math.min(240, Math.max(0, el.scrollHeight - el.clientHeight));
        await sleep(50);
        el.scrollTop = 0;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: -900, deltaMode: 0, bubbles: true, cancelable: true }));
      } catch (e) { /* контейнер мог исчезнуть */ }

      var grew = false;
      for (var w = 0; w < 8; w++) {
        await sleep(350);
        if (!document.contains(el)) { grew = true; break; }
        var after = el.scrollHeight + '|' + state.exp.count();
        if (after !== before) { grew = true; break; }
      }

      if (!grew) {
        stagnant++;
        log('Пока новых сообщений нет (' + stagnant + '/3)…');
        if (stagnant >= 3) { log('Достигнуто начало доступной истории.'); break; }
        await sleep(700 * stagnant);
      } else {
        stagnant = 0;
      }

      scanVisible(el);
      if (!document.contains(el)) el = findMessageList() || el;
      if (iter % 4 === 0) refreshStatus('шаг ' + iter);
    }
    scanVisible(el);
  }

  /* ===================== сбор из DOM ===================== */

  function currentChatTitle() {
    try {
      var h = document.querySelector('header');
      var t = h ? (h.innerText || '').split('\n')[0].trim() : '';
      if (t && t.length < 80) return t;
    } catch (e) {}
    return document.title || 'Собеседник';
  }

  function scanVisible(container) {
    if (!D) return;
    var el = container || findMessageList();
    if (!el) return;
    var found;
    try {
      found = D.scan(el, { chatTitle: currentChatTitle(), selfLabel: 'Вы' });
    } catch (e) {
      return;
    }
    for (var i = 0; i < found.length; i++) {
      var m = found[i];
      if (!state.dom.has(m.id)) state.dom.set(m.id, m);
    }
    refreshStatus();
  }

  async function runScroll() {
    if (state.busy) return;
    showPanel();
    setBusy(true);
    state.cancel = false;
    state.bytes = 0;
    try {
      await loadAllHistory();
      var model = state.exp.getModel();
      var merged = mergeSources(model, Array.from(state.dom.values()));
      var range = '';
      if (merged.messages.length) {
        range = C.fmtDate(merged.messages[0].timeMs) + ' — ' + C.fmtDate(merged.messages[merged.messages.length - 1].timeMs);
      }
      refreshStatus(range);
      log('Готово. Сообщений в архиве: ' + merged.messages.length +
        ' (из сети: ' + model.messages.length + ', с экрана: ' + state.dom.size + '). ' +
        (range ? 'Период: ' + range : ''));
      if (merged.messages.length === 0) {
        log('Данные не найдены. Откройте чат, прокрутите его и нажмите «1. Вся история» ещё раз. Если не поможет — «Диагностика».');
      }
    } catch (e) {
      log('Ошибка: ' + (e && e.message ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  /* ===================== объединение источников ===================== */

  function normText(t) {
    return String(t || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
  }

  function stamp(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + d.getHours() + ':' + d.getMinutes();
  }

  function mergeSources(model, domMessages) {
    var messages = model.messages.slice();
    var index = new Map();
    for (var i = 0; i < messages.length; i++) {
      index.set(stamp(messages[i].timeMs) + '|' + normText(messages[i].text), messages[i]);
    }

    var added = 0;
    for (var j = 0; j < domMessages.length; j++) {
      var d = domMessages[j];
      var key = stamp(d.timeMs) + '|' + normText(d.text);
      if (index.has(key)) continue;
      var atts = (d.attachments || []).map(function (a) {
        return { kind: a.kind, url: a.url || null, name: a.name || null, size: null };
      });
      var msg = {
        id: d.id,
        timeMs: d.timeMs,
        senderId: d.own ? 'self' : 'dom:' + (d.author || 'other'),
        author: d.own ? 'Вы' : (d.author || 'Собеседник'),
        text: d.text || '',
        attachments: atts,
        reactions: [],
        edited: false,
        source: 'dom'
      };
      messages.push(msg);
      index.set(key, msg);
      added++;
    }

    messages.sort(function (a, b) { return a.timeMs - b.timeMs; });
    var hasOwn = messages.some(function (m) { return m.senderId === 'self'; });

    return {
      messages: messages,
      selfId: hasOwn ? 'self' : model.selfId,
      chat: model.chat || (domMessages.length ? { title: currentChatTitle() } : null),
      addedFromDom: added,
      usedDom: added > 0,
      netCount: model.messages.length,
      domCount: domMessages.length
    };
  }

  /* ===================== сборка архива ===================== */

  function safeName(s, maxLen) {
    var out = String(s == null ? '' : s)
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    if (!out) out = 'chat';
    return out.slice(0, maxLen || 80);
  }

  function guessExt(att) {
    var mime = String(att.mime || '').toLowerCase();
    if (mime.indexOf('jpeg') >= 0) return '.jpg';
    if (mime.indexOf('png') >= 0) return '.png';
    if (mime.indexOf('webp') >= 0) return '.webp';
    if (mime.indexOf('gif') >= 0) return '.gif';
    if (mime.indexOf('mp4') >= 0) return '.mp4';
    if (mime.indexOf('webm') >= 0) return '.webm';
    if (mime.indexOf('mpeg') >= 0 && mime.indexOf('audio') >= 0) return '.mp3';
    if (mime.indexOf('ogg') >= 0) return '.ogg';
    if (mime.indexOf('pdf') >= 0) return '.pdf';
    if (att.kind === 'image') return '.jpg';
    if (att.kind === 'video') return '.mp4';
    if (att.kind === 'audio') return '.mp3';
    return '';
  }

  function makeFileName(att, index) {
    var d = att.timeMs ? new Date(att.timeMs) : new Date();
    var date = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    var base = att.name || '';
    if (!base && att.url) {
      try {
        var p = new URL(att.url, location.href).pathname;
        base = decodeURIComponent(p.split('/').pop() || '');
      } catch (e) { base = ''; }
    }
    base = safeName(base, 70);
    var hasExt = /\.[a-z0-9]{1,5}$/i.test(base);
    if (!hasExt) base += guessExt(att);
    if (!base || base === '.') base = 'file' + guessExt(att);
    return String(index + 1).padStart(4, '0') + '_' + date + '_' + base;
  }

  async function pool(items, limit, worker) {
    var results = new Array(items.length);
    var idx = 0;
    async function runner() {
      while (true) {
        var i = idx++;
        if (i >= items.length) return;
        try { results[i] = await worker(items[i], i); } catch (e) { results[i] = null; }
      }
    }
    var runners = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) runners.push(runner());
    await Promise.all(runners);
    return results;
  }

  function collectUniqueAttachments(model) {
    var seen = new Set();
    var list = [];
    for (var i = 0; i < model.messages.length; i++) {
      var atts = model.messages[i].attachments || [];
      for (var j = 0; j < atts.length; j++) {
        var a = atts[j];
        var key = a.url || a.dataUri || (a.kind + '|' + (a.name || '') + '|' + (a.text || ''));
        if (seen.has(key)) continue;
        seen.add(key);
        a.timeMs = model.messages[i].timeMs;
        list.push(a);
      }
    }
    return list;
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 180000);
  }

  async function runBuild() {
    if (state.busy) return;
    showPanel();
    var panel = state.panel;
    var mediaOn = q(panel, 'opt-media').checked;
    var maxFileMb = Number(q(panel, 'opt-maxfile').value) || 0;
    var capMb = Number(q(panel, 'opt-cap').value) || 0;

    var netModel = state.exp.getModel();
    var merged = mergeSources(netModel, Array.from(state.dom.values()));

    if (!merged.messages.length) {
      log('Сообщений нет. Сначала нажмите «1. Вся история» и дождитесь конца прокрутки.');
      return;
    }

    var authors = new Set();
    merged.messages.forEach(function (m) { if (m.author) authors.add(m.author); });
    var attachCount = 0;
    merged.messages.forEach(function (m) { attachCount += (m.attachments || []).length; });

    var model = {
      messages: merged.messages,
      chat: merged.chat,
      selfId: merged.selfId,
      stats: {
        total: merged.messages.length,
        participants: Math.max(netModel.stats.participants, authors.size),
        attachments: attachCount,
        responses: netModel.stats.responses
      },
      warnings: netModel.warnings.filter(function (w) {
        return !/не найдено ни одного сообщения|Название чата определить/i.test(w);
      })
    };

    if (merged.netCount === 0) {
      model.warnings.push('Ответы API перехватить не удалось (web.max.ru общается по бинарному WebSocket), поэтому архив собран с экрана. Тексты, время и картинки сохранены; точные ID, реакции и файлы-документы могут быть неполными.');
    } else if (merged.addedFromDom > 0) {
      model.warnings.push('Часть сообщений (' + merged.addedFromDom + ') добавлена с экрана, потому что их не было в перехваченных ответах API.');
    }

    setBusy(true);
    state.cancel = false;
    try {
      var atts = collectUniqueAttachments(model);
      log('Сообщений: ' + model.messages.length + ', уникальных вложений: ' + atts.length);

      var fileMap = new Map();      // url -> {path,size}
      var fileBytes = new Map();    // url -> Uint8Array
      var skipped = [];
      var totalBytes = 0;
      var capBytes = capMb > 0 ? capMb * 1024 * 1024 : Infinity;
      var fileLimit = maxFileMb > 0 ? maxFileMb * 1024 * 1024 : Infinity;
      var done = 0;

      if (mediaOn && atts.length) {
        var results = await pool(atts, 4, async function (a, i) {
          if (state.cancel) return null;
          if (!a.url || /^data:/i.test(a.url)) { skipped.push(a); return null; }
          if (a.size && a.size > fileLimit) { skipped.push(a); return null; }
          if (totalBytes >= capBytes) { skipped.push(a); return null; }

          var bytes = await fetchBinary(a.url);
          if (!bytes) { skipped.push(a); return null; }
          if (bytes.length > fileLimit || totalBytes + bytes.length > capBytes) { skipped.push(a); return null; }

          totalBytes += bytes.length;
          done++;
          if (done % 10 === 0) {
            log('Скачано файлов: ' + done + ' (' + C.fmtBytes(totalBytes) + ')');
            refreshStatus('файлов ' + done);
          }
          return { path: 'files/' + makeFileName(a, i), bytes: bytes };
        });

        for (var i = 0; i < atts.length; i++) {
          var r = results[i];
          if (r && r.bytes) {
            fileMap.set(atts[i].url, { path: r.path, size: r.bytes.length });
            fileBytes.set(atts[i].url, r.bytes);
          }
        }
        log('Файлов в архиве: ' + fileMap.size + ', пропущено: ' + skipped.length);
      }

      var warnings = model.warnings.slice();
      if (!mediaOn && atts.length) warnings.push('Скачивание файлов отключено — в архиве только ссылки на вложения (' + atts.length + ' шт.).');
      if (skipped.length) warnings.push('Часть файлов не попала в архив (' + skipped.length + '): превышен лимит размера/объёма или файл не отдаётся напрямую. Ссылки на них сохранены в HTML.');

      // метаданные о том, что попало в архив
      var mediaManifest = [];
      atts.forEach(function (a) {
        var f = a.url ? fileMap.get(a.url) : null;
        mediaManifest.push({
          kind: a.kind,
          name: a.name || null,
          size: a.size || null,
          url: a.url || null,
          file: f ? f.path : null,
          time: a.timeMs ? new Date(a.timeMs).toISOString() : null
        });
      });

      var createdAt = Date.now();
      var html = C.renderArchive({
        chat: model.chat,
        messages: model.messages,
        stats: {
          participants: model.stats.participants,
          filesIncluded: fileMap.size,
          filesSkipped: skipped.length
        },
        media: function (att) {
          if (att.dataUri) return { href: att.dataUri, downloaded: true };
          var f = att.url ? fileMap.get(att.url) : null;
          if (f) return { href: f.path, downloaded: true };
          if (att.url) return { href: att.url, downloaded: false };
          return null;
        },
        selfId: model.selfId,
        warnings: warnings,
        createdAt: createdAt,
        pageUrl: location.origin + location.pathname,
        version: '1.0.0',
        fallbackTitle: document.title || 'Переписка MAX'
      });

      var entries = [];
      var enc = new TextEncoder();
      entries.push({ name: 'chat.html', data: enc.encode(html) });
      entries.push({
        name: 'data/messages.json',
        data: enc.encode(JSON.stringify({
          chat: model.chat,
          stats: model.stats,
          selfId: model.selfId,
          messages: model.messages,
          attachments: mediaManifest
        }, null, 1))
      });
      if (state.diag.length) {
        entries.push({
          name: 'data/network-samples.json',
          data: enc.encode(JSON.stringify({ note: 'Образцы перехваченных ответов API (для диагностики)', samples: state.diag }, null, 1))
        });
      }

      var readme = [];
      readme.push('Архив переписки MAX');
      readme.push('=====================');
      readme.push('');
      readme.push('Чат: ' + (model.chat && model.chat.title ? model.chat.title : 'без названия'));
      readme.push('Сообщений: ' + model.messages.length);
      readme.push('Участников: ' + model.stats.participants);
      if (model.messages.length) {
        readme.push('Период: ' + C.fmtDateTime(model.messages[0].timeMs) + ' — ' + C.fmtDateTime(model.messages[model.messages.length - 1].timeMs));
      }
      readme.push('Файлов в архиве: ' + fileMap.size);
      readme.push('Ссылками (не скачаны): ' + skipped.length);
      readme.push('Архив создан: ' + C.fmtDateTime(createdAt));
      readme.push('');
      readme.push('Как открыть: распакуйте архив целиком и откройте chat.html в браузере.');
      readme.push('chat.html — сама переписка в виде чата, папка files/ — вложения,');
      readme.push('data/messages.json — те же сообщения в машинночитаемом виде.');
      readme.push('');
      if (skipped.length) {
        readme.push('Не попали в архив (ссылки сохранены в chat.html):');
        skipped.slice(0, 300).forEach(function (a, idx) {
          readme.push('  ' + (idx + 1) + '. ' + (a.name || a.kind) + (a.url ? ' — ' + a.url : ''));
        });
        if (skipped.length > 300) readme.push('  … и ещё ' + (skipped.length - 300));
      }
      entries.push({ name: 'README.txt', data: enc.encode(readme.join('\r\n')) });

      for (var m = 0; m < atts.length; m++) {
        var a2 = atts[m];
        if (!a2.url) continue;
        var f2 = fileMap.get(a2.url);
        var bytes2 = fileBytes.get(a2.url);
        if (!f2 || !bytes2) continue;
        entries.push({ name: f2.path, data: bytes2, date: new Date(a2.timeMs || createdAt) });
      }

      log('Собираю ZIP (' + entries.length + ' файлов)…');
      var blob = C.makeZip(entries);
      var title = safeName(model.chat && model.chat.title ? model.chat.title : 'max-chat', 60);
      var stamp = new Date(createdAt);
      var fname = title + '_' + stamp.getFullYear() + '-' + pad2(stamp.getMonth() + 1) + '-' + pad2(stamp.getDate()) + '_' + pad2(stamp.getHours()) + pad2(stamp.getMinutes()) + '.zip';
      saveBlob(blob, fname);
      log('Готово: ' + fname + ' (' + C.fmtBytes(blob.size) + '). Проверьте папку «Загрузки».');
    } catch (e) {
      log('Ошибка сборки: ' + (e && e.message ? e.message : e));
      console.error('[MAX Archiver]', e);
    } finally {
      setBusy(false);
    }
  }

  /* ===================== диагностика ===================== */

  function saveDiagnostics() {
    var model = state.exp.getModel();
    var resources = [];
    try {
      resources = performance.getEntriesByType('resource').map(function (e) { return e.name; }).slice(0, 800);
    } catch (e) {}
    var payload = {
      createdAt: new Date().toISOString(),
      page: location.href,
      userAgent: navigator.userAgent,
      counts: {
        networkMessages: model.messages.length,
        domMessages: state.dom.size,
        participants: model.stats.participants,
        responses: model.stats.responses
      },
      chat: model.chat,
      messagesSample: model.messages.slice(0, 30),
      domMessagesSample: Array.from(state.dom.values()).slice(0, 30),
      domSample: (function () {
        try {
          var el = findMessageList();
          return el ? el.innerHTML.slice(0, 300000) : '';
        } catch (e) { return ''; }
      })(),
      resources: resources,
      samples: state.diag
    };
    var enc = new TextEncoder();
    saveBlob(new Blob([enc.encode(JSON.stringify(payload, null, 1))], { type: 'application/json' }), 'max-archiver-diagnostics.json');
    log('Диагностика сохранена в «Загрузки».');
  }

  /* ===================== связь с background ===================== */

  if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.onMessage) {
    browser.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === 'toggle-panel') {
        var p = ensurePanel();
        if (p.visible) { p.host.style.display = 'none'; p.visible = false; }
        else { p.host.style.display = ''; p.visible = true; }
      }
      return false;
    });
  }

  // на случай, если панель нужна сразу после установки
  if (location.hash === '#max-archiver') showPanel();

  // небольшой API для отладки и e2e-тестов (живёт только в изолированном мире расширения)
  globalThis.__maxArchiver = {
    showPanel: showPanel,
    runScroll: runScroll,
    runBuild: runBuild,
    exp: state.exp,
    state: state
  };
})();
