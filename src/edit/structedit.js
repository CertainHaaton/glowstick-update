// 網頁編輯器的「結構」操作：插入／刪除／移動／複製貼上 分類標題、小標題、段落、圖片影片。
// 測試：node src/tools/test_structedit.js src/editions/<日期>
// 操作對象是記憶體裡的一期：st = { template: 字串, i18n: {langs, t}, media: {名稱: {ext, ...}} }
// 這支只改 st，不碰 GitHub；復原（每步快照）由 backend.js 負責。
//
// 內容區 <div class="flow"> 裡每個物件都是獨立的一行（照演出編輯器：一行一個指令，互不綁定）：
//   section 分類標題 <h2>、item 小標題 <h3>、para 段落 <p data-i18n>、media 圖片影片 <figure>{{media:名稱|說明}}</figure>
//   （圖片可以兩張一組放在 <div class="pair"> 並排，裡面的圖片一樣各自獨立）
//   刪掉小標題只刪標題那一行，底下的段落和圖片不受影響。
//   內容區以外（大標題、頁首頁尾、附註）是固定物件，只能改字。
// 舊版型（<div class="lead">＋<section>＋<div class="item"> 一層包一層）讀進來時由 flatten() 自動攤平。
(function (root) {
  'use strict';
  var LEVEL_NAME = { para: '段落', media: '圖片／影片', item: '小標題', section: '分類標題' };
  var TAG_LEVEL = { p: 'para', h3: 'item', h2: 'section', figure: 'media' };

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
  function linesOf(s, a, b) { return [lineStart(s, a), lineEnd(s, b - 1)]; }
  function reindent(text, oldInd, newInd) {
    return text.split(/(?<=\n)/).map(function (ln) { return ln.indexOf(oldInd) === 0 ? newInd + ln.slice(oldInd.length) : ln; }).join('');
  }

  // ---------- 內容區與直接子元素 ----------
  function flowRange(s) { var i = s.indexOf('<div class="flow"'); return i < 0 ? null : [i, matchClose(s, i, 'div')]; }
  // par＝[開始, 結束] 的直接子元素：[[開始, 結束, 標籤, 開頭標籤], …]
  function children(s, par) {
    var out = [], end = s.lastIndexOf('</', par[1] - 1), re = /<!--[\s\S]*?-->|<(\w+)\b[^>]*>/g, m;
    re.lastIndex = s.indexOf('>', par[0]) + 1;
    while ((m = re.exec(s)) && m.index < end) {
      if (!m[1]) continue;
      var tag = m[1].toLowerCase(), b = matchClose(s, m.index, tag);
      out.push([m.index, b, tag, m[0]]);
      re.lastIndex = b;
    }
    return out;
  }
  function isPair(c) { return c[2] === 'div' && /class="pair"/.test(c[3]); }
  function inside(c, pos) { return c[0] <= pos && pos < c[1]; }
  // pos 所在的區塊：{level, a, b, par（所在容器）, pair（在並排裡才有）}；不在內容區＝null
  function locate(s, pos) {
    var fl = flowRange(s); if (!fl || pos < fl[0] || pos >= fl[1]) return null;
    var k = children(s, fl).filter(function (c) { return inside(c, pos); })[0];
    if (!k) return null;
    if (isPair(k)) {
      var pr = [k[0], k[1]], f = children(s, pr).filter(function (c) { return inside(c, pos); })[0];
      return f && f[2] === 'figure' ? { level: 'media', a: f[0], b: f[1], par: pr, pair: pr } : null;
    }
    return TAG_LEVEL[k[2]] ? { level: TAG_LEVEL[k[2]], a: k[0], b: k[1], par: fl, pair: null } : null;
  }
  function siblings(s, B) {
    return children(s, B.par).filter(function (c) { return B.pair ? c[2] === 'figure' : TAG_LEVEL[c[2]] || isPair(c); });
  }

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
  function blockOf(s, ref) { var pos = refPos(s, ref); return locate(s, pos) || { level: 'fixed', a: pos, b: pos }; }

  // 新東西放哪：點到內容區的物件＝放在它下一行；圖片放在並排裡的圖片後面，其他種類放在整組並排後面；
  // 點到內容區前面的固定物件（大標題等）＝放在內容區最前面
  function insertPoint(s, level, ref) {
    var fl = flowRange(s); if (!fl) throw new StructError('版型裡沒有內容區（<div class="flow">）');
    var pos = refPos(s, ref), B = locate(s, pos);
    if (!B) {
      if (pos > fl[0]) throw new StructError('這裡是頁尾的固定物件，請在內容上按右鍵');
      var kids = children(s, fl);
      if (kids.length) return [lineStart(s, kids[0][0]), indentAt(s, kids[0][0])];
      return [lineStart(s, fl[1] - 6), indentAt(s, fl[0]) + '  '];
    }
    if (B.pair && level !== 'media') return [lineEnd(s, B.pair[1] - 1), indentAt(s, B.pair[0])];
    return [lineEnd(s, B.b - 1), indentAt(s, B.a)];
  }
  function put(s, at, text) {
    var nl = nlOf(s);
    if (/^\s*<h2\b/.test(text)) text = nl + text;  // 分類標題前空一行（只是原始檔好讀，不影響畫面）
    return tidy(s.slice(0, at) + text + s.slice(at));
  }
  // 拿掉一個區塊；並排裡最後一張圖被拿掉時，空的並排外框也一起拿掉
  function removeBlock(s, B) {
    var a = B.a, b = B.b;
    if (B.pair && children(s, B.pair).filter(function (c) { return c[2] === 'figure'; }).length <= 1) { a = B.pair[0]; b = B.pair[1]; }
    var L = linesOf(s, a, b);
    return { s: tidy(s.slice(0, L[0]) + s.slice(L[1])), text: s.slice(a, b) };
  }

  // ---------- 文字鍵 ----------
  var lastId = 0;
  function newId(prefix) {  // 前綴＋毫秒（16 進位 8 碼內），同一毫秒內自動往後加
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

  function newBlock(level, ind, nl, d, tw) {
    var k;
    if (level === 'para') { k = newId('p'); addText(d, k, tw || '新段落'); return [ind + '<p data-i18n="' + k + '">' + (tw || '新段落') + '</p>' + nl, k]; }
    if (level === 'media') { k = newId('m'); addText(d, 'cap_' + k, '圖說'); return [ind + '<figure>{{media:' + k + '|圖說}}</figure>' + nl, 'media:' + k]; }
    if (level === 'item') { k = newId('h'); addText(d, k, tw || '新小標題'); return [ind + '<h3 data-i18n="' + k + '">' + (tw || '新小標題') + '</h3>' + nl, k]; }
    if (level === 'section') { k = 'sec_' + newId('s'); addText(d, k, tw || '新分類'); return [ind + '<h2 data-i18n="' + k + '">' + (tw || '新分類') + '</h2>' + nl, k]; }
    throw new StructError('不認得的種類');
  }
  // 複製區塊：所有文字鍵、媒體名換新（媒體直接共用同一個檔案內容，發布時不用重傳）
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
    return [text, first];
  }

  // ---------- 舊版型攤平 ----------
  var FLOW_CSS = [
    '/* 內容區：每個物件獨立一行（分類標題／小標題／段落／圖片），間距用前後關係決定（上下邊距會重疊取大的那個） */',
    '.flow>p{margin:0 0 14px}',
    '.flow>h2{margin:96px 0 26px}',
    '.flow>h3{margin:46px 0 6px}',
    '.flow>h2+h3,.flow>h3:first-child{margin-top:0}',
    '.flow>figure,.flow>.pair{margin:0 0 14px}'
  ];
  // 舊版型（lead／section／item 一層包一層）→ 一個 <div class="flow"> 裡面平鋪；已經是新版型就只補樣式。回傳 st
  function flatten(st) {
    var s = st.template, nl = nlOf(s);
    if (s.indexOf('<div class="flow"') < 0) {
      var re = /<div class="lead"[^>]*>|<section\b[^>]*>/g, m, boxes = [];
      while ((m = re.exec(s))) { var e = matchClose(s, m.index, m[0].indexOf('<section') === 0 ? 'section' : 'div'); boxes.push([m.index, e]); re.lastIndex = e; }
      if (boxes.length) {
        var ind = indentAt(s, boxes[0][0]), ci = ind + '  ', blocks = [];
        var take = function (c) {
          var L = linesOf(s, c[0], c[1]);
          blocks.push(reindent(s.slice(L[0], L[1]), indentAt(s, c[0]), ci));
        };
        boxes.forEach(function (bx, bi) {
          if (bi > 0) {  // 兩個容器中間如果夾了別的東西，原樣保留
            var gap = s.slice(boxes[bi - 1][1], bx[0]).trim();
            if (gap) blocks.push(ci + gap + nl);
          }
          children(s, bx).forEach(function (c) {
            if (c[2] === 'div' && /class="item"/.test(c[3])) children(s, [c[0], c[1]]).forEach(take);
            else take(c);
          });
        });
        var out = ind + '<div class="flow">' + nl;
        blocks.forEach(function (b, i) { if (i && /^\s*<h[23]\b/.test(b)) out += nl; out += b; });
        out += ind + '</div>' + nl;
        var A = lineStart(s, boxes[0][0]), Z = lineEnd(s, boxes[boxes.length - 1][1] - 1);
        s = s.slice(0, A) + out + s.slice(Z);
      }
    }
    if (s.indexOf('.flow>h2') < 0) {
      var at = s.indexOf('{{ui_css}}'); if (at < 0) at = s.indexOf('</style>');
      if (at >= 0) s = s.slice(0, at) + FLOW_CSS.join(nl) + nl + s.slice(at);
    }
    st.template = tidy(s);
    return st;
  }

  // ---------- 對外 ----------
  function describe(st, ref) {
    flatten(st);
    var s = st.template, B = blockOf(s, ref);
    if (B.level === 'fixed') return { level: 'fixed' };
    var sib = siblings(s, B).map(function (x) { return x[0]; }), i = sib.indexOf(B.a);
    return { level: B.level, name: LEVEL_NAME[B.level], up: i > 0, down: i >= 0 && i < sib.length - 1 };
  }

  // op：insert（kind＝para/media/item/section）、delete、up、down、paste（src、kind＝copy/cut）、dup
  function apply(st, op, ref, kind, src) {
    flatten(st);
    var s = st.template, d = st.i18n, nl = nlOf(s), r, ip, text, label;
    if (op === 'insert') {
      if (!LEVEL_NAME[kind]) throw new StructError('不認得的種類');
      ip = insertPoint(s, kind, ref);
      r = newBlock(kind, ip[1], nl, d);
      st.template = put(s, ip[0], r[0]);
      return { label: '插入' + LEVEL_NAME[kind], focus: r[1] };
    }
    var B = blockOf(s, ref);
    if (B.level === 'fixed') throw new StructError('這是固定物件（大標題、頁首頁尾、附註等），只能改字');

    if (op === 'delete') {
      var rm = removeBlock(s, B);
      keysIn(rm.text).forEach(function (k) { delete d.t[k]; });
      mediaIn(rm.text).forEach(function (n) { delete st.media[n]; });
      st.template = rm.s;
      return { label: '刪除' + LEVEL_NAME[B.level], focus: null };
    }
    if (op === 'up' || op === 'down') {
      var sib = siblings(s, B), i = sib.map(function (x) { return x[0]; }).indexOf(B.a), j = op === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= sib.length) throw new StructError('已經是' + (op === 'up' ? '第' : '最後') + '一個了');
      var pr = [sib[i], sib[j]].sort(function (x, y) { return x[0] - y[0]; });
      var A = linesOf(s, pr[0][0], pr[0][1]), Bl = linesOf(s, pr[1][0], pr[1][1]);
      st.template = tidy(s.slice(0, A[0]) + s.slice(Bl[0], Bl[1]) + s.slice(A[1], Bl[0]) + s.slice(A[0], A[1]) + s.slice(Bl[1]));
      return { label: (op === 'up' ? '上移' : '下移') + LEVEL_NAME[B.level], focus: ref };
    }
    if (op === 'paste' || op === 'dup') {
      if (op === 'dup') { src = ref; kind = 'copy'; }
      var sb = blockOf(s, src);
      if (sb.level === 'fixed') throw new StructError('剪貼簿裡的東西已經找不到了');
      if (kind === 'cut' && src === ref) throw new StructError('不能貼到自己後面：請在別的位置按右鍵貼上');
      insertPoint(s, sb.level, ref);  // 先驗證目的地放得下
      var L = linesOf(s, sb.a, sb.b), focus;
      text = s.slice(L[0], L[1]);
      label = (kind === 'cut' ? '移動' : '貼上') + LEVEL_NAME[sb.level];
      if (kind === 'cut') { s = removeBlock(s, sb).s; focus = src; }
      else { r = cloneBlock(text, st); text = r[0]; focus = r[1]; }
      ip = insertPoint(s, sb.level, ref);
      text = reindent(text, indentAt(text, 0), ip[1]);
      st.template = put(s, ip[0], text);
      return { label: label, focus: focus };
    }
    throw new StructError('不認得的操作：' + op);
  }

  // 開新的一期：以 st（某一期）的版型當底，內容區只留第一段開頭文字，接一組空的「分類標題＋小標題＋段落」
  function newEdition(st, date) {
    flatten(st);
    var s = st.template, d = st.i18n, nl = nlOf(s), fl = flowRange(s), m;
    if (!fl) throw new StructError('版型裡沒有內容區（<div class="flow">）');
    var kids = children(s, fl), firstLead = null;
    if (kids.length && kids[0][2] === 'p') { m = /data-i18n="(\w+)"/.exec(kids[0][3]); if (m) { firstLead = m[1]; kids = kids.slice(1); } }
    for (var i = kids.length - 1; i >= 0; i--) {
      var blk = s.slice(kids[i][0], kids[i][1]);
      keysIn(blk).forEach(function (k) { delete d.t[k]; });
      mediaIn(blk).forEach(function (n) { delete st.media[n]; });
      var L = linesOf(s, kids[i][0], kids[i][1]);
      s = s.slice(0, L[0]) + s.slice(L[1]);
    }
    var ip = insertPoint(s, 'section', firstLead || 'h1');
    var add = newBlock('section', ip[1], nl, d)[0] + newBlock('item', ip[1], nl, d)[0] + newBlock('para', ip[1], nl, d, '新內文')[0];
    s = put(s, ip[0], add);
    var langs = d.langs.map(function (L) { return L.code; });
    if (d.t.h1) { d.t.h1 = {}; langs.forEach(function (c) { d.t.h1[c] = c === 'tw' ? '開發週報<i>・</i>' + date.slice(0, 10).replace(/-/g, '.') + (date.length > 10 ? ' #' + date.slice(11) : '') : ''; }); }
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

  var api = { apply: apply, describe: describe, newEdition: newEdition, flatten: flatten, keysIn: keysIn, mediaIn: mediaIn,
    StructError: StructError, LEVEL_NAME: LEVEL_NAME,
    _setIdGen: function (fn) { newId = fn; } };  // 測試用：換成固定的編號
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.StructEdit = api;
})(this);
