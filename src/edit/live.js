// ===== 網站編輯器（所見即所得）：只在 editor_server.py 的編輯頁載入，不會進到發布的網頁 =====
// 頁面本身＝build.py 的 render(live=True)，跟發布版同一份版型與文字；這支只負責「點、右鍵、改」。
//   滑鼠移過：可編輯的物件亮金框＋名稱。左鍵：選取（連結不會跳走）。雙擊：直接在頁面上改目前語言。
//   右鍵：選單，排法照演出編輯器——在下方插入（段落／圖片影片／項目／分類）、編輯、剪下／複製／貼上／複製且貼上／刪除、
//         上移／下移、六種語言、換圖片影片、頁面上看不到的文字。選取後也能直接按快捷鍵（Enter、Del、Ctrl+X/C/V/D、Alt+↑↓、Ctrl+Z）。
//   文字改完先放在「未儲存」，按工具列「儲存」或 Ctrl+S 才寫回 i18n.json；換圖片影片是立刻換檔（舊檔備份到 backups）。
//   結構動作（插入、刪除、移動、貼上）由伺服器的 structedit.py 改 template.html，每步都有備份，Ctrl+Z／「復原」一步步還原；
//   動作前會先自動儲存未存的文字，做完重新整理頁面並捲回剛剛的位置。
(function () {
  'use strict';
  var EDSEL = '[data-i18n],[data-media],[data-i18n-alt]';
  var LANGS = I18N.langs, SAVED = JSON.parse(JSON.stringify(I18N.t)), LABEL = {};
  var hoverEl = null, selEl = null, editing = null, menuTarget = null;
  var HIST = [];  // 文字改動的復原紀錄 {key, prev}；空了再按 Ctrl+Z 就改復原結構動作
  var KIND_NAME = { para: '段落', media: '圖片／影片', item: '項目', section: '分類' };
  var SRC = {}, SRCP = {};  // AI 翻譯：各鍵「上次翻譯時的繁中」（伺服器 i18n_src.json）／這次翻好還沒存的

  // ---------- 小工具 ----------
  function edReloadPage() { if (window.edReload) window.edReload(); else location.reload(); }
  function $(id) { return document.getElementById(id); }
  function h(tag, attrs, html) { var e = document.createElement(tag); for (var k in attrs || {}) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function plain(s) { var d = document.createElement('div'); d.innerHTML = s || ''; return d.textContent.trim(); }
  function lang() { return window.__lang || 'tw'; }
  function langLabel(c) { var m = LANGS.filter(function (x) { return x.code === c; })[0]; return m ? m.label : c; }
  function api(path, body) {
    return fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      .then(function (r) { return r.json(); });
  }
  function toast(msg, err) {
    var t = $('ed-toast'); t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, err ? 5000 : 2400);
  }

  // ---------- 未儲存的改動 ----------
  function dirtyKeys() {
    return Object.keys(I18N.t).filter(function (k) { return JSON.stringify(I18N.t[k]) !== JSON.stringify(SAVED[k]); });
  }
  function refresh() {
    applyLang(lang());  // 頁面自己的套字函式：所有 data-i18n 依目前語言重填
    var d = dirtyKeys(), st = $('ed-st');
    st.textContent = d.length ? d.length + ' 處未儲存' : '已全部儲存';
    st.classList.toggle('dirty', !!d.length);
    $('ed-save').disabled = !d.length;
    [].forEach.call(document.querySelectorAll('.ed-changed'), function (e) { e.classList.remove('ed-changed'); });
    d.forEach(function (k) { [].forEach.call(document.querySelectorAll('[data-i18n="' + k + '"]'), function (e) { e.classList.add('ed-changed'); }); });
    place($('ed-sel'), selEl);
    updateAIBtn();
  }
  function remember(key) { HIST.push({ key: key, prev: JSON.parse(JSON.stringify(I18N.t[key])) }); }
  function setText(key, lg, v) { if (!I18N.t[key]) return; remember(key); I18N.t[key][lg] = v; refresh(); }
  function save() {
    var d = dirtyKeys(), sp = SRCP; if (!d.length && !Object.keys(sp).length) return Promise.resolve(true);
    var t = {}; d.forEach(function (k) { t[k] = I18N.t[k]; });
    return api('/api/save', { t: t, src: sp }).then(function (r) {
      if (!r.ok) throw new Error(r.error || '儲存失敗');
      d.forEach(function (k) { SAVED[k] = JSON.parse(JSON.stringify(I18N.t[k])); });
      for (var k in sp) SRC[k] = sp[k];
      SRCP = {};
      refresh(); if (d.length) toast('已儲存（舊檔備份在 backups 資料夾）'); return true;
    }).catch(function (e) { toast('儲存失敗：' + e.message, true); return false; });
  }

  // ---------- 找出滑鼠底下的物件 ----------
  // 用 elementsFromPoint 往下找：主視覺上面蓋著漸層，直接取 target 只會拿到外框，往下才找得到圖片本身。
  function pick(x, y) {
    var st = document.elementsFromPoint(x, y);
    for (var i = 0; i < st.length; i++) {
      var e = st[i];
      if (e.closest('#ed-ui') || e.closest('.lang')) return null;
      var ed = e.closest(EDSEL); if (ed) return ed;
    }
    return null;
  }
  function describe(el) {
    if (el.hasAttribute('data-media')) {
      var n = el.getAttribute('data-media');
      return { name: el.classList.contains('ph') ? '空的媒體位置' : (el.tagName === 'VIDEO' ? '影片' : '圖片'), key: n };
    }
    var k = el.getAttribute('data-i18n') || el.getAttribute('data-i18n-alt');
    return { name: LABEL[k] || k, key: k };
  }
  function place(box, el) {
    if (!el || !document.body.contains(el)) { box.style.display = 'none'; return; }
    var r = el.getBoundingClientRect(), pad = 3;
    box.style.display = 'block';
    box.style.left = (r.left + scrollX - pad) + 'px'; box.style.top = (r.top + scrollY - pad) + 'px';
    box.style.width = (r.width + pad * 2) + 'px'; box.style.height = (r.height + pad * 2) + 'px';
    if (box.id === 'ed-hover') box.classList.toggle('below', r.top < 100);
  }
  function showHover(el) {
    hoverEl = el; var box = $('ed-hover');
    if (!el || editing) { box.style.display = 'none'; return; }
    var d = describe(el);
    box.querySelector('.tag').innerHTML = '<b>' + esc(d.name) + '</b><em>' + esc(d.key) + '</em>';
    place(box, el);
  }
  function select(el) { selEl = el; place($('ed-sel'), el); }

  // ---------- 直接在頁面上改字 ----------
  function startInline(el) {
    var key = el.getAttribute('data-i18n'); if (!key) return;
    closeMenu(); select(null); showHover(null);
    var before = el.innerHTML;
    editing = el; el.classList.add('ed-editing'); el.setAttribute('contenteditable', 'true'); el.focus();
    var r = document.createRange(); r.selectNodeContents(el); var s = getSelection(); s.removeAllRanges(); s.addRange(r);
    function finish(ok) {
      el.removeEventListener('keydown', onKey); el.removeEventListener('blur', onBlur); el.removeEventListener('paste', onPaste);
      el.removeAttribute('contenteditable'); el.classList.remove('ed-editing'); editing = null;
      var v = el.innerHTML.replace(/&nbsp;/g, ' ').replace(/(<br\s*\/?>)+$/i, '').trim();
      if (!ok || v === before) { el.innerHTML = before; refresh(); return; }
      setText(key, lang(), v); toast('已改（' + langLabel(lang()) + '），按「儲存」寫入');
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    }
    function onBlur() { finish(true); }
    function onPaste(e) { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text')); }
    el.addEventListener('keydown', onKey); el.addEventListener('blur', onBlur); el.addEventListener('paste', onPaste);
  }

  // ---------- 對話框 ----------
  function dialog(title, sub, body, buttons) {
    var dlg = $('ed-dlg');
    dlg.innerHTML = '<h4>' + esc(title) + (sub ? '<small>' + sub + '</small>' : '') + '</h4><div class="bd"></div><div class="ft"></div>';
    var bd = dlg.querySelector('.bd'), ft = dlg.querySelector('.ft');
    if (typeof body === 'string') bd.innerHTML = body; else bd.appendChild(body);
    (buttons || [{ text: '關閉' }]).forEach(function (b) {
      var btn = h('button', { type: 'button', 'class': 'ed-btn' + (b.pri ? ' pri' : '') }, esc(b.text));
      btn.addEventListener('click', function () { if (b.fn && b.fn() === false) return; closeDialog(); });
      ft.appendChild(btn);
    });
    $('ed-mask').classList.add('show');
    var f = bd.querySelector('textarea,input'); if (f) setTimeout(function () { f.focus(); }, 30);
    return bd;
  }
  function closeDialog() { $('ed-mask').classList.remove('show'); }

  function editAllLangs(key) {
    var e = I18N.t[key]; if (!e) return;
    var wrap = h('div');
    wrap.appendChild(h('div', { 'class': 'hint' }, '可以用 &lt;br&gt; 換行；看到 &lt;i&gt;…&lt;/i&gt; 這類標記請保留。改完按「套用」，再按工具列的「儲存」才會寫進檔案。'));
    LANGS.forEach(function (L) {
      var row = h('div', { 'class': 'row' + (L.code === lang() ? ' cur' : '') });
      row.appendChild(h('label', { 'for': 'ed-f-' + L.code }, esc(L.label)));
      var ta = h('textarea', { id: 'ed-f-' + L.code, rows: Math.min(6, Math.max(1, Math.ceil((e[L.code] || '').length / 30))) });
      ta.value = e[L.code] || ''; row.appendChild(ta); wrap.appendChild(row);
    });
    var aiFor = null;  // 按過「AI 翻譯」時記下當時的繁中，套用時寫進翻譯紀錄（之後不會再被列成待翻）
    dialog(LABEL[key] || key, '文字鍵：' + esc(key), wrap, [
      { text: 'AI 翻譯其他語言', fn: function () {
        // 沒金鑰：先讓這個對話框關掉，再開設定（同步開的話會被接著的關閉動作一起關掉）
        if (!aiKey()) { setTimeout(function () { aiSettings(function () { editAllLangs(key); }); }, 30); return; }
        var tw = $('ed-f-tw').value.trim(), btn = $('ed-dlg').querySelector('.ft .ed-btn');
        if (!tw) { toast('繁中是空的', true); return false; }
        btn.disabled = true; btn.textContent = '翻譯中…';
        var ov = {}; ov[key] = tw;
        aiRun([key], null, ov).then(function (out) {
          var x = out.res[key];
          if (x) { AI_LANGS.forEach(function (l) { if ((x[l] || '').trim()) $('ed-f-' + l).value = x[l].trim(); }); aiFor = tw; }
          if (out.error) toast('翻譯失敗：' + out.error, true);
          else toast(out.warn.length ? out.warn[0] : '已填入（約 ' + aiMoney(out.cost) + '），確認後按「套用」', !!out.warn.length);
        }).catch(function (er) { toast('翻譯失敗：' + er.message, true); })
          .then(function () { btn.disabled = false; btn.textContent = 'AI 翻譯其他語言'; });
        return false;
      } },
      { text: '取消' },
      { text: '套用', pri: true, fn: function () {
        remember(key);
        LANGS.forEach(function (L) { var v = $('ed-f-' + L.code).value.trim(); if (v !== (e[L.code] || '')) I18N.t[key][L.code] = v; });
        if (aiFor !== null && aiFor === I18N.t[key].tw) SRCP[key] = aiFor;
        refresh(); if (dirtyKeys().indexOf(key) >= 0) toast('已套用，按「儲存」寫入');
      } }
    ]);
    $('ed-dlg').querySelector('.ft .ed-btn').style.marginRight = 'auto';  // AI 鈕靠左，跟取消／套用分開
    // 對話框內 Ctrl+Enter＝套用
    $('ed-dlg').onkeydown = function (ev) { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); $('ed-dlg').querySelector('.ed-btn.pri').click(); } };
  }

  function hiddenTexts() {
    var shown = {};
    [].forEach.call(document.querySelectorAll('[data-i18n]'), function (el) { shown[el.getAttribute('data-i18n')] = 1; });
    var keys = Object.keys(I18N.t).filter(function (k) { return !shown[k]; });
    var list = h('div', { 'class': 'list' });
    keys.forEach(function (k) {
      var a = h('a', { href: '#' }, '<span>' + esc(LABEL[k] || k) + '</span><span>' + esc(plain(I18N.t[k][lang()] || I18N.t[k].tw)) + '</span>');
      a.addEventListener('click', function (ev) { ev.preventDefault(); closeDialog(); editAllLangs(k); });
      list.appendChild(a);
    });
    dialog('頁面上看不到的文字', '瀏覽器分頁標題、下載檔名、替代文字、歷史回顧頁用字等', list);
  }

  // ---------- 換圖片／影片 ----------
  var fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm', style: 'display:none' });
  function replaceMedia(el) {
    var name = el.getAttribute('data-media');
    fileInput.value = '';
    fileInput.onchange = function () {
      var f = fileInput.files[0]; if (!f) return;
      var ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase(); if (ext === '.jpeg') ext = '.jpg';
      toast('上傳中…（' + (f.size / 1048576).toFixed(1) + ' MB）');
      fetch('/api/media?name=' + encodeURIComponent(name) + '&ext=' + encodeURIComponent(ext), { method: 'POST', body: f })
        .then(function (r) { return r.json(); })
        .then(function (r) {
          if (!r.ok) throw new Error(r.error || '上傳失敗');
          var isv = /\.(mp4|webm)$/.test(r.file), was = el.tagName === 'VIDEO' ? 'v' : el.tagName === 'IMG' ? 'i' : 'p';
          if ((isv && was === 'v') || (!isv && was === 'i')) {  // 同類型：直接換掉來源
            el.src = r.url || ('/media/' + encodeURIComponent(r.file) + '?v=' + Date.now());  // 網頁版：後端直接給預覽網址
            var dl = el.parentNode.querySelector('a.dl'); if (dl) dl.setAttribute('data-ext', r.file.replace(/^[^.]+/, ''));
            toast('已換上（換錯了按 Ctrl+Z 或「復原」換回來）');
          } else {  // 圖片↔影片、或原本是空位：重新載入頁面才會換成對的標籤與下載鈕
            save().then(function (ok) { if (ok) { window.__edNoWarn = true; edReloadPage(); } });
          }
        })
        .catch(function (e) { toast('換檔失敗：' + e.message, true); });
    };
    fileInput.click();
  }

  // ---------- 結構：區塊、剪貼簿、插入刪除移動 ----------
  // 區塊參照：圖說、下載鈕、圖片本身都算「那張圖片影片」；其他用文字鍵，伺服器再判斷是段落／項目／分類／固定物件。
  function blockRef(el) {
    var fig = el.closest('figure');
    if (fig) { var m = fig.querySelector('[data-media]'); if (m) return 'media:' + m.getAttribute('data-media'); }
    if (el.hasAttribute('data-media')) return 'media:' + el.getAttribute('data-media');
    return el.getAttribute('data-i18n') || el.getAttribute('data-i18n-alt');
  }
  function refEl(ref) {
    if (!ref) return null;
    return ref.indexOf('media:') === 0 ? document.querySelector('[data-media="' + ref.slice(6) + '"]') : document.querySelector('[data-i18n="' + ref + '"]');
  }
  function refName(ref) {  // 給人看的名字：項目／分類用標題、段落用前幾個字、圖片用圖說
    var el = refEl(ref); if (!el) return ref;
    if (ref.indexOf('media:') === 0) { var c = I18N.t['cap_' + ref.slice(6)]; return '「' + plain(c ? (c[lang()] || c.tw) : ref.slice(6)) + '」'; }
    var t = plain(el.innerHTML); return '「' + (t.length > 18 ? t.slice(0, 18) + '…' : t) + '」';
  }
  function getClip() { try { return JSON.parse(sessionStorage.getItem('ed-clip') || 'null'); } catch (e) { return null; } }
  function setClip(c) { sessionStorage.setItem('ed-clip', JSON.stringify(c)); markCut(); }
  function markCut() {
    [].forEach.call(document.querySelectorAll('.ed-cut'), function (e) { e.classList.remove('ed-cut'); });
    var c = getClip(); if (!c || c.mode !== 'cut') return;
    var el = refEl(c.ref); if (!el) return;
    var blk = c.level === 'item' ? el.closest('.item') : c.level === 'section' ? el.closest('section') : c.level === 'media' ? el.closest('figure') : el;
    if (blk) blk.classList.add('ed-cut');
  }
  function describeRef(ref) {
    if (!ref) return Promise.resolve({ level: 'fixed' });
    return api('/api/describe', { ref: ref }).then(function (r) { return r.ok ? r : { level: 'fixed' }; }).catch(function () { return { level: 'fixed' }; });
  }
  // 送出結構動作：先存未存的文字 → 伺服器改版型 → 記下要捲回哪裡 → 重新整理
  function structOp(body, after) {
    return save().then(function (ok) {
      if (!ok) return;
      return api('/api/struct', body).then(function (r) {
        if (!r.ok) { toast(r.error || '做不到', true); return; }
        if (after) after(r);
        reloadTo(r.focus || body.ref, r.label + '（Ctrl+Z 可復原）');
      });
    }).catch(function (e) { toast('失敗：' + e.message, true); });
  }
  function reloadTo(ref, msg) {
    sessionStorage.setItem('ed-after', JSON.stringify({ ref: ref, msg: msg, y: scrollY }));
    window.__edNoWarn = true; edReloadPage();
  }
  function insertBelow(el, kind) { structOp({ op: 'insert', ref: blockRef(el), kind: kind }); }
  function doCopy(el, info, mode) {
    setClip({ mode: mode, ref: blockRef(el), level: info.level, label: KIND_NAME[info.level] + refName(blockRef(el)) });
    toast((mode === 'cut' ? '已剪下' : '已複製') + KIND_NAME[info.level] + '，到要放的位置按右鍵「貼上」或 Ctrl+V');
  }
  function doPaste(el) {
    var c = getClip(); if (!c) { toast('剪貼簿是空的', true); return; }
    structOp({ op: 'paste', ref: blockRef(el), src: c.ref, kind: c.mode }, function () { if (c.mode === 'cut') sessionStorage.removeItem('ed-clip'); });
  }
  function doDelete(el, info) {
    var ref = blockRef(el), blk = refEl(ref);
    var box = info.level === 'item' ? blk.closest('.item') : info.level === 'section' ? blk.closest('section') : null;
    var nm = box ? box.querySelectorAll('[data-media]').length : 0;
    dialog('刪除' + KIND_NAME[info.level] + '？', '',
      '<div class="hint" style="font-size:13.5px;color:#e8dcc2">' + esc(KIND_NAME[info.level] + refName(ref)) +
      (nm ? '，裡面有 ' + nm + ' 個圖片／影片（檔案會搬進 backups，不會真的刪掉）' : '') + '。</div>' +
      '<div class="hint">刪錯了可以按 Ctrl+Z 或工具列「復原」還原。</div>',
      [{ text: '取消' }, { text: '刪除', pri: true, fn: function () { structOp({ op: 'delete', ref: ref }); } }]);
    var b = $('ed-dlg').querySelector('.ed-btn.pri'); if (b) setTimeout(function () { b.focus(); }, 30);
  }
  function undoAction() {
    if (editing) return;
    if (HIST.length) {
      var hst = HIST.pop(); I18N.t[hst.key] = hst.prev; refresh(); toast('已復原文字'); return;
    }
    save().then(function (ok) {
      if (!ok) return;
      api('/api/undo', {}).then(function (r) {
        if (!r.ok) { toast(r.error, true); return; }
        reloadTo(null, '已復原：' + r.label);
      });
    });
  }

  // 捨棄全部變更：整個回到上次發布的樣子（未儲存的文字直接丟掉；已存的改動、換過的圖、插入刪除都還原）
  function discardAll() {
    if (editing) editing.blur();
    var pending = dirtyKeys().length;
    api('/api/changes', {}).then(function (c) {
      if (!c.ok) { toast(c.error, true); return; }
      var server = c.template || c.texts || c.media.length, lines = [];
      if (pending) lines.push('還沒儲存的文字 ' + pending + ' 處');
      if (c.texts) lines.push('已儲存的文字改動 ' + c.texts + ' 段');
      if (c.template) lines.push('新增、刪除、移動過的段落／項目／分類');
      if (c.media.length) lines.push('換過的圖片影片：' + c.media.join('、'));
      if (!lines.length) { toast('跟上次發布一模一樣，沒有東西可以捨棄'); return; }
      dialog('捨棄全部變更？', '整個回到上次發布的樣子（也就是現在公開網站上的內容）',
        '<div class="hint" style="font-size:13.5px;color:#e8dcc2;line-height:2">' + lines.map(function (x) { return '◆ ' + esc(x); }).join('<br>') + '</div>' +
        '<div class="hint">換掉的圖片和改過的檔案會搬進 backups，捨棄錯了可以馬上按 Ctrl+Z 或「復原」找回來（還沒儲存的文字找不回來）。</div>',
        [{ text: '取消' }, { text: '捨棄', pri: true, fn: function () {
          I18N.t = JSON.parse(JSON.stringify(SAVED)); HIST = [];
          if (!server) { refresh(); toast('已捨棄未儲存的文字'); return; }
          api('/api/discard', {}).then(function (r) {
            if (!r.ok) { toast(r.error, true); return; }
            reloadTo(null, '已回到上次發布的樣子（Ctrl+Z 可找回）');
          });
        } }]);
    }).catch(function (e) { toast('失敗：' + e.message, true); });
  }

  // ---------- AI 翻譯（繁中 → 简中／English／日本語／한국어／Русский） ----------
  // 做法照海盜演出編輯器（docs/PirateEditor.html 的 AI 編演出）：瀏覽器直連 Anthropic API，
  // 金鑰只存這台電腦的瀏覽器 localStorage（不寫進任何檔案、不會被發布）。
  // 待翻＝繁中跟「上次翻譯時的繁中」（i18n_src.json）不同，或有語言是空的。翻好先放「未儲存」，按儲存才寫入。
  // 目前模型不接受強制指定工具（tool_choice any/tool 會 400）→ 用 auto＋strict 工具＋提示最後一句要求呼叫。
  var AI_URL = 'https://api.anthropic.com/v1/messages', AI_LS_KEY = 'gp_aiKey', AI_LS_MODEL = 'gp_aiModel';
  // 預設 Haiku 5.5 High（使用者 2026-10-30 決定）：官方公告短句＋參考既有譯文，Haiku 夠用，費用約 Sonnet 的 1/20
  var AI_DEFAULT_MODEL = 'claude-haiku-5-5', AI_USD_TWD = 33, AI_BATCH = 10;
  // p＝[輸入, 輸出] 每百萬 token 美金；effort 不寫＝用模型預設；thinking:false＝Haiku 關掉思考（Sonnet／Opus 5.5 不能關）
  var AI_MODELS = [
    { id: 'claude-haiku-5-5@off', api: 'claude-haiku-5-5', name: 'Haiku 5.5 不思考', d: '最快最省，短句夠用', p: [0.10, 0.50], thinking: false },
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5 High', d: '預設，便宜又夠用', p: [0.10, 0.50], effort: 'high' },
    { id: 'claude-sonnet-5-5@low', api: 'claude-sonnet-5-5', name: 'Sonnet 5.5 Low', d: '語感比 Haiku 好，費用約 20 倍', p: [2, 10], effort: 'low' },
    { id: 'claude-sonnet-5-5@medium', api: 'claude-sonnet-5-5', name: 'Sonnet 5.5 Medium', d: '譯文要更講究時用（最高就到這）', p: [2, 10], effort: 'medium' }
    // 使用者 2026-10-30：翻譯最多用到 Sonnet 5.5 Medium，Sonnet High、Opus 不列
  ];
  var AI_LANGS = ['cn', 'en', 'ja', 'ko', 'ru'];
  function aiKey() { try { return localStorage.getItem(AI_LS_KEY) || ''; } catch (e) { return ''; } }
  function aiModelId() { var m = ''; try { m = localStorage.getItem(AI_LS_MODEL) || ''; } catch (e) {} return AI_MODELS.some(function (x) { return x.id === m; }) ? m : AI_DEFAULT_MODEL; }
  function aiCost(mid, u) {
    var m = AI_MODELS.filter(function (x) { return x.id === mid; })[0]; if (!m || !u) return 0;
    var inT = u.input_tokens || 0, rd = u.cache_read_input_tokens || 0, wr = u.cache_creation_input_tokens || 0;
    var c = (inT * m.p[0] + rd * m.p[0] * 0.1 + wr * m.p[0] * 1.25 + (u.output_tokens || 0) * m.p[1]) / 1e6;
    if ((m.api || m.id) === 'claude-haiku-5-5' && inT + rd + wr > 100000) c *= 5;
    return c;
  }
  function aiMoney(c) { var n = c * AI_USD_TWD; return 'NT$ ' + (n < 0.095 ? Math.max(0.01, Math.round(n * 100) / 100) : Math.round(n * 10) / 10) + ' 元'; }
  function curSrc(k) { return Object.prototype.hasOwnProperty.call(SRCP, k) ? SRCP[k] : SRC[k]; }
  function needKeys() {
    return Object.keys(I18N.t).filter(function (k) {
      var e = I18N.t[k], tw = (e.tw || '').trim(); if (!tw) return false;
      return curSrc(k) !== e.tw || AI_LANGS.some(function (l) { return !(e[l] || '').trim(); });
    });
  }
  function updateAIBtn() { var b = $('ed-ai'); if (!b) return; var n = needKeys().length; b.textContent = 'AI翻譯' + (n ? '（' + n + '）' : ''); b.classList.toggle('pri2', !!n); }
  function aiModelSelect(id) {
    return '<select id="' + id + '" class="ed-sel">' + AI_MODELS.map(function (m) {
      return '<option value="' + m.id + '"' + (m.id === aiModelId() ? ' selected' : '') + '>' + esc(m.name + '　— ' + m.d) + '</option>';
    }).join('') + '</select>';
  }
  function aiSettings(then) {
    var bd = dialog('AI 翻譯設定', '只支援 Anthropic（Claude）的 API 金鑰',
      '<div class="row"><label for="ed-aikey">API 金鑰</label><input type="text" id="ed-aikey" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" style="-webkit-text-security:disc"></div>' +
      '<div class="row"><label for="ed-aimodel">模型</label>' + aiModelSelect('ed-aimodel') + '</div>' +
      '<div class="hint">金鑰只存在這台電腦的瀏覽器（localStorage），不會寫進網站檔案、也不會被發布；按「翻譯」時直接送到 api.anthropic.com。演出編輯器存的金鑰在另一個地方，這裡要再貼一次。</div>',
      [{ text: '取消' }, { text: '儲存', pri: true, fn: function () {
        var k = $('ed-aikey').value.trim();
        try { if (k) localStorage.setItem(AI_LS_KEY, k); localStorage.setItem(AI_LS_MODEL, $('ed-aimodel').value); } catch (e) {}
        if (!aiKey()) { toast('請貼上金鑰', true); return false; }
        if (then) setTimeout(then, 50);
      } }]);
    if (aiKey()) bd.querySelector('#ed-aikey').placeholder = '已設定（要換金鑰才需要重貼）';
  }
  function aiSystem(skip) {
    // 參考：其他段落現有的六語言（用詞、遊戲名、語氣跟著對齊）
    var ref = {};
    Object.keys(I18N.t).forEach(function (k) {
      if (skip[k]) return; var e = I18N.t[k];
      if (AI_LANGS.every(function (l) { return (e[l] || '').trim(); })) ref[k] = e;
    });
    return [
      '你是遊戲《閃光雞海賊團》（英文 Glowstick Pirates）官方網站「更新週報」的在地化譯者。',
      '把繁體中文翻成：cn＝簡體中文（中國大陸用語）、en＝英文、ja＝日文、ko＝韓文、ru＝俄文。',
      '規則：',
      '- 語氣是官方更新公告：理性、精簡，不加原文沒有的內容，不加表情符號。',
      '- HTML 標籤（例如 <i>…</i>、<br>）、{變數}、[群組/鍵]、Perfect／Good 這類英文字照原樣保留，位置對應原文。',
      '- 遊戲名：簡中 闪光鸡海贼团、日文 ピカチン海賊団、英韓俄 Glowstick Pirates；繁中原文寫「閃光雞雞海賊團」時簡中寫「闪光鸡鸡海贼团」，其他語言照下方參考的寫法。',
      '- 固定譯名：易位＝Swap（英）／入れ替え（日）；回復禁止＝No Healing（英）。其他詞以下方參考既有翻譯為準，同一個詞前後要一致。',
      '- 有提供「舊譯文」時，只依繁中改動的部分調整，其餘沿用舊譯文的寫法。',
      '- 原文已經是英文（例如品牌名、版權宣告）就各語言照抄。',
      '',
      '參考（網站其他段落現有的翻譯）：',
      JSON.stringify(ref)
    ].join('\n');
  }
  // 串流＋eager_input_streaming：翻譯結果邊產生邊送來，每翻完一段就能打勾（不開的話工具內容會整包在最後才到）。
  // 開了之後 API 不再驗證工具輸入 → 不加 strict，改由 aiItemsSoFar／aiRun 自己檢查每一筆的欄位。
  var AI_TOOL = {
    name: 'save_translations', eager_input_streaming: true,
    description: '回報翻譯結果。items 每一筆對應一個要翻譯的鍵，五種語言都要給。依輸入的順序一段一段輸出。',
    input_schema: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['key', 'cn', 'en', 'ja', 'ko', 'ru'],
      properties: { key: { type: 'string' }, cn: { type: 'string' }, en: { type: 'string' }, ja: { type: 'string' }, ko: { type: 'string' }, ru: { type: 'string' } } } } } }
  };
  // 從還沒收完的工具 JSON 裡挑出「已經完整」的每一段：逐字掃，分得出字串裡的大括號（例如 {變數}）
  function aiItemsSoFar(json) {
    var out = [], depth = 0, inStr = false, esc2 = false, start = -1;
    for (var i = 0; i < json.length; i++) {
      var c = json[i];
      if (inStr) { if (esc2) esc2 = false; else if (c === '\\') esc2 = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') { depth++; if (c === '{' && depth === 3) start = i; }
      else if (c === '}' || c === ']') {
        if (c === '}' && depth === 3 && start >= 0) {
          try { var o = JSON.parse(json.slice(start, i + 1)); if (o && typeof o.key === 'string') out.push(o); } catch (e) {}
          start = -1;
        }
        depth--;
      }
    }
    return out;
  }
  // onItems(已完成的各段, 正在翻的鍵)；signal＝停止鈕。回傳 {items, cost, aborted, truncated}
  function aiCall(items, mid, skip, onItems, signal) {
    var m = AI_MODELS.filter(function (x) { return x.id === mid; })[0] || AI_MODELS.filter(function (x) { return x.id === AI_DEFAULT_MODEL; })[0];
    var user = '請翻譯以下 ' + items.length + ' 段（JSON）：\n' + JSON.stringify(items) + '\n\n翻完請呼叫 save_translations，依上面的順序一次回報全部 ' + items.length + ' 段。';
    var body = {
      model: m.api || m.id, max_tokens: 16000, stream: true,
      system: [{ type: 'text', text: aiSystem(skip), cache_control: { type: 'ephemeral' } }],
      tools: [AI_TOOL], tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: user }]
    };
    if (m.effort) body.output_config = { effort: m.effort };
    if (m.thinking === false) body.thinking = { type: 'disabled' };
    var st = { json: '', toolIdx: -1, usage: {}, stop: '', count: 0 };
    function cur() { var r = /"key"\s*:\s*"((?:[^"\\]|\\.)*)"/g, mm, last = null; while ((mm = r.exec(st.json))) last = mm[1]; return last; }
    function handle(ev) {
      if (ev.type === 'message_start') Object.assign(st.usage, (ev.message && ev.message.usage) || {});
      else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use' && ev.content_block.name === 'save_translations') st.toolIdx = ev.index;
      else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'input_json_delta' && ev.index === st.toolIdx) {
        st.json += ev.delta.partial_json || '';
        if (onItems) { var got = aiItemsSoFar(st.json); onItems(got, cur()); }
      } else if (ev.type === 'message_delta') {
        if (ev.usage) Object.assign(st.usage, ev.usage);
        if (ev.delta && ev.delta.stop_reason) st.stop = ev.delta.stop_reason;
      } else if (ev.type === 'error') throw new Error((ev.error && ev.error.message) || '串流錯誤');
    }
    function result(aborted) {
      var got = null;
      if (!aborted) { try { got = JSON.parse(st.json).items; } catch (e) {} }
      if (!Array.isArray(got)) got = aiItemsSoFar(st.json);
      return { items: got, cost: aiCost(m.id, st.usage), aborted: aborted, truncated: st.stop === 'max_tokens' };
    }
    return fetch(AI_URL, {
      method: 'POST', signal: signal,
      headers: { 'content-type': 'application/json', 'x-api-key': aiKey(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) return res.json().catch(function () { return {}; }).then(function (data) {
        var msg = (data.error && data.error.message) || ('HTTP ' + res.status);
        throw new Error(res.status === 401 ? '金鑰無效或已停用（' + msg + '）' : res.status === 429 ? '請求太頻繁或額度用完（' + msg + '）' : msg);
      });
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          var parts = buf.split(/\r?\n\r?\n/); buf = parts.pop();
          parts.forEach(function (blk) {
            var data = blk.split(/\r?\n/).filter(function (l) { return l.indexOf('data:') === 0; }).map(function (l) { return l.slice(5).trim(); }).join('');
            if (data) handle(JSON.parse(data));
          });
          return pump();
        });
      }
      return pump().then(function () {
        if (st.stop === 'refusal') throw new Error('模型拒絕翻譯這段內容');
        var r = result(false);
        if (!r.items.length) throw new Error(st.stop === 'max_tokens' ? '回覆太長被截斷，請少選幾段再試' : '模型沒有回報翻譯結果，請再試一次');
        return r;
      });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return result(true);  // 按了停止：已經翻好的段落照樣交回去
      throw e;
    });
  }
  // 標籤、{變數}、[群組/鍵] 要跟原文一樣多，不一樣就列警告（還是套用，讓人自己看）
  function aiMarks(s) { return (String(s).match(/<\/?[a-z][^>]*>|\{[^}]*\}|\[[^\]\/]+\/[^\]]+\]/gi) || []).map(function (x) { return x.replace(/\s+/g, ''); }).sort().join('|'); }
  // 翻譯一組鍵；回傳 {done, warn, cost, res, aborted}。onProgress({done, total, cur, batch, batches}) 每翻完一段呼叫一次。
  function aiRun(keys, onProgress, twOverride, signal) {
    var skip = {}; keys.forEach(function (k) { skip[k] = 1; });
    var mid = aiModelId(), out = { done: [], warn: [], cost: 0, res: {}, aborted: false }, chunks = [];
    for (var i = 0; i < keys.length; i += AI_BATCH) chunks.push(keys.slice(i, i + AI_BATCH));
    function twOf(k) { return twOverride && twOverride[k] != null ? twOverride[k] : I18N.t[k].tw; }
    function take(x, ch) {  // 收下一段（檢查五種語言都有、標籤變數跟原文一樣多）
      if (ch.indexOf(x.key) < 0 || out.res[x.key]) return false;
      var bad = AI_LANGS.filter(function (l) { return typeof x[l] !== 'string' || !x[l].trim() || aiMarks(x[l]) !== aiMarks(twOf(x.key)); });
      if (AI_LANGS.some(function (l) { return typeof x[l] !== 'string' || !x[l].trim(); })) { out.warn.push((LABEL[x.key] || x.key) + '：有語言沒翻出來，沒有套用'); return false; }
      if (bad.length) out.warn.push((LABEL[x.key] || x.key) + '（' + bad.join('、') + ' 的標籤或變數跟原文不同，請檢查）');
      out.res[x.key] = x; out.done.push(x.key);
      return true;
    }
    return chunks.reduce(function (p, ch, ci) {
      return p.then(function () {
        if (out.aborted) return;
        var prog = function (cur) { if (onProgress) onProgress({ done: out.done.length, total: keys.length, cur: cur, batch: ci + 1, batches: chunks.length, res: out.res }); };
        prog(null);
        var items = ch.map(function (k) {
          var e = I18N.t[k], tw = twOverride && twOverride[k] != null ? twOverride[k] : e.tw, it = { key: k, tw: tw };
          var old = {}, has = false;
          AI_LANGS.forEach(function (l) { if ((e[l] || '').trim()) { old[l] = e[l]; has = true; } });
          if (has && curSrc(k) && curSrc(k) !== tw) { it['舊譯文'] = old; it['舊繁中'] = curSrc(k); }
          return it;
        });
        var lastCur = null;
        return aiCall(items, mid, skip, function (got, cur) {
          var added = false;
          got.forEach(function (x) { if (take(x, ch)) added = true; });
          if (added || cur !== lastCur) { lastCur = cur; prog(cur && !out.res[cur] ? cur : null); }
        }, signal).then(function (r) {
          out.cost += r.cost;
          r.items.forEach(function (x) { take(x, ch); });
          if (r.aborted) { out.aborted = true; return; }
          if (r.truncated) out.warn.push('第 ' + (ci + 1) + ' 批回覆太長被截斷，沒翻完的段落請再按一次');
          ch.forEach(function (k) { if (!out.res[k] && !r.truncated) out.warn.push((LABEL[k] || k) + '：模型漏翻了'); });
          prog(null);
        }).catch(function (e) {  // 中途出錯：已翻好的段落保留，後面的批次不再送
          out.error = e.message; out.aborted = true;
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  }
  function aiApply(out) {
    out.done.forEach(function (k) {
      remember(k);
      AI_LANGS.forEach(function (l) { if ((out.res[k][l] || '').trim()) I18N.t[k][l] = out.res[k][l].trim(); });
      SRCP[k] = I18N.t[k].tw;
    });
    refresh();
  }
  function aiNeedKey(then) { if (aiKey()) return true; aiSettings(then); return false; }
  function aiTranslateDialog() {
    if (editing) editing.blur();
    if (!aiNeedKey(aiTranslateDialog)) return;
    var keys = needKeys();
    if (!keys.length) { toast('沒有需要翻譯的段落（繁中都翻過了）'); return; }
    var list = keys.map(function (k) {
      var t = plain(I18N.t[k].tw); if (t.length > 40) t = t.slice(0, 40) + '…';
      var why = AI_LANGS.some(function (l) { return !(I18N.t[k][l] || '').trim(); }) ? '缺翻譯' : '繁中改過';
      return '<label class="ai-row" data-row="' + esc(k) + '"><input type="checkbox" data-k="' + esc(k) + '" checked><span class="lb">' + esc(LABEL[k] || k) + '<em>' + why + '</em></span><span class="tx">' + esc(t) + '</span></label>';
    }).join('');
    var bd = dialog('AI 翻譯', '把繁中翻成其他五種語言（翻好先放「未儲存」，檢查後按儲存）',
      '<div class="row"><label for="ed-aimodel2">模型</label>' + aiModelSelect('ed-aimodel2') + '</div>' +
      '<div class="ai-list">' + list + '</div>' +
      '<div class="ai-prog" id="ed-aiprog"><i></i></div><div class="hint" id="ed-aistat"></div>',
      [{ text: '取消' }, { text: '設定金鑰', fn: function () { setTimeout(function () { aiSettings(aiTranslateDialog); }, 30); } },
       { text: '翻譯', pri: true, fn: function () {
        try { localStorage.setItem(AI_LS_MODEL, $('ed-aimodel2').value); } catch (e) {}
        var pick = [].filter.call(bd.querySelectorAll('input[data-k]'), function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-k'); });
        if (!pick.length) { toast('沒有勾選要翻的段落', true); return false; }
        aiRunInDialog(bd, pick);
        return false;
      } }]);
  }
  // 翻譯中的對話框：每段打勾、正在翻的那段亮起來、進度條＋經過秒數；底下只剩「停止」
  function aiRunInDialog(bd, pick) {
    var stat = $('ed-aistat'), bar = $('ed-aiprog'), ctrl = new AbortController(), t0 = Date.now(), last = { done: 0, total: pick.length, cur: null };
    $('ed-aimodel2').disabled = true;
    [].forEach.call(bd.querySelectorAll('.ai-row'), function (r) {
      var k = r.getAttribute('data-row'), on = pick.indexOf(k) >= 0;
      r.classList.add(on ? 'wait' : 'skip'); r.querySelector('input').disabled = true;
    });
    bar.classList.add('on');
    var ft = $('ed-dlg').querySelector('.ft'); ft.innerHTML = '';
    var stop = h('button', { type: 'button', 'class': 'ed-btn' }, '停止');
    stop.addEventListener('click', function () { stop.disabled = true; stop.textContent = '停止中…'; ctrl.abort(); });
    ft.appendChild(stop);
    function draw() {
      var sec = Math.round((Date.now() - t0) / 1000), name = last.cur ? '「' + (LABEL[last.cur] || last.cur) + '」' : '';
      var phase = last.done >= last.total ? '收尾中' : last.cur ? '正在翻' + name : (last.done ? '準備下一段' : '模型思考中');
      stat.style.color = '#f0c060';
      stat.textContent = '已完成 ' + last.done + '／' + last.total + ' 段・' + phase + '…・已過 ' + sec + ' 秒' + (last.batches > 1 ? '（第 ' + last.batch + '／' + last.batches + ' 批）' : '');
      bar.firstChild.style.width = (last.total ? last.done / last.total * 100 : 0) + '%';
    }
    var timer = setInterval(draw, 500); draw();
    aiRun(pick, function (p) {
      last = p;
      [].forEach.call(bd.querySelectorAll('.ai-row.wait,.ai-row.cur'), function (r) {
        var k = r.getAttribute('data-row');
        r.classList.remove('cur');
        if (p.res[k]) { r.classList.remove('wait'); r.classList.add('done'); }
        else if (k === p.cur) r.classList.add('cur');
      });
      var c = bd.querySelector('.ai-row.cur'); if (c) c.scrollIntoView({ block: 'nearest' });
      draw();
    }, null, ctrl.signal).then(function (out) {
      clearInterval(timer);
      aiApply(out); closeDialog();
      var cost = '約 ' + aiMoney(out.cost);
      var head = out.error ? '翻譯中途出錯：' + out.error : out.aborted ? '已停止' : '翻譯完成';
      var msg = '翻好 ' + out.done.length + '／' + pick.length + ' 段已套用（' + cost + '），檢查後按「儲存」';
      if (out.warn.length || out.error || out.aborted)
        dialog(head, msg, out.warn.length ? '<div class="hint" style="color:#f0b060;line-height:2">' + out.warn.map(esc).join('<br>') + '</div>' :
          '<div class="hint">沒翻完的段落還會留在「AI翻譯」的待翻清單裡，再按一次就會接著翻。</div>');
      else toast('已翻譯 ' + out.done.length + ' 段（' + cost + '），檢查後按「儲存」');
    });
  }
  function aiTranslateOne(key) {
    if (!aiNeedKey(function () { aiTranslateOne(key); })) return;
    toast('AI 翻譯中…');
    aiRun([key]).then(function (out) {
      aiApply(out);
      if (out.error) toast('翻譯失敗：' + out.error, true);
      else toast(out.warn.length ? out.warn[0] : '已翻成其他五種語言（約 ' + aiMoney(out.cost) + '），按「儲存」寫入', !!out.warn.length);
    });
  }

  // ---------- 文章（期數）：切換／新增／刪除（伺服器 editions.py） ----------
  // 每一期有自己的原始檔；編輯器一次只編一期。換期數前，目前這期不能有還沒發布的改動（先發布或捨棄）。
  var EDL = null;
  function fmtDate(d) { return d ? d.replace(/-/g, '.') : ''; }
  function loadEditions() {
    return api('/api/editions').then(function (L) {
      EDL = L;
      var cur = (L.editions || []).filter(function (e) { return e.active; })[0];
      $('ed-ed').textContent = '文章 ' + fmtDate(L.active) + (cur && !cur.published ? '（未發布）' : '') + ' ▾';
      return L;
    });
  }
  function today() { var t = new Date(); return t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2); }
  // 換期數／開新一期之前：把還沒存的字存起來，有還沒發布的改動就問要發布還是捨棄
  function edClean(then, what) {
    if (editing) editing.blur();
    save().then(function (ok) {
      if (!ok) return;
      if (window.ED_KEEP_DRAFTS) { then(); return; }  // 網頁版：每一期的草稿各自保存，換期數不用先發布
      api('/api/changes', {}).then(function (c) {
        if (!c.ok || !(c.template || c.texts || c.media.length)) { then(); return; }
        dialog('這一期還有改動沒有發布', '要' + what + '之前，請決定目前這期（' + fmtDate(EDL && EDL.active) + '）的改動怎麼處理',
          '<div class="hint" style="font-size:13px;color:#e8dcc2">發布＝把改動放上公開網站；捨棄＝回到上次發布的樣子（之後還能用「復原」找回）。</div>',
          [{ text: '取消' },
           { text: '捨棄後繼續', fn: function () { api('/api/discard', {}).then(function (r) { if (!r.ok) { toast(r.error, true); return; } then(); }); } },
           { text: '發布後繼續', pri: true, fn: function () {
             var bd = dialog('發布中…', '大約需要 10～30 秒', '<pre>處理中…</pre>', []);
             api('/api/publish', { msg: '修改文字' }).then(function (r) {
               if (!r.ok) { bd.querySelector('pre').textContent = '發布失敗，沒有換期數：\n' + (r.log || '').slice(-2000); return; }
               closeDialog(); then();
             });
             return false;
           } }]);
      });
    });
  }
  function edOp(op, date, msg) {
    var bd = dialog(msg + '…', '', '<pre>處理中…</pre>', []);
    return api('/api/editions', { op: op, date: date }).then(function (r) {
      if (!r.ok) { bd.querySelector('pre').textContent = '失敗：' + r.error; var ft = $('ed-dlg').querySelector('.ft'); var b = h('button', { type: 'button', 'class': 'ed-btn pri' }, '關閉'); b.addEventListener('click', closeDialog); ft.appendChild(b); return; }
      HIST = []; SRCP = {};
      reloadTo(null, msg + '：現在編輯 ' + fmtDate(r.active));
    });
  }
  function edSwitch(d) { edClean(function () { edOp('switch', d, '切換到 ' + fmtDate(d)); }, '換到 ' + fmtDate(d)); }
  function edNew() {
    var bd = dialog('新增文章', '以目前這期的版型當底，內容區清空成一個空分類，大標題換成新的日期',
      '<div class="row"><label for="ed-newdate">日期</label><input type="text" id="ed-newdate" value="' + today() + '" placeholder="例如 2026-11-06"></div>' +
      '<div class="hint">新文章先不會公開，寫好按「發布」才會出現在網站上（並成為首頁的最新一期）。</div>',
      [{ text: '取消' }, { text: '建立', pri: true, fn: function () {
        var d = $('ed-newdate').value.trim();
        if (!/^\d{4}-\d\d-\d\d$/.test(d)) { toast('日期格式要像 2026-11-06', true); return false; }
        setTimeout(function () { edClean(function () { edOp('new', d, '已新增 ' + fmtDate(d)); }, '新增文章'); }, 30);
      } }]);
  }
  function edDelete(e) {
    dialog('刪除 ' + fmtDate(e.date) + ' 這一期？', '「' + e.title + '」',
      '<div class="hint" style="font-size:13.5px;color:#e8dcc2;line-height:2">' +
      (e.published ? '◆ 會從公開網站的歷史回顧拿掉，並馬上推送到 GitHub。<br>' : '◆ 這期還沒發布，只會刪掉草稿。<br>') +
      (e.active ? '◆ 這是你現在正在編的那期，刪掉後會換到剩下最新的一期。<br>' : '') +
      (window.ED_WEB ? '◆ 會從 GitHub 刪除這期的檔案；GitHub 留有歷史紀錄，要救回來跟管理者說一聲。</div>' : '◆ 原始檔和網頁會搬進 site\\backups，不會真的消失；要救回來跟 AI 說一聲。</div>'),
      [{ text: '取消' }, { text: '刪除', pri: true, fn: function () { setTimeout(function () { save().then(function () { edOp('delete', e.date, '已刪除 ' + fmtDate(e.date)); }); }, 30); } }]);
  }
  function editionsDialog() {
    loadEditions().then(function (L) {
      var list = h('div', { 'class': 'list ed-eds' });
      L.editions.forEach(function (e) {
        var row = h('div', { 'class': 'ed-er' + (e.active ? ' on' : '') },
          '<span class="d">' + fmtDate(e.date) + '</span><span class="tt">' + esc(e.title || '（無標題）') +
          (e.active ? '<em>編輯中</em>' : '') + (!e.published ? '<em class="np">未發布</em>' : '') + (e.date === L.latest ? '<em class="lt">首頁</em>' : '') + '</span>');
        var open = h('button', { type: 'button', 'class': 'ed-btn' }, e.active ? '編輯中' : '開啟');
        open.disabled = e.active || !e.editable;
        if (!e.editable) open.title = '太早以前的期數只有成品網頁，沒有原始檔';
        open.addEventListener('click', function () { closeDialog(); setTimeout(function () { edSwitch(e.date); }, 30); });
        var del = h('button', { type: 'button', 'class': 'ed-btn' }, '刪除');
        del.disabled = L.editions.length <= 1;
        del.addEventListener('click', function () { closeDialog(); setTimeout(function () { edDelete(e); }, 30); });
        row.appendChild(open); row.appendChild(del); list.appendChild(row);
      });
      dialog('文章', '一期一篇；開啟就能修改那一期，發布後只更新那一期（最新一期才會換首頁）', list,
        [{ text: '關閉' }, { text: '＋ 新增文章', pri: true, fn: function () { setTimeout(edNew, 30); } }]);
    });
  }

  // ---------- 右鍵選單（排法照演出編輯器） ----------
  function canInsert(el, info, kind) {
    var inItem = !!el.closest('.item'), inSec = !!el.closest('section'), inLead = !!el.closest('.lead');
    if (kind === 'para') return inItem || (inLead && info.level === 'para');
    if (kind === 'media') return inItem;
    if (kind === 'item') return inItem || inSec;
    return inSec || inLead;
  }
  function openMenu(el, x, y) {
    menuTarget = el; select(el);
    var ref = blockRef(el);
    describeRef(ref).then(function (info) { if (menuTarget === el) buildMenu(el, info, x, y); });
  }
  function buildMenu(el, info, x, y) {
    var m = $('ed-menu'), d = describe(el), items = [], blk = info.level !== 'fixed', clip = getClip();
    var key = el.getAttribute('data-i18n'), alt = el.getAttribute('data-i18n-alt'), media = el.getAttribute('data-media');
    var kinds = ['para', 'media', 'item', 'section'].filter(function (k) { return canInsert(el, info, k); });
    items.push({ t: '在下方插入', sub: kinds.map(function (k) { return { t: KIND_NAME[k], fn: function () { insertBelow(el, k); } }; }), off: !kinds.length });
    if (key) items.push({ t: '編輯文字（' + langLabel(lang()) + '）', k: '雙擊 / Enter', fn: function () { startInline(el); } });
    if (media) items.push({ t: el.classList.contains('ph') ? '放入圖片／影片…' : '替換圖片／影片…', k: key ? '' : '雙擊', fn: function () { replaceMedia(el); } });
    items.push(null);
    items.push({ t: '剪下', k: 'Ctrl+X', off: !blk, fn: function () { doCopy(el, info, 'cut'); } });
    items.push({ t: '複製', k: 'Ctrl+C', off: !blk, fn: function () { doCopy(el, info, 'copy'); } });
    items.push({ t: '貼上' + (clip ? '：' + clip.label : ''), k: 'Ctrl+V', off: !clip, fn: function () { doPaste(el); } });
    items.push({ t: '複製且貼上', k: 'Ctrl+D', off: !blk, fn: function () { structOp({ op: 'dup', ref: blockRef(el) }); } });
    items.push({ t: '刪除' + (blk ? KIND_NAME[info.level] : ''), k: 'Del', off: !blk, fn: function () { doDelete(el, info); } });
    items.push(null);
    items.push({ t: '上移', k: 'Alt+↑', off: !info.up, fn: function () { structOp({ op: 'up', ref: blockRef(el) }); } });
    items.push({ t: '下移', k: 'Alt+↓', off: !info.down, fn: function () { structOp({ op: 'down', ref: blockRef(el) }); } });
    items.push(null);
    if (key) items.push({ t: '六種語言一起看…', fn: function () { editAllLangs(key); } });
    if (key) items.push({ t: 'AI 翻譯這段（繁中→其他五種）', fn: function () { aiTranslateOne(key); } });
    if (key && dirtyKeys().indexOf(key) >= 0) items.push({ t: '還原成上次儲存', fn: function () { remember(key); I18N.t[key] = JSON.parse(JSON.stringify(SAVED[key])); refresh(); toast('已還原'); } });
    if (alt) items.push({ t: '編輯替代文字…', fn: function () { editAllLangs(alt); } });
    items.push({ t: '頁面上看不到的文字…', fn: hiddenTexts });
    m.innerHTML = '';
    m.appendChild(h('li', { 'class': 'hd' }, esc(blk ? KIND_NAME[info.level] + '・' + d.name : d.name + '（固定物件，只能改字）') +
      '　<span style="font-family:Consolas,monospace;font-size:10.5px">' + esc(d.key) + '</span>'));
    function addItem(list, it) {
      if (!it) { list.appendChild(h('li', { 'class': 'sep' })); return; }
      var li = h('li', { 'class': 'it' + (it.off ? ' off' : '') + (it.sub ? ' has-sub' : '') }, '<span>' + esc(it.t) + '</span>' + (it.k ? '<kbd>' + esc(it.k) + '</kbd>' : it.sub ? '<kbd>▸</kbd>' : ''));
      if (it.sub && !it.off) {
        var ul = h('ul', { 'class': 'ed-panel sub' });
        it.sub.forEach(function (s) { addItem(ul, s); });
        li.appendChild(ul);
      } else if (!it.off) li.addEventListener('click', function (e) { e.stopPropagation(); closeMenu(); it.fn(); });
      list.appendChild(li);
    }
    items.forEach(function (it) { addItem(m, it); });
    m.classList.add('show');
    var w = m.offsetWidth, hh = m.offsetHeight;
    m.style.left = Math.min(x, innerWidth - w - 8) + 'px'; m.style.top = Math.min(y, innerHeight - hh - 8) + 'px';
    m.classList.toggle('flip', x + w + 200 > innerWidth);  // 右邊放不下子選單 → 往左開
  }
  function closeMenu() { $('ed-menu').classList.remove('show'); menuTarget = null; }

  // 快捷鍵作用在目前選取的物件上
  function keyAction(e) {
    if (!selEl || editing || $('ed-mask').classList.contains('show') || !document.body.contains(selEl)) return false;
    var k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    var textSel = String(getSelection()).length > 0;
    if (k === 'enter' && !ctrl && selEl.getAttribute('data-i18n')) { startInline(selEl); return true; }
    if (ctrl && k === 'v') { doPaste(selEl); return true; }
    var acts = { 'delete': !ctrl && !e.altKey, x: ctrl && !textSel, c: ctrl && !textSel, d: ctrl, arrowup: e.altKey, arrowdown: e.altKey };
    if (!acts[k]) return false;
    var el = selEl;
    describeRef(blockRef(el)).then(function (info) {
      if (info.level === 'fixed') { toast('這是固定物件（大標題、頁首頁尾、附註等），只能改字', true); return; }
      if (k === 'delete') doDelete(el, info);
      else if (k === 'x') doCopy(el, info, 'cut');
      else if (k === 'c') doCopy(el, info, 'copy');
      else if (k === 'd') structOp({ op: 'dup', ref: blockRef(el) });
      else if (k === 'arrowup') { if (info.up) structOp({ op: 'up', ref: blockRef(el) }); else toast('已經是第一個了', true); }
      else if (k === 'arrowdown') { if (info.down) structOp({ op: 'down', ref: blockRef(el) }); else toast('已經是最後一個了', true); }
    });
    return true;
  }

  // ---------- 發布 ----------
  function publish() {
    var d = dirtyKeys();
    var bd = dialog('發布到網站', '會重新產生網頁並推上 GitHub，約 1～10 分鐘後公開網址看得到',
      (d.length ? '<div class="hint" style="color:#f0b060">還有 ' + d.length + ' 處未儲存，發布前會先自動儲存。</div>' : '') +
      '<div class="row"><label for="ed-msg">這次改了什麼</label><input type="text" id="ed-msg" value="手動修改文字"></div>' +
      '<div class="hint">發布的是目前在編的 ' + esc(fmtDate(EDL && EDL.active)) + ' 這一期；它是最新一期才會換掉首頁，舊的期數只更新歷史回顧裡那一篇。</div>',
      [{ text: '取消' }, { text: '發布', pri: true, fn: function () {
        var msg = $('ed-msg').value.trim() || '手動修改文字';
        var out = dialog('發布中…', '大約需要 10～30 秒，請不要關掉編輯器視窗', '<pre>處理中…</pre>', []);
        save().then(function (ok) {
          if (!ok) { out.querySelector('pre').textContent = '儲存失敗，已停止發布。'; addClose(); return; }
          return api('/api/publish', { msg: msg }).then(function (r) {
            $('ed-dlg').querySelector('h4').firstChild.textContent = r.ok ? '發布完成' : '發布失敗';
            out.querySelector('pre').textContent = (r.ok ? '公開網址：https://certainhaaton.github.io/glowstick-update/\n（瀏覽器可能快取最多 10 分鐘，看不到新版就按 F5）\n\n' : '') + (r.log || '').trim().slice(-3000);
            addClose();
          });
        }).catch(function (e) { out.querySelector('pre').textContent = '發布失敗：' + e.message; addClose(); });
        return false;
      } }]);
    function addClose() {
      var ft = $('ed-dlg').querySelector('.ft'); ft.innerHTML = '';
      var b = h('button', { type: 'button', 'class': 'ed-btn pri' }, '關閉'); b.addEventListener('click', closeDialog); ft.appendChild(b);
    }
  }

  // ---------- 說明 ----------
  function help() {
    dialog('怎麼用', '', '<div class="hint" style="font-size:13px;color:#d9cfb9;line-height:2.1">' +
      '◆ 滑鼠移到任何文字、圖片、影片上會亮金框並顯示名稱。<br>' +
      '◆ <b>雙擊</b>文字：直接在頁面上改（改的是右上角目前選的語言）。Enter 完成、Shift+Enter 換行、Esc 取消。<br>' +
      '◆ <b>右鍵</b>：在下方插入（段落／圖片影片／項目／分類）、剪下、複製、貼上、複製且貼上、刪除、上移、下移、六種語言一起看、換圖片／影片、編輯頁面上看不到的文字（分頁標題、下載檔名等）。<br>' +
      '◆ 點一下選取後可直接按快捷鍵：Enter 改字、Del 刪除、Ctrl+X／C／V 剪下複製貼上、Ctrl+D 複製且貼上、Alt+↑↓ 上下移、Ctrl+Z 復原。<br>' +
      '◆ 新插入的文字其他語言是空的，頁面會先顯示繁中；右鍵「六種語言一起看」補翻譯。新插入的圖片位置會顯示「畫面準備中」，右鍵「放入圖片／影片」選檔。<br>' +
      '◆ 改過還沒儲存的地方會有橘色虛線框。按工具列「儲存」或 Ctrl+S 寫入檔案。<br>' +
      '◆ 換圖片／影片是立刻生效，換錯了按 Ctrl+Z 或「復原」換回來。圖片請用 JPG／PNG、影片用 MP4。<br>' +
      '◆ 「捨棄變更」＝整個回到上次發布的樣子（文字、版型、圖片全部），捨棄錯了也能再按「復原」找回來。<br>' +
      '◆ 「AI翻譯」：只改繁中就好，按一下把改過的段落翻成其他五種語言（括號裡是待翻段數）。右鍵「AI 翻譯這段」或六語言視窗裡也有。第一次要貼 Claude API 金鑰，金鑰只存在這台電腦的瀏覽器。<br>' +
      '◆ 右上角語言選單照常可以切換，切到哪個語言就改哪個語言。<br>' +
      '◆ 「發布」＝重新產生網頁並推到公開網址。</div>');
  }

  // ---------- 介面 ----------
  function buildUI() {
    var ui = h('div', { id: 'ed-ui' });
    ui.innerHTML =
      '<div id="ed-hover"><div class="tag"></div></div><div id="ed-sel"></div>' +
      '<ul id="ed-menu" class="ed-panel" role="menu"></ul>' +
      '<div id="ed-bar" class="ed-panel"><button type="button" class="ed-btn ed-ed" id="ed-ed" title="切換、新增、刪除文章（期數）">文章 …</button><span class="st" id="ed-st"></span>' +
      '<button type="button" class="ed-btn" id="ed-hidden">看不到的文字</button>' +
      '<button type="button" class="ed-btn" id="ed-help">怎麼用</button>' +
      (window.ED_WEB ? '' : '<a class="ed-btn" href="/list" title="舊的表格式編輯">列表模式</a>') +
      '<button type="button" class="ed-btn" id="ed-undo" title="Ctrl+Z">復原</button>' +
      '<button type="button" class="ed-btn" id="ed-discard" title="整個回到上次發布的樣子">捨棄變更</button>' +
      '<button type="button" class="ed-btn" id="ed-ai" title="把改過的繁中翻成其他五種語言（Claude API）">AI翻譯</button>' +
      '<button type="button" class="ed-btn" id="ed-save">儲存</button>' +
      '<button type="button" class="ed-btn pri" id="ed-pub">發布…</button></div>' +
      '<div id="ed-mask"><div id="ed-dlg" class="ed-panel" role="dialog" aria-modal="true"></div></div>' +
      '<div id="ed-toast" class="ed-panel"></div>';
    document.body.appendChild(ui); ui.appendChild(fileInput);
    document.body.classList.add('ed-on');
    $('ed-save').addEventListener('click', save);
    $('ed-undo').addEventListener('click', undoAction);
    $('ed-discard').addEventListener('click', discardAll);
    $('ed-ai').addEventListener('click', aiTranslateDialog);
    $('ed-ed').addEventListener('click', editionsDialog);
    $('ed-pub').addEventListener('click', publish);
    $('ed-hidden').addEventListener('click', hiddenTexts);
    $('ed-help').addEventListener('click', help);
    $('ed-mask').addEventListener('mousedown', function (e) { if (e.target === this) closeDialog(); });
    // 網頁版：語言選單下方放「返回」（跟網站上「修改」鈕同位置），回到網站上正在改的這一期；沒存的先存成草稿再走
    if (window.ED_WEB && parent.edBack) {
      var box = document.getElementById('lang'), bk = h('a', { href: '#', 'class': 'hist edit ed-back', title: '回到網站上這一期（沒發布的改動會留在這台電腦的草稿）' });
      bk.textContent = '返回';
      if (box) box.insertBefore(bk, document.getElementById('langMenu'));
      bk.addEventListener('click', function (e) {
        e.preventDefault();
        if (editing) editing.blur();
        save().then(function (ok) { if (!ok) return; window.__edNoWarn = true; parent.edBack(); });
      });
    }
  }

  // ---------- 事件 ----------
  function bind() {
    var raf = 0, lx = 0, ly = 0;
    document.addEventListener('mousemove', function (e) {
      lx = e.clientX; ly = e.clientY; if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; if (!$('ed-menu').classList.contains('show')) showHover(pick(lx, ly)); });
    }, { passive: true });
    // 捲動時滑鼠沒動，底下的物件會換 → 依最後的滑鼠位置重新找
    window.addEventListener('scroll', function () { if (lx || ly) showHover(pick(lx, ly)); place($('ed-sel'), selEl); }, { passive: true });
    window.addEventListener('resize', function () { place($('ed-hover'), hoverEl); place($('ed-sel'), selEl); });

    // 捕獲階段攔截：在頁面上點物件＝選取，不觸發連結／下載／影片暫停
    document.addEventListener('click', function (e) {
      if (e.target.closest('#ed-ui')) return;
      if (!e.target.closest('#ed-menu')) closeMenu();
      if (editing && editing.contains(e.target)) return;
      // 「回到頂端」照常能用：自己捲（網頁版在 iframe 裡，#top 連結會被解析成編輯器網址，不能讓它真的跳）
      if (e.target.closest('.totop')) { e.preventDefault(); e.stopPropagation(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      var el = pick(e.clientX, e.clientY);
      if (el || e.target.closest('a')) { if (!e.target.closest('.lang')) { e.preventDefault(); e.stopPropagation(); } }
      if (el) select(el);
    }, true);
    document.addEventListener('dblclick', function (e) {
      if (e.target.closest('#ed-ui') || editing) return;
      var el = pick(e.clientX, e.clientY); if (!el) return;
      e.preventDefault();
      if (el.getAttribute('data-i18n')) startInline(el);
      else if (el.getAttribute('data-media')) replaceMedia(el);
    }, true);
    document.addEventListener('contextmenu', function (e) {
      if (e.target.closest('#ed-ui') || (editing && editing.contains(e.target))) return;
      var el = pick(e.clientX, e.clientY);
      e.preventDefault();
      if (el) openMenu(el, e.clientX, e.clientY);
      else { closeMenu(); select(null); }
    }, true);
    document.addEventListener('keydown', function (e) {
      var ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (ctrl && k === 's') { e.preventDefault(); if (editing) editing.blur(); save(); }
      else if (e.key === 'Escape') { closeMenu(); closeDialog(); select(null); }
      else if (ctrl && k === 'z' && !editing && !$('ed-mask').classList.contains('show') && !e.target.closest('textarea,input')) { e.preventDefault(); undoAction(); }
      else if (!e.target.closest('textarea,input') && keyAction(e)) e.preventDefault();
    });
    window.addEventListener('beforeunload', function (e) {
      if (!window.__edNoWarn && dirtyKeys().length) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // 標籤名稱：跟列表模式共用 /api/strings 的分組（例「新增時機判定｜內文」）
  api('/api/strings').then(function (r) {
    (r.groups || []).forEach(function (g) { g.items.forEach(function (it) { LABEL[it.key] = it.label; }); });
    SRC = r.src || {}; updateAIBtn();
  }).catch(function () {});
  buildUI(); bind(); refresh(); markCut();
  loadEditions().then(function (L) {
    // 從網站「修改」鈕進來：網址帶 ?edition=日期（或 latest）→ 換到那一期
    var m = /[?&]edition=([\w-]+)/.exec(location.search);
    if (!m) return;
    history.replaceState(null, '', location.pathname);
    var want = m[1] === 'latest' ? L.latest : m[1];
    if (want && want !== L.active) edSwitch(want);
  });

  // 結構動作後重新整理：捲回原位、選取新東西並閃一下、顯示做了什麼
  (function () {
    var a = null; try { a = JSON.parse(sessionStorage.getItem('ed-after') || 'null'); } catch (e) {}
    sessionStorage.removeItem('ed-after');
    if (!a) return;
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';  // 不讓瀏覽器自己捲回舊位置蓋掉我們的
    var el = refEl(a.ref);
    function go() {  // 圖片影片載完版面會變，載入前後各捲一次
      if (a.y) scrollTo(0, a.y);
      if (!el) return;
      var r = el.getBoundingClientRect();
      if (r.top < 80 || r.bottom > innerHeight - 90) el.scrollIntoView({ block: 'center' });
      select(el);
    }
    go();
    if (document.readyState !== 'complete') window.addEventListener('load', go);
    if (el) { el.classList.add('ed-flash'); setTimeout(function () { el.classList.remove('ed-flash'); }, 1600); }
    if (a.msg) toast(a.msg);
  })();
})();
