/* MAX Chat Archiver — общие утилиты: ZIP (метод STORE), форматирование, рендер HTML-архива.
 * Используется и в расширении (content-скрипт), и в Node-тестах.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__maxArchiverCommon = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var encoder = new TextEncoder();

  /* ===================== CRC32 ===================== */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosTime(d) {
    var time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
    var date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time: time, date: date };
  }

  /* ===================== ZIP =====================
   * entries: [{ name: 'files/x.jpg', data: Uint8Array, date?: Date }]
   * Возвращает Blob application/zip. Метод STORE — без сжатия:
   * для фото/видео это ничего не теряет, а HTML обычно и так небольшой.
   */
  /* В Firefox объекты, созданные в content-скрипте через TextEncoder/Response,
   * могут принадлежать «миру» страницы, и instanceof Uint8Array не срабатывает.
   * Поэтому приводим байты к своему типу, а не проверяем instanceof. */
  function asBytes(data, name) {
    if (data instanceof Uint8Array) return data;
    if (data && typeof data === 'object' && typeof data.byteLength === 'number' && typeof data.length === 'number') {
      try { return new Uint8Array(data); } catch (e) { /* ниже выбросим понятную ошибку */ }
    }
    throw new TypeError('entry data must be Uint8Array: ' + name);
  }

  function makeZip(entries) {
    var parts = [];
    var central = [];
    var offset = 0;
    var now = dosTime(new Date());

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var data = asBytes(e.data, e.name);
      if (data.length > 0xFFFFFFFF) throw new RangeError('file too large for zip: ' + e.name);

      var nameBytes = encoder.encode(e.name);
      var dt = e.date ? dosTime(e.date) : now;
      var crc = crc32(data);

      var lf = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(lf.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);        // version needed
      lv.setUint16(6, 0x0800, true);    // flags: UTF-8
      lv.setUint16(8, 0, true);         // method: store
      lv.setUint16(10, dt.time, true);
      lv.setUint16(12, dt.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      lf.set(nameBytes, 30);

      parts.push(lf, data);
      central.push({ nameBytes: nameBytes, crc: crc, size: data.length, offset: offset, dt: dt });
      offset += lf.length + data.length;
    }

    var cdStart = offset;
    for (var j = 0; j < central.length; j++) {
      var c = central[j];
      var cd = new Uint8Array(46 + c.nameBytes.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);        // version made by
      cv.setUint16(6, 20, true);        // version needed
      cv.setUint16(8, 0x0800, true);    // flags
      cv.setUint16(10, 0, true);        // method
      cv.setUint16(12, c.dt.time, true);
      cv.setUint16(14, c.dt.date, true);
      cv.setUint32(16, c.crc, true);
      cv.setUint32(20, c.size, true);
      cv.setUint32(24, c.size, true);
      cv.setUint16(28, c.nameBytes.length, true);
      cv.setUint16(30, 0, true);        // extra
      cv.setUint16(32, 0, true);        // comment
      cv.setUint16(34, 0, true);        // disk
      cv.setUint16(36, 0, true);        // internal attrs
      cv.setUint32(38, 0, true);        // external attrs
      cv.setUint32(42, c.offset, true);
      cd.set(c.nameBytes, 46);
      parts.push(cd);
      offset += cd.length;
    }

    var cdSize = offset - cdStart;
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    ev.setUint16(20, 0, true);
    parts.push(eocd);

    return new Blob(parts, { type: 'application/zip' });
  }

  /* ===================== форматирование ===================== */
  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtTime(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtDate(ms) {
    var d = new Date(ms);
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
  }

  function fmtDateTime(ms) {
    return fmtDate(ms) + ' ' + fmtTime(ms);
  }

  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fmtDay(ms) {
    var d = new Date(ms);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' КБ';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' МБ';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' ГБ';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var URL_RE = /(https?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?])/g;

  function linkify(text) {
    var out = '';
    var last = 0;
    var m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) {
      out += esc(text.slice(last, m.index));
      out += '<a href="' + esc(m[1]) + '" target="_blank" rel="noopener noreferrer">' + esc(m[1]) + '</a>';
      last = m.index + m[1].length;
    }
    out += esc(text.slice(last));
    return out;
  }

  function renderText(text) {
    if (!text) return '';
    return linkify(text).replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
  }

  function plural(n, one, few, many) {
    var abs = Math.abs(n) % 100;
    var last = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (last === 1) return one;
    if (last >= 2 && last <= 4) return few;
    return many;
  }

  function initials(name) {
    var s = String(name || '?').trim();
    if (!s) return '?';
    var parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  function colorFor(name) {
    var h = 0;
    var s = String(name || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return 'hsl(' + h + ',42%,46%)';
  }

  /* ===================== рендер архива ===================== */
  var STYLE = [
    ':root{--bg:#eef0f4;--panel:#fff;--text:#101828;--muted:#667085;--line:#e4e7ec;--me:#e3edff;--other:#fff;--accent:#2f6fed;--warn:#fff6e6;--warnline:#f0c36d;--badge:#fff1f0;--badgetext:#b42318;}',
    '@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--panel:#161a20;--text:#e7e9ee;--muted:#98a2b3;--line:#272d36;--me:#1c2b47;--other:#1a2029;--accent:#7ba1ff;--warn:#2b2313;--warnline:#7a5f22;--badge:#3a1d1a;--badgetext:#ff9c92;}}',
    '*{box-sizing:border-box}',
    'html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}',
    '.wrap{max-width:1000px;margin:0 auto;padding:0 16px 60px}',
    'header.top{position:sticky;top:0;z-index:20;background:var(--panel);border-bottom:1px solid var(--line);padding:14px 16px 10px}',
    'header.top .inner{max-width:1000px;margin:0 auto}',
    'h1{font-size:19px;margin:0 0 4px;font-weight:650;word-break:break-word}',
    '.meta{color:var(--muted);font-size:13px}',
    '.meta b{color:var(--text);font-weight:600}',
    '.tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}',
    'input[type=search],select{font:inherit;font-size:13.5px;padding:7px 10px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--text);min-width:0}',
    'input[type=search]{flex:1 1 240px}',
    'select{flex:0 1 auto;max-width:240px}',
    '.cnt{font-size:12.5px;color:var(--muted);margin-left:auto;white-space:nowrap}',
    '.cb{display:inline-flex;align-items:center;gap:6px;font-size:13.5px;color:var(--muted);user-select:none}',
    '.warn{margin:12px 0 0;padding:10px 12px;border:1px solid var(--warnline);background:var(--warn);border-radius:10px;font-size:13.5px}',
    '.warn ul{margin:6px 0 0;padding-left:18px}',
    'main{padding-top:14px}',
    '.day{display:flex;align-items:center;gap:10px;margin:18px 0 10px;color:var(--muted);font-size:12.5px}',
    '.day:before,.day:after{content:"";height:1px;background:var(--line);flex:1}',
    '.day span{padding:3px 10px;border:1px solid var(--line);border-radius:99px;background:var(--panel);white-space:nowrap}',
    '.msg{display:flex;gap:10px;padding:3px 0;align-items:flex-start}',
    '.msg.me{flex-direction:row-reverse}',
    '.ava{width:34px;height:34px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:12.5px;font-weight:650;color:#fff;letter-spacing:.02em}',
    '.body{max-width:min(760px,84%);min-width:0;display:flex;flex-direction:column;align-items:flex-start}',
    '.msg.me .body{align-items:flex-end}',
    '.head{display:flex;gap:8px;align-items:baseline;margin:0 2px 3px;flex-wrap:wrap}',
    '.name{font-weight:650;font-size:13.5px}',
    '.time{font-size:12px;color:var(--muted)}',
    '.edited{font-size:11.5px;color:var(--muted);font-style:italic}',
    '.fwd{font-size:12.5px;color:var(--muted);margin:0 2px 3px}',
    '.bubble{background:var(--other);border:1px solid var(--line);border-radius:14px;padding:9px 12px;display:block;max-width:100%;overflow-wrap:anywhere;word-break:break-word;box-shadow:0 1px 1px rgba(16,24,40,.03)}',
    '.msg.me .bubble{background:var(--me);border-color:transparent}',
    '.bubble p{margin:0}',
    '.bubble a{color:var(--accent)}',
    '.bubble em.sys{color:var(--muted);font-style:normal;font-size:13.5px}',
    '.atts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:flex-start;max-width:100%}',
    '.atts:first-child{margin-top:0}',
    '.att-img{display:block;line-height:0;border-radius:10px;overflow:hidden;border:1px solid var(--line);max-width:min(320px,100%);text-decoration:none;color:var(--muted)}',
    '.att-img img{display:block;max-width:min(320px,100%);max-height:360px;height:auto;object-fit:contain}',
    '.att-img.broken{display:inline-flex;align-items:center;gap:8px;padding:10px 12px;line-height:1.4;font-size:13.5px;border-style:dashed;min-height:0}',
    '.att-img.broken:before{content:"🖼";font-size:16px;line-height:1}',
    '.att-sticker img{width:120px;height:auto}',
    'video{display:block;flex:none;max-width:min(420px,100%);max-height:360px;border-radius:10px;background:#000}',
    'audio{display:block;flex:none;width:320px;max-width:100%}',
    '.att-file{display:inline-flex;align-items:center;gap:9px;padding:8px 11px;border:1px solid var(--line);border-radius:10px;text-decoration:none;color:inherit;background:var(--panel);max-width:100%}',
    '.att-file:hover{border-color:var(--accent)}',
    '.ficon{flex:none;width:34px;height:34px;border-radius:8px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;color:var(--muted);text-transform:uppercase}',
    '.fname{font-size:13.5px;word-break:break-all}',
    '.fsize{font-size:12px;color:var(--muted)}',
    '.badge{display:inline-block;font-size:11px;color:var(--badgetext);background:var(--badge);border-radius:99px;padding:1px 7px;margin-left:6px;vertical-align:middle}',
    '.att-missing{font-size:12.5px;color:var(--muted);border:1px dashed var(--line);border-radius:10px;padding:8px 10px}',
    '.reacts{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}',
    '.react{font-size:12px;background:var(--panel);border:1px solid var(--line);border-radius:99px;padding:1px 7px;color:var(--muted)}',
    'footer{margin-top:26px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}',
    '.empty{padding:40px;text-align:center;color:var(--muted)}',
    '@media print{header.top{position:static}.tools{display:none}.msg{page-break-inside:avoid}body{background:#fff}}',
    '@media (max-width:640px){.body{max-width:100%}.wrap{padding:0 10px 40px}}'
  ].join('\n');

  var FILTER_JS = [
    '(function(){',
    'var q=document.getElementById("q"),sel=document.getElementById("who"),cb=document.getElementById("onlyfiles"),cnt=document.getElementById("cnt");',
    'var msgs=[].slice.call(document.querySelectorAll(".msg"));',
    'var total=msgs.length;',
    'function apply(){var needle=(q.value||"").trim().toLowerCase();var who=sel.value;var onlyF=cb.checked;var shown=0;',
    'for(var i=0;i<msgs.length;i++){var el=msgs[i];var ok=true;',
    'if(needle&&el.textContent.toLowerCase().indexOf(needle)<0)ok=false;',
    'if(ok&&who&&el.getAttribute("data-author")!==who)ok=false;',
    'if(ok&&onlyF&&el.getAttribute("data-files")==="0")ok=false;',
    'el.style.display=ok?"":"none";if(ok)shown++;}',
    'cnt.textContent=shown===total?(total+" "+pl(total,"сообщение","сообщения","сообщений")):(shown+" из "+total);',
    'function pl(n,a,b,c){var m=Math.abs(n)%100,l=m%10;if(m>10&&m<20)return c;if(l===1)return a;if(l>=2&&l<=4)return b;return c}',
    'var days=document.querySelectorAll(".day");for(var d=0;d<days.length;d++){var n=days[d].nextElementSibling,any=false;while(n&&!n.classList.contains("day")){if(n.classList.contains("msg")&&n.style.display!=="none"){any=true;break}n=n.nextElementSibling}days[d].style.display=any?"":"none"}}',
    'q.addEventListener("input",apply);sel.addEventListener("change",apply);cb.addEventListener("change",apply);apply();',
    'function fixImg(img){var a=img.parentNode;if(a&&a.classList){a.classList.add("broken");if(!a.getAttribute("data-shown")){a.setAttribute("data-shown","1");a.appendChild(document.createTextNode(a.getAttribute("data-name")||"изображение"))}img.remove()}}',
    'var imgs=document.querySelectorAll(".att-img img");for(var ii=0;ii<imgs.length;ii++){(function(im){if(im.complete&&im.naturalWidth===0){fixImg(im);return}im.addEventListener("error",function(){fixImg(im)})})(imgs[ii])}',
    '})();'
  ].join('');

  function renderAttachment(att, ctx) {
    var m = (ctx.media && ctx.media(att)) || {};
    var href = m.href || att.url || '';
    var kind = att.kind || 'file';
    var name = att.name || '';
    var size = fmtBytes(att.size);
    var downloaded = m.downloaded !== false && !!href;
    var badge = (href && m.downloaded === false) ? '<span class="badge">файл не в архиве</span>' : '';
    var linkAttrs = ' target="_blank" rel="noopener noreferrer"';

    if (kind === 'image' || kind === 'sticker') {
      if (!href) return '<div class="att-missing">изображение недоступно</div>';
      var cls = kind === 'sticker' ? 'att-sticker' : 'att-img';
      return '<a class="' + cls + '" data-name="' + esc(name || 'изображение') + '" href="' + esc(href) + '"' + linkAttrs + '><img loading="lazy" src="' + esc(href) + '" alt="' + esc(name || 'изображение') + '"></a>';
    }
    if (kind === 'video') {
      if (!href) return '<div class="att-missing">видео недоступно</div>';
      return '<video controls preload="metadata" src="' + esc(href) + '"></video>' + (downloaded ? '' : '<div class="att-missing">файл не включён в архив: <a href="' + esc(href) + '"' + linkAttrs + '>открыть ссылку</a></div>');
    }
    if (kind === 'audio') {
      if (!href) return '<div class="att-missing">аудио недоступно</div>';
      return '<audio controls preload="none" src="' + esc(href) + '"></audio>' + (downloaded ? '' : '<div class="att-missing">файл не включён в архив: <a href="' + esc(href) + '"' + linkAttrs + '>открыть ссылку</a></div>');
    }
    if (kind === 'location') {
      var coords = att.lat != null && att.lon != null ? (att.lat + ', ' + att.lon) : '';
      return '<div class="att-missing">Геопозиция ' + esc(coords) + (href ? ' · <a href="' + esc(href) + '"' + linkAttrs + '>на карте</a>' : '') + '</div>';
    }
    if (kind === 'contact') {
      return '<div class="att-missing">Контакт: ' + esc(att.name || '') + (att.phone ? ' · ' + esc(att.phone) : '') + '</div>';
    }
    if (kind === 'link') {
      if (!href) return '';
      return '<a class="att-file" href="' + esc(href) + '"' + linkAttrs + '><span class="ficon">URL</span><span><span class="fname">' + esc(name || href) + '</span>' + (att.text ? '<br><span class="fsize">' + esc(String(att.text).slice(0, 200)) + '</span>' : '') + '</span></a>';
    }
    // обычный файл
    var ext = '';
    var nm = name || href || '';
    var mm = /\.([a-z0-9]{1,5})(?:$|\?)/i.exec(nm);
    if (mm) ext = mm[1].toLowerCase();
    if (!href) return '<div class="att-missing">Файл «' + esc(name || 'без имени') + '»: в архиве только название — скачайте его в MAX.</div>';
    return '<a class="att-file" href="' + esc(href) + '"' + linkAttrs + '><span class="ficon">' + esc(ext || 'FILE') + '</span><span><span class="fname">' + esc(name || href) + '</span>' + (size ? ' <span class="fsize">' + esc(size) + '</span>' : '') + badge + '</span></a>';
  }

  function renderArchive(o) {
    var messages = (o.messages || []).slice().sort(function (a, b) { return a.timeMs - b.timeMs; });
    var chat = o.chat || {};
    var stats = o.stats || {};
    var title = chat.title || o.fallbackTitle || 'Переписка MAX';
    var selfId = o.selfId || null;
    var ctx = { media: o.media || function () { return null; } };

    var authors = {};
    for (var i = 0; i < messages.length; i++) {
      var a = messages[i].author || 'Без имени';
      authors[a] = (authors[a] || 0) + 1;
    }
    var authorList = Object.keys(authors).sort(function (x, y) { return authors[y] - authors[x]; });

    var out = [];
    out.push('<!DOCTYPE html>');
    out.push('<html lang="ru"><head>');
    out.push('<meta charset="utf-8">');
    out.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
    out.push('<title>' + esc(title) + ' — архив переписки</title>');
    out.push('<style>' + STYLE + '</style>');
    out.push('</head><body>');
    out.push('<header class="top"><div class="inner">');
    out.push('<h1>' + esc(title) + '</h1>');
    var metaBits = [];
    metaBits.push('<b>' + messages.length + '</b> ' + plural(messages.length, 'сообщение', 'сообщения', 'сообщений'));
    if (stats.participants) metaBits.push('<b>' + stats.participants + '</b> ' + plural(stats.participants, 'участник', 'участника', 'участников'));
    if (messages.length) metaBits.push(fmtDate(messages[0].timeMs) + ' — ' + fmtDate(messages[messages.length - 1].timeMs));
    if (stats.filesIncluded) metaBits.push('<b>' + stats.filesIncluded + '</b> ' + plural(stats.filesIncluded, 'файл', 'файла', 'файлов') + ' в архиве');
    if (stats.filesSkipped) metaBits.push(stats.filesSkipped + ' ' + plural(stats.filesSkipped, 'файл', 'файла', 'файлов') + ' только ссылками');
    metaBits.push('архив создан ' + fmtDateTime(o.createdAt || Date.now()));
    out.push('<div class="meta">' + metaBits.join(' · ') + '</div>');

    out.push('<div class="tools">');
    out.push('<input type="search" id="q" placeholder="Поиск по переписке…" autocomplete="off">');
    out.push('<select id="who"><option value="">Все авторы</option>');
    for (var k = 0; k < authorList.length; k++) {
      out.push('<option value="' + esc(authorList[k]) + '">' + esc(authorList[k]) + ' (' + authors[authorList[k]] + ')</option>');
    }
    out.push('</select>');
    out.push('<label class="cb"><input type="checkbox" id="onlyfiles"> только с файлами</label>');
    out.push('<span class="cnt" id="cnt">' + messages.length + ' ' + plural(messages.length, 'сообщение', 'сообщения', 'сообщений') + '</span>');
    out.push('</div>');

    if (o.warnings && o.warnings.length) {
      out.push('<div class="warn"><b>Обратите внимание</b><ul>');
      for (var w = 0; w < o.warnings.length; w++) out.push('<li>' + esc(o.warnings[w]) + '</li>');
      out.push('</ul></div>');
    }
    out.push('</div></header>');

    out.push('<div class="wrap"><main id="chat">');
    if (!messages.length) {
      out.push('<div class="empty">Сообщения не найдены.</div>');
    }

    var lastDay = null;
    for (var j = 0; j < messages.length; j++) {
      var m = messages[j];
      var dk = dayKey(m.timeMs);
      if (dk !== lastDay) {
        out.push('<div class="day"><span>' + esc(fmtDay(m.timeMs)) + '</span></div>');
        lastDay = dk;
      }
      var isMe = selfId && m.senderId && String(m.senderId) === String(selfId);
      var atts = m.attachments || [];
      var hasFiles = atts.length ? '1' : '0';
      out.push('<div class="msg' + (isMe ? ' me' : '') + '" data-author="' + esc(m.author || 'Без имени') + '" data-files="' + hasFiles + '" data-id="' + esc(m.id || '') + '">');
      out.push('<div class="ava" style="background:' + colorFor(m.author) + '">' + esc(initials(m.author)) + '</div>');
      out.push('<div class="body">');
      out.push('<div class="head"><span class="name">' + esc(m.author || 'Без имени') + '</span><span class="time">' + esc(fmtTime(m.timeMs)) + '</span>');
      if (m.edited) out.push('<span class="edited">изменено</span>');
      out.push('</div>');
      if (m.forwardFrom) out.push('<div class="fwd">Переслано от ' + esc(m.forwardFrom) + '</div>');
      if (m.replyText) out.push('<div class="fwd">В ответ на: «' + esc(String(m.replyText).slice(0, 160)) + '»</div>');
      out.push('<div class="bubble">');
      if (m.text) out.push('<p>' + renderText(m.text) + '</p>');
      if (atts.length) {
        out.push('<div class="atts">');
        for (var q = 0; q < atts.length; q++) out.push(renderAttachment(atts[q], ctx));
        out.push('</div>');
      }
      if (!m.text && !atts.length) out.push('<p><em class="sys">сообщение без текста</em></p>');
      out.push('</div>');
      if (m.reactions && m.reactions.length) {
        out.push('<div class="reacts">');
        for (var r = 0; r < m.reactions.length; r++) out.push('<span class="react">' + esc(m.reactions[r]) + '</span>');
        out.push('</div>');
      }
      out.push('</div></div>');
    }

    out.push('</main>');
    out.push('<footer>Локальный архив переписки MAX. Сделан расширением MAX Chat Archiver ' + esc(o.version || '') + '. Файлы сохранены в папке <code>files/</code>.');
    if (o.pageUrl) out.push(' Источник: ' + esc(o.pageUrl) + '.');
    out.push('</footer></div>');
    out.push('<script>' + FILTER_JS + '</script>');
    out.push('</body></html>');
    return out.join('\n');
  }

  return {
    crc32: crc32,
    makeZip: makeZip,
    esc: esc,
    linkify: linkify,
    renderText: renderText,
    fmtBytes: fmtBytes,
    fmtTime: fmtTime,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    fmtDay: fmtDay,
    dayKey: dayKey,
    plural: plural,
    initials: initials,
    renderArchive: renderArchive
  };
});
