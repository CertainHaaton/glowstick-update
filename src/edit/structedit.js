// 網頁編輯器的「結構」操作：插入／刪除／移動／複製貼上 段落、圖片影片、項目、分類。
// 這是本機版 site/structedit.py 的 JavaScript 版本，規則要一模一樣（測試：node src/edit/test_structedit.js）。
// 操作對象是記憶體裡的一期：st = { template: 字串, i18n: {langs, t}, media: {名稱: {ext, ...}} }
// 這支只改 st，不碰 GitHub；復原（每步快照）由 backend.js 負責。
//
// 區塊四種（右鍵點到的物件會對應到其中一種）：
//   para 段落（項目裡或開頭 <div class="lead"> 的 <p data-i18n>）、media 圖片影片（<figure>{{media:名稱|說明}}</figure>）
//   item 項目（<div class="item">）、section 分類（<section>）；其他（大標題、頁首頁尾、附註）是固定物件，只能改字。
(function (root) {
  'use strict';
  var LEVEL_NAME = { para: '段落', media: '圖片／影片', item: '項目', section: '分類' };

  function StructError(msg) { this.message = msg; this.name = 'StructError'; }
  StructError.prototype = Object.create(Error.prototype);

  // ---------- 文字位置工具 ----------
  function nlOf(s) { return s.indexOf('\r\n') >= 0 ? '\r\n' : '\n'; }
  function lineStart(s, i) { return s.lastIndexOf('\n', i - 1) + 1; }
  function lineEnd(s, i) { var j = s.indexOf('\n', i); return j < 0 ? s.length : j + 1; }
  function indentAt(s, i) { return /^[ \t]*/.exec(s.slice(lineStart(s, i)))[0]; }
  function tidy(s) { var nl = nlOf(s); return s.replace(/(?:[ \t]*\r?\n){3,}/g, nl + nl); }
  function escRe(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function matchClose(s, start, tag) {
    var re = new RegExp('<' + tag + '\\b|</' + tag + '>', 'g'), depth = 0, m;
    re.lastIndex = start;
    while ((m = re.exec(s))) {
      depth += m[0][1] !== '/' ? 1 : -1;
      if (depth === 0) return m.index + m[0].length;
    }
    throw new StructError('版型的 <' + tag + '> 沒有對應的結尾');
  }
  // 包住 pos 的最近一個 <tag class="cls">，回傳 [開始, 結束] 或 null
  function enclosing(s, pos, tag, cls) {
    var pat = cls == null ? new RegExp('<' + tag + '\\b[^>]*>', 'g') : new RegExp('<' + tag + '\\b[^>]*class="' + cls + '"[^>]*>', 'g');
    var head = s.slice(0, pos + 1), starts = [], m;
    while ((m = pat.exec(head))) starts.push(m.index);
    for (var i = starts.length - 1; i >= 0; i--) {
      var b = matchClose(s, starts[i], tag);
      if (b > pos) return [starts[i], b];
    }
    return null;
  }
  function linesOf(s, a, b) { return [lineStart(s, a), lineEnd(s, b - 1)]; }

  // ---------- 區塊辨識 ----------
  function refPos(s, ref) {
    var i;
    if (ref.indexOf('media:') === 0) i = s.indexOf('{{media:' + ref.slice(6) + '|');
    else {
      var m = new RegExp('data-i18n="' + escRe(ref) + '"').exec(s);
      i = m ? s.lastIndexOf('<', m.index) : -1;
    }
    if (i < 0) throw new StructError('版型裡找不到這個物件（' + ref + '），可能已經被刪掉了，請重新整理');
    return i;
  }
  function blockOf(s, ref) {
    var pos = refPos(s, ref), f;
    if (ref.indexOf('media:') === 0) { f = enclosing(s, pos, 'figure'); return f ? ['media', f[0], f[1]] : ['fixed', pos, pos]; }
    var tag = /<(\w+)/.exec(s.slice(pos))[1].toLowerCase();
    if (tag === 'p' && (enclosing(s, pos, 'div', 'item') || enclosing(s, pos, 'div', 'lead'))) return ['para', pos, s.indexOf('</p>', pos) + 4];
    if (tag === 'h3' && enclosing(s, pos, 'div', 'item')) { f = enclosing(s, pos, 'div', 'item'); return ['item', f[0], f[1]]; }
    if (tag === 'h2' && enclosing(s, pos, 'section')) { f = enclosing(s, pos, 'section'); return ['section', f[0], f[1]]; }
    return ['fixed', pos, pos];
  }
  function parentOf(s, level, a) {
    if (level === 'para') return enclosing(s, a, 'div', 'item') || enclosing(s, a, 'div', 'lead');
    if (level === 'media') return enclosing(s, a, 'div', 'pair') || enclosing(s, a, 'div', 'item');
    if (level === 'item') return enclosing(s, a, 'section');
    return enclosing(s, a, 'main');
  }
  var BLOCK_RE = { para: '<p\\b[^>]*data-i18n=', media: '<figure\\b', item: '<div\\b[^>]*class="item"', section: '<section\\b' };
  var BLOCK_TAG = { para: 'p', media: 'figure', item: 'div', section: 'section' };
  function sameRange(x, y) { return x && y && x[0] === y[0] && x[1] === y[1]; }
  function siblings(s, level, a) {
    var par = parentOf(s, level, a), out = [], re = new RegExp(BLOCK_RE[level], 'g'), seg = s.slice(par[0], par[1]), m;
    while ((m = re.exec(seg))) {
      var x = par[0] + m.index;
      if (sameRange(parentOf(s, level, x), par)) out.push([x, matchClose(s, x, BLOCK_TAG[level])]);
    }
    return out;
  }

  function insertPoint(s, level, ref) {
    var bo = blockOf(s, ref), tl = bo[0], a = bo[1], b = bo[2], pos = refPos(s, ref);
    var item = enclosing(s, pos, 'div', 'item'), sec = enclosing(s, pos, 'section'), m;
    if (level === 'para') {
      if (tl === 'para') return [lineEnd(s, b - 1), indentAt(s, a)];
      if (item) {  // 點到項目標題或圖片：加在項目最後一段文字後面（沒有段落就接在標題後）
        var seg = s.slice(item[0], item[1]), re = /<p\b[\s\S]*?<\/p>/g, last = null;
        while ((m = re.exec(seg))) last = m;
        var end = item[0] + (last ? last.index + last[0].length : seg.indexOf('</h3>') + 5);
        return [lineEnd(s, end - 1), indentAt(s, item[0]) + '  '];
      }
      throw new StructError('段落要加在項目或開頭段落裡：請在項目上按右鍵');
    }
    if (level === 'media') {
      if (tl === 'media') return [lineEnd(s, b - 1), indentAt(s, a)];
      if (item) { var close = s.lastIndexOf('</div>', item[1]); while (close >= item[1]) close = s.lastIndexOf('</div>', close - 1); return [lineStart(s, close), indentAt(s, item[0]) + '  ']; }
      throw new StructError('圖片影片要放在項目裡：請在項目上按右鍵');
    }
    if (level === 'item') {
      if (item) return [lineEnd(s, item[1] - 1), indentAt(s, item[0])];
      if (sec) { var h2 = s.indexOf('</h2>', sec[0]) + 5; return [lineEnd(s, h2 - 1), indentAt(s, sec[0]) + '  ']; }
      throw new StructError('項目要放在分類裡：請在分類標題或項目上按右鍵');
    }
    if (level === 'section') {
      if (sec) return [lineEnd(s, sec[1] - 1), indentAt(s, sec[0])];
      var first = /<section\b/.exec(s);
      if (first) return [lineStart(s, first.index), indentAt(s, first.index)];
      var note = s.indexOf('<div class="note"');
      return [lineStart(s, note), indentAt(s, note)];
    }
    throw new StructError('不認得的種類');
  }
  function reindent(text, oldInd, newInd) {
    return text.split(/(?<=\n)/).map(function (ln) { return ln.indexOf(oldInd) === 0 ? newInd + ln.slice(oldInd.length) : ln; }).join('');
  }
  function put(s, at, text) {
    var nl = nlOf(s);
    if (/^\s*<(div class="item"|section)/.test(text)) text = nl + text + nl;  // 項目／分類前後空一行
    return tidy(s.slice(0, at) + text + s.slice(at));
  }

  // ---------- 文字鍵 ----------
  var lastId = 0;
  function newId(prefix) {  // 跟 Python 版同格式：前綴＋毫秒（16 進位 8 碼內），同一毫秒內自動往後加
    var t = Date.now() % Math.pow(16, 8);
    if (t <= lastId) t = lastId + 1;
    lastId = t;
    return prefix + t.toString(16);
  }
  function addText(d, key, tw) { var e = {}; d.langs.forEach(function (L) { e[L.code] = L.code === 'tw' ? tw : ''; }); d.t[key] = e; }
  function mediaIn(text) { var out = [], re = /\{\{media:(\w+)\|/g, m; while ((m = re.exec(text))) out.push(m[1]); return out; }
  function keysIn(text) {
    var out = [], re = /data-i18n(?:-alt|-aria)?="(\w+)"/g, m;
    while ((m = re.exec(text))) out.push(m[1]);
    return out.concat(mediaIn(text).map(function (n) { return 'cap_' + n; }));
  }
  function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function newBlock(level, ind, nl, d) {
    var i2 = ind + '  ', k;
    if (level === 'para') { k = newId('p'); addText(d, k, '新段落'); return [ind + '<p data-i18n="' + k + '">新段落</p>' + nl, k]; }
    if (level === 'media') { k = newId('m'); addText(d, 'cap_' + k, '圖說'); return [ind + '<figure>{{media:' + k + '|圖說}}</figure>' + nl, 'media:' + k]; }
    if (level === 'item') {
      k = newId('i'); addText(d, k + '_h', '新項目標題'); addText(d, k + '_p', '新項目內文');
      return [ind + '<div class="item">' + nl + i2 + '<h3 data-i18n="' + k + '_h">新項目標題</h3>' + nl +
        i2 + '<p data-i18n="' + k + '_p">新項目內文</p>' + nl + ind + '</div>' + nl, k + '_h'];
    }
    if (level === 'section') {
      k = newId('s'); addText(d, 'sec_' + k, '新分類'); addText(d, k + 'i_h', '新項目標題'); addText(d, k + 'i_p', '新項目內文');
      var i3 = i2 + '  ';
      return [ind + '<section id="' + k + '">' + nl + i2 + '<h2 data-i18n="sec_' + k + '">新分類</h2>' + nl + nl +
        i2 + '<div class="item">' + nl + i3 + '<h3 data-i18n="' + k + 'i_h">新項目標題</h3>' + nl +
        i3 + '<p data-i18n="' + k + 'i_p">新項目內文</p>' + nl + i2 + '</div>' + nl + ind + '</section>' + nl, 'sec_' + k];
    }
    throw new StructError('不認得的種類');
  }
  // 複製區塊：所有文字鍵、媒體名、分類 id 換新（媒體直接共用同一個檔案內容，發布時不用重傳）
  function cloneBlock(text, st) {
    var d = st.i18n, first = null, re = /data-i18n(?:-alt|-aria)?="(\w+)"/g, m, keys = [];
    while ((m = re.exec(text))) keys.push(m[1]);
    uniq(keys).forEach(function (k) {
      var nk = newId('c') + '_' + k.slice(-12);
      d.t[nk] = clone(d.t[k] || {});
      text = text.split('"' + k + '"').join('"' + nk + '"');
      first = first || nk;
    });
    uniq(mediaIn(text)).forEach(function (n) {
      var nn = newId('m');
      d.t['cap_' + nn] = clone(d.t['cap_' + n] || {});
      if (st.media[n]) st.media[nn] = Object.assign({}, st.media[n]);
      text = text.split('{{media:' + n + '|').join('{{media:' + nn + '|');
      first = first || 'media:' + nn;
    });
    text = text.replace(/<section id="\w+"/g, function () { return '<section id="' + newId('s') + '"'; });
    return [text, first];
  }

  // ---------- 對外 ----------
  function describe(st, ref) {
    var s = st.template, bo = blockOf(s, ref), level = bo[0], a = bo[1];
    if (level === 'fixed') return { level: 'fixed' };
    var sib = siblings(s, level, a).map(function (x) { return x[0]; }), i = sib.indexOf(a);
    return { level: level, name: LEVEL_NAME[level], up: i > 0, down: i >= 0 && i < sib.length - 1 };
  }

  // op：insert（kind＝para/media/item/section）、delete、up、down、paste（src、kind＝copy/cut）、dup
  function apply(st, op, ref, kind, src) {
    var s = st.template, d = st.i18n, nl = nlOf(s), r, ip, text, label;
    if (op === 'insert') {
      if (!LEVEL_NAME[kind]) throw new StructError('不認得的種類');
      ip = insertPoint(s, kind, ref);
      r = newBlock(kind, ip[1], nl, d);
      st.template = put(s, ip[0], r[0]);
      return { label: '插入' + LEVEL_NAME[kind], focus: r[1] };
    }
    var bo = blockOf(s, ref), level = bo[0], a = bo[1], b = bo[2];
    if (level === 'fixed') throw new StructError('這是固定物件（大標題、頁首頁尾、附註等），只能改字');

    if (op === 'delete') {
      var block = s.slice(a, b);
      keysIn(block).forEach(function (k) { delete d.t[k]; });
      mediaIn(block).forEach(function (n) { delete st.media[n]; });
      var ln = linesOf(s, a, b);
      st.template = tidy(s.slice(0, ln[0]) + s.slice(ln[1]));
      return { label: '刪除' + LEVEL_NAME[level], focus: null };
    }
    if (op === 'up' || op === 'down') {
      var sib = siblings(s, level, a), i = sib.map(function (x) { return x[0]; }).indexOf(a), j = op === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= sib.length) throw new StructError('已經是' + (op === 'up' ? '第' : '最後') + '一個了');
      var pr = [sib[i], sib[j]].sort(function (x, y) { return x[0] - y[0]; });
      var A = linesOf(s, pr[0][0], pr[0][1]), B = linesOf(s, pr[1][0], pr[1][1]);
      st.template = s.slice(0, A[0]) + s.slice(B[0], B[1]) + s.slice(A[1], B[0]) + s.slice(A[0], A[1]) + s.slice(B[1]);
      return { label: (op === 'up' ? '上移' : '下移') + LEVEL_NAME[level], focus: ref };
    }
    if (op === 'paste' || op === 'dup') {
      if (op === 'dup') { src = ref; kind = 'copy'; }
      var sb = blockOf(s, src);
      if (sb[0] === 'fixed') throw new StructError('剪貼簿裡的東西已經找不到了');
      if (kind === 'cut' && sb[1] <= refPos(s, ref) && refPos(s, ref) < sb[2]) throw new StructError('不能貼到自己裡面');
      insertPoint(s, sb[0], ref);  // 先驗證目的地放得下
      var L = linesOf(s, sb[1], sb[2]), focus;
      text = s.slice(L[0], L[1]);
      label = (kind === 'cut' ? '移動' : '貼上') + LEVEL_NAME[sb[0]];
      if (kind === 'cut') { s = tidy(s.slice(0, L[0]) + s.slice(L[1])); focus = src; }
      else { r = cloneBlock(text, st); text = r[0]; focus = r[1]; }
      ip = insertPoint(s, sb[0], ref);
      text = reindent(text, indentAt(text, 0), ip[1]);
      st.template = put(s, ip[0], text);
      return { label: label, focus: focus };
    }
    throw new StructError('不認得的操作：' + op);
  }

  // 開新的一期：以 st（某一期）的版型當底，拿掉所有分類、開頭只留第一段，換成一個空的新分類（同 editions.py 的 new）
  function newEdition(st, date) {
    var s = st.template, d = st.i18n, nl = nlOf(s), m;
    while ((m = /<section\b/.exec(s))) {
      var b = matchClose(s, m.index, 'section');
      keysIn(s.slice(m.index, b)).forEach(function (k) { delete d.t[k]; });
      mediaIn(s.slice(m.index, b)).forEach(function (n) { delete st.media[n]; });
      var L = linesOf(s, m.index, b);
      s = s.slice(0, L[0]) + s.slice(L[1]);
    }
    var lp = s.indexOf('<div class="lead"'), lead = lp >= 0 ? enclosing(s, s.indexOf('>', lp), 'div', 'lead') : null, firstLead = null;
    if (lead) {
      var seg = s.slice(lead[0], lead[1]), re = /<p\b[^>]*data-i18n="(\w+)"[^>]*>[\s\S]*?<\/p>/g, ps = [];
      while ((m = re.exec(seg))) ps.push({ k: m[1], a: m.index, b: m.index + m[0].length });
      if (ps.length) firstLead = ps[0].k;
      for (var i = ps.length - 1; i >= 1; i--) {
        delete d.t[ps[i].k];
        var L2 = linesOf(s, lead[0] + ps[i].a, lead[0] + ps[i].b);
        s = s.slice(0, L2[0]) + s.slice(L2[1]);
      }
    }
    var ip = insertPoint(s, 'section', firstLead || 'h1'), r = newBlock('section', ip[1], nl, d);
    s = put(s, ip[0], r[0]);
    var langs = d.langs.map(function (L) { return L.code; });
    if (d.t.h1) { d.t.h1 = {}; langs.forEach(function (c) { d.t.h1[c] = c === 'tw' ? '開發週報<i>・</i>' + date.replace(/-/g, '.') : ''; }); }
    if (firstLead) { d.t[firstLead] = {}; langs.forEach(function (c) { d.t[firstLead][c] = c === 'tw' ? '以下整理本週的主要更新內容。' : ''; }); }
    st.template = tidy(s);
    // 媒體：只留版型還用得到的（主視覺、網站圖示等）
    var used = {}, re2 = /\{\{img:(\w+)\}\}/g;
    while ((m = re2.exec(st.template))) used[m[1]] = 1;
    mediaIn(st.template).forEach(function (n) { used[n] = 1; });
    Object.keys(st.media).forEach(function (n) { if (!used[n]) delete st.media[n]; });
    if (st.i18nSrc) { delete st.i18nSrc.h1; if (firstLead) delete st.i18nSrc[firstLead]; Object.keys(st.i18nSrc).forEach(function (k) { if (!d.t[k]) delete st.i18nSrc[k]; }); }
    return st;
  }

  var api = { apply: apply, describe: describe, newEdition: newEdition, keysIn: keysIn, mediaIn: mediaIn, StructError: StructError, LEVEL_NAME: LEVEL_NAME,
    _setIdGen: function (fn) { newId = fn; } };  // 測試用：換成固定的編號，跟 Python 版逐字比對
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.StructEdit = api;
})(this);
