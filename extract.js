/* MAX Chat Archiver — извлечение сообщений из перехваченных ответов API.
 *
 * Задача: не зависеть от точной схемы API web.max.ru. Мы не знаем, какой
 * формат у MAX сегодня (REST/GraphQL/WebSocket) и каким он будет завтра,
 * поэтому разбираем JSON эвристически:
 *   - ищем объекты, похожие на пользователей (id + имя)  -> справочник авторов;
 *   - ищем объекты, похожие на чат (id + название + участники) -> заголовок;
 *   - ищем объекты, похожие на сообщение (id + время + текст/вложения).
 * Дубликаты (REST + WebSocket, повторная загрузка страницы) склеиваются по id.
 *
 * Модуль чистый (без DOM), поэтому его можно гонять в Node-тестах.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__maxArchiverExtract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TIME_KEYS = ['time', 'timestamp', 'createdAt', 'created', 'createdTime', 'creationTime', 'sentAt', 'sendTime',
    'date', 'updatedAt', 'updateTime', 'timeMs', 'ts', 'ctime', 'when'];
  var TEXT_KEYS = ['text', 'body', 'content', 'caption', 'plainText', 'message', 'msg'];
  var ID_KEYS = ['id', 'messageId', 'msgId', 'mid', '_id', 'seq', 'key'];
  var SENDER_ID_KEYS = ['senderId', 'userId', 'fromId', 'authorId', 'uid', 'sender_id'];
  var SENDER_OBJ_KEYS = ['sender', 'from', 'author', 'user', 'senderUser'];

  var ATT_ARRAY_KEYS = ['attachments', 'attach', 'attaches', 'files', 'media', 'attachmentsList'];
  var ATT_SINGLE_KEYS = ['photo', 'image', 'video', 'audio', 'voice', 'file', 'document', 'sticker',
    'location', 'contact', 'poll', 'link', 'linkPreview', 'preview'];

  var KIND_MAP = {
    PHOTO: 'image', IMAGE: 'image', PICTURE: 'image', GIF: 'image', ANIMATION: 'image',
    STICKER: 'sticker', STICKERS: 'sticker',
    VIDEO: 'video', ROUND_VIDEO: 'video', VIDEO_MESSAGE: 'video',
    AUDIO: 'audio', VOICE: 'audio', VOICE_MESSAGE: 'audio', AUDIO_MESSAGE: 'audio',
    FILE: 'file', DOCUMENT: 'file', DOC: 'file', ARCHIVE: 'file',
    LOCATION: 'location', CONTACT: 'contact', POLL: 'poll',
    LINK: 'link', SHARE: 'link', LINK_PREVIEW: 'link', PREVIEW: 'link'
  };

  var EXT_KIND = [
    [/\.(jpe?g|png|webp|gif|bmp|heic|avif)(\?|#|$)/i, 'image'],
    [/\.(mp4|mov|webm|mkv|avi|m4v)(\?|#|$)/i, 'video'],
    [/\.(mp3|ogg|oga|m4a|aac|wav|opus|flac)(\?|#|$)/i, 'audio']
  ];

  /* ===================== утилиты ===================== */

  function firstString() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }

  function validMs(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return null;
    if (ms < Date.UTC(2000, 0, 1)) return null;
    if (ms > Date.now() + 366 * 24 * 3600 * 1000) return null;
    return Math.round(ms);
  }

  function toMs(v) {
    if (v == null) return null;
    if (typeof v === 'number') {
      if (!isFinite(v) || v <= 0) return null;
      return validMs(v > 1e11 ? v : v * 1000);
    }
    if (typeof v === 'string') {
      var s = v.trim();
      if (!s) return null;
      if (/^\d{10,}$/.test(s)) return toMs(Number(s));
      var ru = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
      if (ru) {
        var dt = new Date(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1]),
          Number(ru[4] || 0), Number(ru[5] || 0), Number(ru[6] || 0));
        return validMs(dt.getTime());
      }
      var parsed = Date.parse(s);
      if (!isNaN(parsed)) return validMs(parsed);
      return null;
    }
    if (typeof v === 'object') {
      if (v.millis != null) return toMs(v.millis);
      if (v.seconds != null) return toMs(v.seconds);
      if (v.value != null) return toMs(v.value);
    }
    return null;
  }

  function hash32(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  function normText(t) {
    return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  function elText(el) {
    if (el == null) return '';
    if (typeof el === 'string') return el;
    if (typeof el === 'number') return String(el);
    if (typeof el === 'object') {
      if (typeof el.text === 'string') return el.text;
      if (typeof el.value === 'string') return el.value;
      if (typeof el.emoji === 'string') return el.emoji;
      if (typeof el.name === 'string') return el.name;
    }
    return '';
  }

  function richText(els) {
    if (!Array.isArray(els)) return null;
    var out = '';
    for (var i = 0; i < els.length; i++) out += elText(els[i]);
    return out.trim() ? out : null;
  }

  /* ===================== распознавание полей ===================== */

  function pickId(o) {
    for (var i = 0; i < ID_KEYS.length; i++) {
      var v = o[ID_KEYS[i]];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && isFinite(v)) return String(v);
      if (v && typeof v === 'object') {
        var inner = v.id != null ? v.id : (v.mid != null ? v.mid : v.seq);
        if (typeof inner === 'string' || typeof inner === 'number') return String(inner);
      }
    }
    var body = o.body;
    if (body && typeof body === 'object') {
      if (body.mid != null) return String(body.mid);
      if (body.id != null) return String(body.id);
      if (body.seq != null) return String(body.seq);
    }
    return null;
  }

  function pickTime(o) {
    for (var i = 0; i < TIME_KEYS.length; i++) {
      var t = toMs(o[TIME_KEYS[i]]);
      if (t) return t;
    }
    var nestedKeys = ['body', 'payload', 'content'];
    for (var j = 0; j < nestedKeys.length; j++) {
      var n = o[nestedKeys[j]];
      if (n && typeof n === 'object') {
        for (var k = 0; k < TIME_KEYS.length; k++) {
          var t2 = toMs(n[TIME_KEYS[k]]);
          if (t2) return t2;
        }
      }
    }
    return null;
  }

  function pickText(o) {
    for (var i = 0; i < TEXT_KEYS.length; i++) {
      var v = o[TEXT_KEYS[i]];
      if (typeof v === 'string' && v.trim()) return v;
    }
    var rich = o.elements || (o.content && o.content.elements) || (o.body && o.body.elements);
    var fromRich = richText(rich);
    if (fromRich) return fromRich;

    var nestedKeys = ['payload', 'content', 'body', 'message'];
    for (var j = 0; j < nestedKeys.length; j++) {
      var n = o[nestedKeys[j]];
      if (!n || typeof n !== 'object' || Array.isArray(n)) continue;
      for (var k = 0; k < TEXT_KEYS.length; k++) {
        var v2 = n[TEXT_KEYS[k]];
        if (typeof v2 === 'string' && v2.trim()) return v2;
      }
      var fromRich2 = richText(n.elements);
      if (fromRich2) return fromRich2;
    }
    return null;
  }

  function pickSenderId(o) {
    for (var i = 0; i < SENDER_ID_KEYS.length; i++) {
      var v = o[SENDER_ID_KEYS[i]];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && isFinite(v)) return String(v);
    }
    for (var j = 0; j < SENDER_OBJ_KEYS.length; j++) {
      var so = o[SENDER_OBJ_KEYS[j]];
      if (so && typeof so === 'object' && so.id != null) return String(so.id);
    }
    return null;
  }

  function pickSenderName(o) {
    for (var j = 0; j < SENDER_OBJ_KEYS.length; j++) {
      var so = o[SENDER_OBJ_KEYS[j]];
      if (so && typeof so === 'object') {
        var n = firstString(so.name, so.displayName, so.fullName, so.title, so.firstName);
        if (n) return n;
      }
    }
    return null;
  }

  function namesFirst(names) {
    if (!Array.isArray(names)) return null;
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (typeof n === 'string' && n.trim()) return n.trim();
      if (n && typeof n === 'object') {
        var v = firstString(n.name, n.value);
        if (v) return v;
      }
    }
    return null;
  }

  function joinFirstLast(o) {
    var a = firstString(o.firstName, o.first_name);
    var b = firstString(o.lastName, o.last_name);
    if (a && b) return a + ' ' + b;
    return a || b || null;
  }

  /* ===================== вложения ===================== */

  function deepUrls(obj, depth, keyPath, out) {
    if (!obj || typeof obj !== 'object' || depth > 6) return out;
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (typeof v === 'string') {
        if (v.length > 7 && !/\s/.test(v) && /^(https?:\/\/|blob:|\/|data:)/i.test(v)) {
          out.push({ key: k, path: keyPath + '.' + k, url: v, depth: depth });
        }
      } else if (v && typeof v === 'object') {
        deepUrls(v, depth + 1, keyPath + '.' + k, out);
      }
    }
    return out;
  }

  function urlScore(c) {
    var k = String(c.key || '').toLowerCase();
    var s = 0;
    if (k.indexOf('download') >= 0) s += 120;
    if (k.indexOf('original') >= 0) s += 90;
    if (k === 'url' || k === 'link' || k === 'href' || k === 'src') s += 70;
    else if (k.indexOf('url') >= 0) s += 60;
    else if (k.indexOf('link') >= 0) s += 40;
    if (k.indexOf('file') >= 0) s += 55;
    if (k.indexOf('photo') >= 0 || k.indexOf('video') >= 0 || k.indexOf('audio') >= 0 || k.indexOf('image') >= 0) s += 30;
    if (k.indexOf('thumb') >= 0 || k.indexOf('preview') >= 0 || k.indexOf('poster') >= 0 || k.indexOf('small') >= 0) s -= 70;
    if (k.indexOf('avatar') >= 0 || k.indexOf('icon') >= 0) s -= 90;
    if (/\.(jpe?g|png|webp|gif|mp4|mov|webm|mp3|ogg|m4a|opus|pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv|svg)(\?|#|$)/i.test(c.url)) s += 25;
    s -= c.depth * 4;
    return s;
  }

  function pickUrl(obj) {
    var cands = deepUrls(obj, 0, '', []);
    if (!cands.length) return null;
    var best = null;
    var bestScore = -1e9;
    for (var i = 0; i < cands.length; i++) {
      if (/^data:/i.test(cands[i].url)) continue;
      var sc = urlScore(cands[i]);
      if (sc > bestScore) { bestScore = sc; best = cands[i]; }
    }
    return best ? best.url : null;
  }

  function pickDataUri(obj) {
    var cands = deepUrls(obj, 0, '', []);
    for (var i = 0; i < cands.length; i++) {
      if (/^data:image\//i.test(cands[i].url) && cands[i].url.length < 2 * 1024 * 1024) return cands[i].url;
    }
    return null;
  }

  function detectKind(a, hint) {
    var rawType = a.type != null ? a.type : (a.attachmentType != null ? a.attachmentType : a.kind);
    if (typeof rawType === 'string') {
      var up = rawType.toUpperCase();
      if (KIND_MAP[up]) return KIND_MAP[up];
      var low = rawType.toLowerCase();
      if (/photo|image|picture|gif|sticker/.test(low)) return low.indexOf('sticker') >= 0 ? 'sticker' : 'image';
      if (/video|round/.test(low)) return 'video';
      if (/voice|audio/.test(low)) return 'audio';
      if (/file|doc|archive/.test(low)) return 'file';
      if (/location|geo/.test(low)) return 'location';
      if (/contact/.test(low)) return 'contact';
      if (/poll/.test(low)) return 'poll';
      if (/link|preview|share/.test(low)) return 'link';
    }
    if (hint) {
      var h = String(hint).toLowerCase();
      if (h === 'photo' || h === 'image') return 'image';
      if (h === 'video') return 'video';
      if (h === 'audio' || h === 'voice') return 'audio';
      if (h === 'sticker') return 'sticker';
      if (h === 'location') return 'location';
      if (h === 'contact') return 'contact';
      if (h === 'poll') return 'poll';
      if (h === 'link' || h === 'linkpreview' || h === 'preview') return 'link';
    }
    if (a.photo || a.image || a.thumbnail) return 'image';
    if (a.video) return 'video';
    if (a.audio || a.voice) return 'audio';
    if (a.sticker) return 'sticker';
    if (a.location || (a.lat != null && a.lon != null)) return 'location';
    if (a.phone || a.contact) return 'contact';
    if (a.poll) return 'poll';

    var url = pickUrl(a) || '';
    for (var i = 0; i < EXT_KIND.length; i++) if (EXT_KIND[i][0].test(url)) return EXT_KIND[i][1];
    return 'file';
  }

  function attName(a) {
    var direct = firstString(a.name, a.fileName, a.filename, a.title, a.displayName);
    if (direct) return direct;
    var nested = [a.file, a.document, a.photo, a.video, a.audio, a.voice, a.payload];
    for (var i = 0; i < nested.length; i++) {
      var n = nested[i];
      if (n && typeof n === 'object') {
        var v = firstString(n.name, n.fileName, n.filename, n.title);
        if (v) return v;
      }
    }
    return null;
  }

  function attSize(a) {
    var direct = a.size != null ? a.size : (a.fileSize != null ? a.fileSize : a.bytes);
    if (typeof direct === 'number' && isFinite(direct) && direct >= 0) return direct;
    if (typeof direct === 'string' && /^\d+$/.test(direct)) return Number(direct);
    var nested = [a.file, a.document, a.payload];
    for (var i = 0; i < nested.length; i++) {
      var n = nested[i];
      if (n && typeof n === 'object' && typeof n.size === 'number') return n.size;
    }
    return null;
  }

  function normalizeAttachment(a, hint) {
    if (!a || typeof a !== 'object') return null;
    if (Array.isArray(a)) return null;
    var kind = detectKind(a, hint);
    var url = pickUrl(a) || null;
    var dataUri = pickDataUri(a);
    var name = attName(a);
    var size = attSize(a);
    var mime = firstString(a.mime, a.mimeType, a.contentType, a.file && a.file.mime);
    var duration = typeof a.duration === 'number' ? a.duration : (a.file && a.file.duration) || null;

    if (!url && !dataUri && kind !== 'location' && kind !== 'contact' && kind !== 'poll') {
      // без ссылки вложение бесполезно, но имя оставим — вдруг это описание файла
      if (!name) return null;
    }

    var out = { kind: kind, url: url, name: name, size: size, mime: mime };
    if (dataUri) out.dataUri = dataUri;
    if (duration) out.duration = duration;

    if (kind === 'location') {
      out.lat = a.lat != null ? a.lat : (a.latitude != null ? a.latitude : null);
      out.lon = a.lon != null ? a.lon : (a.longitude != null ? a.longitude : (a.lng != null ? a.lng : null));
      if (out.lat == null) {
        var loc = a.location && typeof a.location === 'object' ? a.location : null;
        if (loc) {
          out.lat = loc.lat != null ? loc.lat : loc.latitude;
          out.lon = loc.lon != null ? loc.lon : loc.longitude;
        }
      }
      if (out.lat != null && out.lon != null && !out.url) {
        out.url = 'https://yandex.ru/maps/?ll=' + encodeURIComponent(out.lon) + ',' + encodeURIComponent(out.lat) + '&pt=' + encodeURIComponent(out.lon) + ',' + encodeURIComponent(out.lat);
      }
    }
    if (kind === 'contact') {
      out.phone = firstString(a.phone, a.phoneNumber, a.tel, a.contact && a.contact.phone);
      out.name = name || firstString(a.contact && a.contact.name, a.displayName);
    }
    if (kind === 'link') {
      out.name = name || firstString(a.title, a.url);
      out.text = firstString(a.description, a.text, a.subtitle);
      if (!out.url) out.url = firstString(a.url, a.link, a.href);
    }
    if (kind === 'sticker' && !out.url && a.sticker && typeof a.sticker === 'object') {
      out.url = pickUrl(a.sticker);
    }
    return out;
  }

  function collectAttachments(o) {
    var list = [];
    var i, j;

    function push(val, hint) {
      if (!val) return;
      if (Array.isArray(val)) { for (var q = 0; q < val.length; q++) push(val[q], hint); return; }
      if (typeof val !== 'object') return;
      var norm = normalizeAttachment(val, hint);
      if (norm) list.push(norm);
    }

    var containers = [o];
    if (o.body && typeof o.body === 'object' && !Array.isArray(o.body)) containers.push(o.body);
    if (o.payload && typeof o.payload === 'object' && !Array.isArray(o.payload)) containers.push(o.payload);

    for (i = 0; i < containers.length; i++) {
      var c = containers[i];
      for (j = 0; j < ATT_ARRAY_KEYS.length; j++) {
        if (Array.isArray(c[ATT_ARRAY_KEYS[j]])) push(c[ATT_ARRAY_KEYS[j]], null);
      }
      for (j = 0; j < ATT_SINGLE_KEYS.length; j++) {
        var v = c[ATT_SINGLE_KEYS[j]];
        if (v && typeof v === 'object') push(v, ATT_SINGLE_KEYS[j]);
      }
    }

    // дедупликация
    var seen = {};
    var out = [];
    for (i = 0; i < list.length; i++) {
      var key = (list[i].url || list[i].dataUri || '') + '|' + (list[i].name || '') + '|' + list[i].kind;
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(list[i]);
    }
    return out;
  }

  /* ===================== распознавание сущностей ===================== */

  function asUser(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    if (o.participants || o.participantsCount != null || o.membersCount != null) return null;
    if (o.id == null) return null;
    if (typeof o.id !== 'string' && typeof o.id !== 'number') return null;
    var name = firstString(o.name, o.displayName, o.fullName, o.nickname, o.title, namesFirst(o.names)) || joinFirstLast(o);
    if (!name) return null;
    var avatarObj = o.avatar || o.photo || o.avatarUrl || o.avatar_url;
    var avatar = null;
    if (typeof avatarObj === 'string') avatar = avatarObj;
    else if (avatarObj && typeof avatarObj === 'object') avatar = pickUrl(avatarObj);
    if (!avatar) avatar = pickUrl({ a: o.avatarUrl, b: o.avatar_url, c: o.avatar });
    return { id: String(o.id), name: name, avatar: avatar };
  }

  function asChat(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    var title = firstString(o.title, o.name, o.chatTitle);
    if (!title) return null;
    if (o.id == null) return null;
    var looks = Array.isArray(o.participants) ||
      typeof o.participantsCount === 'number' || typeof o.membersCount === 'number' ||
      /chat|dialog|group|channel|конференц/i.test(String(o.type || o.chatType || o.kind || '')) ||
      o.isChannel === true || o.isGroup === true || o.isChat === true;
    if (!looks) return null;
    var count = o.participantsCount || o.membersCount || (Array.isArray(o.participants) ? o.participants.length : 0);
    return { id: String(o.id), title: title, count: count || 0, type: o.type || o.chatType || null };
  }

  function isMessage(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    var id = pickId(o);
    if (!id) return false;
    var t = pickTime(o);
    if (!t) return false;
    var text = pickText(o);
    var atts = collectAttachments(o);
    if (!text && !atts.length) return false;
    return true;
  }

  function reactionsOf(o) {
    var r = o.reactions || o.reaction || o.reactionsCount;
    var out = [];
    if (Array.isArray(r)) {
      for (var i = 0; i < r.length; i++) {
        var it = r[i];
        if (typeof it === 'string') { out.push(it); continue; }
        if (it && typeof it === 'object') {
          var emoji = firstString(it.emoji, it.reaction, it.value, it.code) || '';
          var count = it.count != null ? it.count : (it.total != null ? it.total : '');
          out.push(emoji + (count ? ' ' + count : ''));
        }
      }
    }
    return out;
  }

  function replyTextOf(o) {
    var cands = [o.replyTo, o.reply, o.quote, o.replyMessage];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!c) continue;
      if (typeof c === 'string' && c.trim()) return c;
      if (typeof c === 'object') {
        var t = firstString(c.text, c.body, c.content) || (c.message && (c.message.text || c.message.body));
        if (t) return t;
      }
    }
    return null;
  }

  function forwardOf(o) {
    var cands = [o.forwardedFrom, o.forward, o.forwarded, o.origin];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!c) continue;
      if (typeof c === 'string' && c.trim()) return c;
      if (typeof c === 'object') {
        var n = firstString(c.name, c.title, c.senderName, c.authorName) ||
          (c.sender && firstString(c.sender.name, c.sender.title)) ||
          (c.author && firstString(c.author.name, c.author.title));
        if (n) return n;
      }
    }
    return null;
  }

  /* ===================== ядро ===================== */

  function createExtractor() {
    var messages = new Map();
    var users = new Map();
    var chats = new Map();
    var selfId = null;
    var warnings = [];
    var sources = new Map();
    var responses = 0;

    function setSelf(id) {
      if (id && !selfId) selfId = String(id);
    }

    function mergeUser(u) {
      var prev = users.get(u.id) || {};
      users.set(u.id, {
        id: u.id,
        name: prev.name && prev.name.length > (u.name || '').length ? prev.name : (u.name || prev.name),
        avatar: prev.avatar || u.avatar || null
      });
    }

    function mergeChat(c) {
      var prev = chats.get(c.id) || { id: c.id, title: null, count: 0 };
      chats.set(c.id, {
        id: c.id,
        title: prev.title && prev.title.length >= (c.title || '').length ? prev.title : (c.title || prev.title),
        count: Math.max(prev.count || 0, c.count || 0),
        type: c.type || prev.type || null
      });
    }

    function messageKey(o, id) {
      if (id) return 'id:' + id;
      var t = pickTime(o) || 0;
      var s = pickSenderId(o) || '';
      var txt = normText(pickText(o));
      var att = collectAttachments(o)[0];
      return 'h:' + hash32([t, s, txt, att ? (att.url || att.name) : ''].join('|'));
    }

    function mergeMessage(o) {
      var id = pickId(o);
      var key = messageKey(o, id);
      var m = messages.get(key);
      if (!m) {
        m = { id: id, timeMs: null, senderId: null, author: null, text: null, attachments: [], reactions: [], edited: false, replyText: null, forwardFrom: null };
        messages.set(key, m);
      }
      var t = pickTime(o);
      if (t && !m.timeMs) m.timeMs = t;

      var text = pickText(o);
      if (text && (!m.text || text.length > m.text.length)) m.text = text;

      var sid = pickSenderId(o);
      if (sid) m.senderId = sid;
      var sname = pickSenderName(o);
      if (sname) m.author = sname;

      if (!m.author) {
        var u = sid ? users.get(sid) : null;
        if (u) m.author = u.name;
      }

      var atts = collectAttachments(o);
      for (var i = 0; i < atts.length; i++) {
        var a = atts[i];
        var dup = false;
        for (var j = 0; j < m.attachments.length; j++) {
          var b = m.attachments[j];
          if ((a.url && b.url === a.url) || (a.name && b.name === a.name && a.kind === b.kind)) { dup = true; break; }
        }
        if (!dup) m.attachments.push(a);
      }
      if (o.edited === true || o.isEdited === true || o.timeEdited || o.editTime) m.edited = true;
      var r = reactionsOf(o);
      if (r.length) m.reactions = r;
      var rep = replyTextOf(o);
      if (rep && !m.replyText) m.replyText = rep;
      var fwd = forwardOf(o);
      if (fwd && !m.forwardFrom) m.forwardFrom = fwd;

      if (o.out === true || o.isMine === true || o.isOwn === true || o.me === true) {
        if (sid) setSelf(sid);
      }
      if (o.me === true && o.id != null && !sid) setSelf(o.id);
    }

    function handleObject(o, url) {
      var user = asUser(o);
      if (user) mergeUser(user);
      var chat = asChat(o);
      if (chat) mergeChat(chat);
      if (isMessage(o)) {
        mergeMessage(o);
        sources.set(url || '?', (sources.get(url || '?') || 0) + 1);
      }
      if (o.me === true && o.id != null && (o.name || o.displayName)) setSelf(o.id);
    }

    function walk(node, depth, url, seen) {
      if (!node || typeof node !== 'object' || depth > 16) return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1, url, seen);
        return;
      }
      handleObject(node, url);
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        var v = node[k];
        if (v && typeof v === 'object') walk(v, depth + 1, url, seen);
      }
    }

    function parseBody(body) {
      if (typeof body !== 'string') return body;
      var s = body.replace(/^\uFEFF/, '').replace(/^\)\]\}'[^\n]*\n?/, '').trim();
      if (!s) return null;
      try { return JSON.parse(s); } catch (e) { /* возможно NDJSON */ }
      var lines = s.split('\n');
      var arr = [];
      var ok = false;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        try { arr.push(JSON.parse(line)); ok = true; } catch (e2) { /* пропускаем */ }
      }
      return ok ? arr : null;
    }

    function ingest(url, body) {
      var data;
      try { data = parseBody(body); } catch (e) { return { added: 0, error: String(e && e.message || e) }; }
      if (!data || typeof data !== 'object') return { added: 0 };
      responses++;
      var before = messages.size;
      try {
        walk(data, 0, url, new WeakSet());
      } catch (e) {
        return { added: messages.size - before, error: String(e && e.message || e) };
      }
      return { added: messages.size - before };
    }

    function getModel() {
      var list = [];
      messages.forEach(function (m) { list.push(m); });

      // склейка дублей, пришедших из разных источников с разными id
      list.sort(function (a, b) { return (a.timeMs || 0) - (b.timeMs || 0); });
      var bySig = new Map();
      var merged = [];
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (!m.timeMs) continue;
        var sig = m.timeMs + '|' + (m.senderId || '') + '|' + normText(m.text) + '|' + (m.attachments[0] ? (m.attachments[0].url || m.attachments[0].name || '') : '');
        var twin = bySig.get(sig);
        if (twin) {
          for (var a = 0; a < m.attachments.length; a++) {
            var at = m.attachments[a];
            var dup = false;
            for (var b = 0; b < twin.attachments.length; b++) {
              if ((at.url && twin.attachments[b].url === at.url) || (at.name && twin.attachments[b].name === at.name && at.kind === twin.attachments[b].kind)) { dup = true; break; }
            }
            if (!dup) twin.attachments.push(at);
          }
          if (!twin.reactions.length && m.reactions.length) twin.reactions = m.reactions;
          continue;
        }
        bySig.set(sig, m);
        merged.push(m);
      }

      for (var j = 0; j < merged.length; j++) {
        var msg = merged[j];
        if (!msg.author && msg.senderId) {
          var u = users.get(msg.senderId);
          if (u) msg.author = u.name;
        }
        if (!msg.author && msg.forwardFrom) msg.author = msg.forwardFrom;
        if (!msg.author) msg.author = msg.senderId ? 'Без имени' : 'Система';
        msg.timeMs = msg.timeMs || Date.now();
      }

      var chat = null;
      var best = 0;
      chats.forEach(function (c) {
        var score = (c.count || 0) * 10 + (c.title ? c.title.length : 0);
        if (score >= best) { best = score; chat = c; }
      });

      var withFiles = 0;
      for (var k = 0; k < merged.length; k++) if (merged[k].attachments.length) withFiles++;

      var stats = {
        total: merged.length,
        participants: users.size,
        withFiles: withFiles,
        first: merged.length ? merged[0].timeMs : null,
        last: merged.length ? merged[merged.length - 1].timeMs : null,
        attachments: 0,
        responses: responses
      };
      for (var q = 0; q < merged.length; q++) stats.attachments += merged[q].attachments.length;

      var warn = warnings.slice();
      if (!merged.length) {
        warn.push('В перехваченных ответах не найдено ни одного сообщения. Откройте чат, прокрутите историю и попробуйте снова. Если не помогает — сохраните диагностику и покажите её разработчику.');
      }
      if (!chat) warn.push('Название чата определить не удалось — оно задано вручную.');

      return {
        chat: chat,
        messages: merged,
        stats: stats,
        selfId: selfId,
        warnings: warn,
        users: users
      };
    }

    return {
      ingest: ingest,
      getModel: getModel,
      count: function () { return messages.size; },
      usersCount: function () { return users.size; },
      reset: function () { messages.clear(); users.clear(); chats.clear(); selfId = null; warnings = []; sources.clear(); responses = 0; }
    };
  }

  return {
    createExtractor: createExtractor
  };
});
