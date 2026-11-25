/* MAX Chat Archiver — перехватчик сетевого слоя.
 *
 * Выполняется в контексте страницы (world: MAIN), поэтому видит настоящие
 * fetch / XMLHttpRequest / WebSocket приложения web.max.ru.
 *
 * Задача: скопировать все ответы API (и текстовые кадры WebSocket), чтобы
 * content-скрипт мог собрать из них сообщения. Данные не изменяются.
 * Дополнительно умеет скачать файл по запросу content-скрипта — из контекста
 * страницы, где действуют куки и CORS-правила самого сайта.
 */
(function () {
  'use strict';

  var TAG = 'max-archiver-hook';
  if (window.__maxArchiverHookInstalled) return;
  window.__maxArchiverHookInstalled = true;

  var MAX_BODY = 8 * 1024 * 1024;          // максимум на один ответ
  var SKIP_RE = /\.(js|mjs|css|png|jpe?g|gif|webp|svg|woff2?|ttf|otf|ico|map|mp4|webm|mp3|ogg)(\?|#|$)/i;

  function looksJson(text) {
    var head = text.slice(0, 400).replace(/^\uFEFF/, '').trim();
    if (!head) return false;
    if (head[0] === '{' || head[0] === '[') return true;
    return /^\)\]\}'/.test(head); // XSSI-префикс
  }

  function emit(kind, url, body) {
    if (typeof body !== 'string' || body.length < 2 || body.length > MAX_BODY) return;
    if (!looksJson(body)) return;
    try {
      window.postMessage({ source: TAG, kind: kind, url: String(url || ''), body: body, ts: Date.now() }, '*');
    } catch (e) { /* страница могла закрыться */ }
  }

  /* ---------------- fetch ---------------- */
  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var promise = nativeFetch.apply(this, arguments);
      try {
        var url = '';
        if (typeof input === 'string') url = input;
        else if (input && typeof input === 'object' && input.url) url = input.url;
        if (url && !SKIP_RE.test(url)) {
          promise.then(function (res) {
            try {
              var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
              var jsonish = /json|text\/plain|javascript/i.test(ct) || /api|graphql|sync|history|messages|chats/i.test(url);
              if (!jsonish) return;
              var clone = res.clone();
              clone.text().then(function (t) { emit('fetch', url, t); }).catch(function () {});
            } catch (e) { /* opaque response */ }
          }).catch(function () {});
        }
      } catch (e) { /* не мешаем странице */ }
      return promise;
    };
  }

  /* ---------------- XMLHttpRequest ---------------- */
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var nativeOpen = XHR.prototype.open;
    var nativeSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try { this.__maxArchiverUrl = String(url || ''); } catch (e) {}
      return nativeOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      var self = this;
      try {
        self.addEventListener('load', function () {
          try {
            var url = self.__maxArchiverUrl || '';
            if (!url || SKIP_RE.test(url)) return;
            var rt = self.responseType;
            if (rt === '' || rt === 'text') emit('xhr', url, self.responseText);
            else if (rt === 'json' && self.response) emit('xhr', url, JSON.stringify(self.response));
            else if (rt === 'arraybuffer' && self.response && self.response.byteLength < 4 * 1024 * 1024) {
              try {
                var txt = new TextDecoder('utf-8').decode(self.response);
                if (looksJson(txt)) emit('xhr', url, txt);
              } catch (e) {}
            }
          } catch (e) {}
        });
      } catch (e) {}
      return nativeSend.apply(this, arguments);
    };
  }

  /* ---------------- WebSocket ---------------- */
  var NativeWS = window.WebSocket;
  var wsBinSampled = 0;

  function base64OfBuffer(buf) {
    try {
      var bytes = new Uint8Array(buf);
      var max = Math.min(bytes.length, 200000);
      var bin = '';
      for (var i = 0; i < max; i++) bin += String.fromCharCode(bytes[i]);
      return window.btoa(bin);
    } catch (e) { return ''; }
  }

  function sampleBinaryFrame(url, data) {
    if (wsBinSampled >= 25) return;
    try {
      if (data instanceof ArrayBuffer) {
        wsBinSampled++;
        window.postMessage({ source: TAG, kind: 'wsbin', url: String(url || ''), body: base64OfBuffer(data), ts: Date.now() }, '*');
      } else if (window.Blob && data instanceof Blob) {
        wsBinSampled++;
        data.arrayBuffer().then(function (buf) {
          var b64 = base64OfBuffer(buf);
          if (b64) window.postMessage({ source: TAG, kind: 'wsbin', url: String(url || ''), body: b64, ts: Date.now() }, '*');
        }).catch(function () {});
      }
    } catch (e) {}
  }

  if (typeof NativeWS === 'function') {
    var WrappedWS = function (url, protocols) {
      var ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      try {
        ws.addEventListener('message', function (ev) {
          if (typeof ev.data === 'string') {
            if (ev.data.length < MAX_BODY && looksJson(ev.data)) emit('ws', String(url || ''), ev.data);
          } else {
            sampleBinaryFrame(url, ev.data);
          }
        });
      } catch (e) {}
      return ws;
    };
    WrappedWS.prototype = NativeWS.prototype;
    WrappedWS.CONNECTING = 0;
    WrappedWS.OPEN = 1;
    WrappedWS.CLOSING = 2;
    WrappedWS.CLOSED = 3;
    try { window.WebSocket = WrappedWS; } catch (e) {}
  }

  /* ---------------- загрузка файла по просьбе расширения ---------------- */
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.source !== 'max-archiver-content' || d.type !== 'fetch-file' || d.id == null) return;
    if (ev.source !== window) return;

    var done = false;
    function reply(payload) {
      if (done) return;
      done = true;
      payload.source = 'max-archiver-content-fetch';
      payload.id = d.id;
      try {
        window.postMessage(payload, '*', payload.buffer ? [payload.buffer] : []);
      } catch (e) {
        try { window.postMessage({ source: payload.source, id: payload.id, ok: false, error: 'postMessage failed' }, '*'); } catch (e2) {}
      }
    }

    try {
      fetch(d.url, { credentials: 'include', cache: 'force-cache' })
        .then(function (res) {
          if (!res.ok) { reply({ ok: false, status: res.status }); return null; }
          return res.arrayBuffer();
        })
        .then(function (buf) {
          if (!buf) return;
          if (buf.byteLength > 512 * 1024 * 1024) { reply({ ok: false, error: 'too large' }); return; }
          reply({ ok: true, buffer: buf });
        })
        .catch(function (err) { reply({ ok: false, error: String(err && err.message || err) }); });
    } catch (e) {
      reply({ ok: false, error: String(e && e.message || e) });
    }
  }, false);
})();
