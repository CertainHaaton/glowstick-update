// 網頁編輯器的「後端」：在瀏覽器裡模擬本機編輯器的 /api/…，資料直接讀寫 GitHub。
//   讀：GitHub API（用使用者自己的 GitHub 金鑰，只有儲存庫協作者存得進去）
//   草稿：每一期各自存在這台瀏覽器的 IndexedDB（關掉網頁也不會不見；別人看不到）
//   發布：把這一期改過的檔案一次 commit 到 GitHub → GitHub Actions 重產網站（約 1～2 分鐘）
// 編輯畫面（live.js）跑在 iframe 裡，它的 fetch('/api/…') 由這支接手（edFetch）。
(function () {
  'use strict';
  var OWNER = 'CertainHaaton', REPO = 'glowstick-update';
  var BRANCH = (/[?&]branch=([\w.\/-]+)/.exec(location.search) || [])[1] || 'main';  // 測試用 ?branch=xxx
  var API = 'https://api.github.com/repos/' + OWNER + '/' + REPO;
  // 期數代號＝日期；同一天第二篇起加 -2、-3…（例 2026-10-30-2），排序時同一天依序號
  var TOKEN_KEY = 'gp_ghToken', DATE_RE = /^\d{4}-\d\d-\d\d(-([2-9]|[1-9]\d))?$/;
  function edKey(d) { var m = /^(.{10})(?:-(\d+))?$/.exec(d) || [d, d]; return m[1] + '-' + ('00' + (m[2] || 1)).slice(-3); }
  function newestFirst(a, b) { a = edKey(a); b = edKey(b); return a < b ? 1 : a > b ? -1 : 0; }
  var MIME = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
  var SE = window.StructEdit;

  var head = null;        // {commit, tree, entries:{path:{sha,mode}}}
  var shared = null;      // {css, js}
  var E = null;           // 目前這一期：{date, isNew, baseCommit, base:{...}, cur:{...}, undo:[]}
  var blobURLs = {};      // IndexedDB 裡的媒體 → 預覽網址
  var titleCache = {};

  // ---------- 小工具 ----------
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function gh(path, opt) {
    opt = opt || {};
    var h = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token()) h['Authorization'] = 'Bearer ' + token();  // 沒金鑰時只能讀（公開儲存庫）
    if (opt.body) h['Content-Type'] = 'application/json';
    return fetch(path.indexOf('http') === 0 ? path : API + path, { method: opt.method || 'GET', headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined, cache: 'no-store' })
      .then(function (r) {
        return r.text().then(function (t) {
          var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) {}
          if (!r.ok) { var err = new Error((d && d.message) || ('GitHub 回應 ' + r.status)); err.status = r.status; throw err; }
          return d;
        });
      });
  }
  function b64ToText(b64) { var bin = atob(b64.replace(/\s/g, '')), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder().decode(u); }
  function textToB64(s) { var u = new TextEncoder().encode(s), bin = ''; for (var i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(bin); }
  function blobToB64(blob) { return new Promise(function (ok, ng) { var fr = new FileReader(); fr.onload = function () { ok(String(fr.result).split(',')[1]); }; fr.onerror = ng; fr.readAsDataURL(blob); }); }
  function readBlobText(sha) { return gh('/git/blobs/' + sha).then(function (d) { return b64ToText(d.content); }); }
  function edPath(date) { return 'src/editions/' + date + '/'; }
  function nowStr() { var t = new Date(), p = function (n) { return ('0' + n).slice(-2); }; return t.getFullYear() + '.' + p(t.getMonth() + 1) + '.' + p(t.getDate()) + ' ' + p(t.getHours()) + ':' + p(t.getMinutes()); }

  // ---------- IndexedDB：草稿與媒體 ----------
  var dbP = null;
  function db() {
    if (!dbP) dbP = new Promise(function (ok, ng) {
      var r = indexedDB.open('gp-editor', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('drafts'); r.result.createObjectStore('blobs'); };
      r.onsuccess = function () { ok(r.result); }; r.onerror = function () { ng(r.error); };
    });
    return dbP;
  }
  function idb(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (ok, ng) {
        var tx = d.transaction(store, mode), st = tx.objectStore(store), req = fn(st);
        tx.oncomplete = function () { ok(req && req.result); }; tx.onerror = function () { ng(tx.error); };
      });
    });
  }
  function draftKey(date) { return OWNER + '/' + REPO + '@' + BRANCH + ':' + date; }
  function saveDraft() { if (!E) return Promise.resolve(); var o = { date: E.date, isNew: E.isNew, baseCommit: E.baseCommit, base: E.base, cur: E.cur, undo: E.undo.slice(-40) }; return idb('drafts', 'readwrite', function (s) { return s.put(o, draftKey(E.date)); }); }
  function loadDraft(date) { return idb('drafts', 'readonly', function (s) { return s.get(draftKey(date)); }); }
  function dropDraft(date) { return idb('drafts', 'readwrite', function (s) { return s.delete(draftKey(date)); }); }
  function allDrafts() {
    return idb('drafts', 'readonly', function (s) { return s.getAll(); }).then(function (all) {
      var pre = OWNER + '/' + REPO + '@' + BRANCH + ':';
      return (all || []).filter(function (d) { return d && d.date; }).filter(function (d) { return true; }).map(function (d) { return d; }).filter(function (d) { return d && draftKey(d.date).indexOf(pre) === 0; });
    });
  }
  function putBlob(blob) { var k = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); return idb('blobs', 'readwrite', function (s) { return s.put(blob, k); }).then(function () { return k; }); }
  function getBlob(k) { return idb('blobs', 'readonly', function (s) { return s.get(k); }); }

  // ---------- 讀 GitHub ----------
  // 讀「最新版本＋檔案清單」：分支資訊和檔案清單同時抓（各約 0.4 秒，同時抓只等一次）；
  // 萬一剛好有人在這一瞬間推送、兩者對不上，就退回一步一步抓的舊做法。
  function loadHead() {
    return Promise.all([gh('/branches/' + BRANCH), gh('/git/trees/' + BRANCH + '?recursive=1')]).then(function (r) {
      var commit = r[0].commit.sha, treeSha = r[0].commit.commit.tree.sha, t = r[1];
      // 用分支名稱抓檔案清單時，GitHub 回的 sha 是「當下那個版本（commit）」，對得上分支資訊才代表兩邊是同一版
      if ((t.sha !== commit && t.sha !== treeSha) || t.truncated) return loadHeadSlow();
      var entries = {};
      (t.tree || []).forEach(function (x) { if (x.type === 'blob') entries[x.path] = { sha: x.sha, mode: x.mode }; });
      head = { commit: commit, tree: treeSha, entries: entries };
      return head;
    }).catch(function (e) { if (e.status === 401 || e.status === 403) throw e; return loadHeadSlow(); });
  }
  function loadHeadSlow() {
    return gh('/git/ref/heads/' + BRANCH).then(function (ref) {
      var commit = ref.object.sha;
      return gh('/git/commits/' + commit).then(function (c) {
        return gh('/git/trees/' + c.tree.sha + '?recursive=1').then(function (t) {
          var entries = {};
          (t.tree || []).forEach(function (x) { if (x.type === 'blob') entries[x.path] = { sha: x.sha, mode: x.mode }; });
          head = { commit: commit, tree: c.tree.sha, entries: entries };
          return head;
        });
      });
    });
  }
  function publishedDates() {
    var ds = {};
    Object.keys(head.entries).forEach(function (p) { var m = /^src\/editions\/([\d-]+)\/template\.html$/.exec(p); if (m && DATE_RE.test(m[1])) ds[m[1]] = 1; });
    return Object.keys(ds).sort(newestFirst);
  }
  function loadShared() {
    if (shared) return Promise.resolve(shared);
    return Promise.all(['src/site/ui.css', 'src/site/ui.js'].map(function (p) { return readBlobText(head.entries[p].sha); }))
      .then(function (r) { shared = { css: r[0], js: r[1] }; return shared; });
  }
  // 從 GitHub 讀一期：回傳 {template, i18n, i18nSrc, meta, media:{名稱:{ext, sha, path}}}
  function readEdition(date) {
    var pre = edPath(date), files = {};
    Object.keys(head.entries).forEach(function (p) { if (p.indexOf(pre) === 0) files[p.slice(pre.length)] = head.entries[p]; });
    if (!files['template.html']) return Promise.reject(new Error('GitHub 上沒有 ' + date + ' 這一期'));
    function txt(n, dflt) { return files[n] ? readBlobText(files[n].sha) : Promise.resolve(dflt); }
    return Promise.all([txt('template.html'), txt('i18n.json'), txt('i18n_src.json', '{}'), txt('edition.json', '{}')]).then(function (r) {
      var media = {};
      Object.keys(files).forEach(function (f) {
        var m = /^img\/(\w+)(\.\w+)$/.exec(f);
        if (m && MIME[m[2]]) media[m[1]] = { ext: m[2], sha: files[f].sha, path: pre + f };
      });
      return { template: r[0], i18n: JSON.parse(r[1]), i18nSrc: JSON.parse(r[2] || '{}'), meta: JSON.parse(r[3] || '{}'), media: media };
    });
  }
  function edFiles(date) {  // 目前 GitHub 上這一期每個檔的 sha（判斷有沒有人在我改的時候也改了）
    var pre = edPath(date), o = {};
    Object.keys(head.entries).forEach(function (p) { if (p.indexOf(pre) === 0) o[p] = head.entries[p].sha; });
    return o;
  }

  // ---------- 開一期 ----------
  function openEdition(date) {
    return loadDraft(date).then(function (dr) {
      if (dr) { E = { date: date, isNew: dr.isNew, baseCommit: dr.baseCommit, base: dr.base, cur: dr.cur, undo: dr.undo || [] }; return E; }
      return readEdition(date).then(function (ed) {
        E = { date: date, isNew: false, baseCommit: head.commit, base: ed, cur: clone(ed), undo: [], baseFiles: edFiles(date) };
        E.base.files = edFiles(date);
        return E;
      });
    });
  }
  function mediaURL(name) {
    var m = E.cur.media[name]; if (!m) return '';
    if (m.blobKey) return blobURLs[m.blobKey] || '';
    return 'https://raw.githubusercontent.com/' + OWNER + '/' + REPO + '/' + (E.baseCommit || head.commit) + '/' + m.path;
  }
  function prepareBlobs() {  // 草稿裡的新圖 → 預覽網址
    var ks = Object.keys(E.cur.media).map(function (n) { return E.cur.media[n].blobKey; }).filter(function (k) { return k && !blobURLs[k]; });
    return Promise.all(ks.map(function (k) { return getBlob(k).then(function (b) { if (b) blobURLs[k] = URL.createObjectURL(b); }); }));
  }
  function renderHTML() {
    return prepareBlobs().then(function () {
      SE.flatten(E.cur);  // 舊版型（項目／分類一層包一層）的草稿或復原點 → 攤平成一行一個物件；已是新版型就不動
      return EdRender.renderLive(E.cur, mediaURL, shared, (E.cur.meta && E.cur.meta.updated) || nowStr());
    });
  }

  // ---------- 比較／復原 ----------
  function snapshot(label) { E.undo.push({ label: label, cur: clone(E.cur) }); }
  function changes() {
    var a = E.cur, b = E.base, texts = 0;
    var ks = {}; Object.keys(a.i18n.t).concat(Object.keys(b.i18n.t)).forEach(function (k) { ks[k] = 1; });
    Object.keys(ks).forEach(function (k) { if (JSON.stringify(a.i18n.t[k]) !== JSON.stringify(b.i18n.t[k])) texts++; });
    var ms = {}; Object.keys(a.media).concat(Object.keys(b.media)).forEach(function (n) { ms[n] = 1; });
    var media = Object.keys(ms).filter(function (n) {
      var x = a.media[n], y = b.media[n];
      return !x || !y || x.ext !== y.ext || x.sha !== y.sha || !!x.blobKey || x.path !== y.path;
    }).sort();
    return { template: a.template !== b.template || !!E.isNew, texts: texts, media: media };
  }

  // ---------- 發布：這一期改過的檔一次 commit ----------
  function commitFiles(entries, message) {
    return loadHead().then(function () {
      return gh('/git/trees', { method: 'POST', body: { base_tree: head.tree, tree: entries } });
    }).then(function (tree) {
      return gh('/git/commits', { method: 'POST', body: { message: message, tree: tree.sha, parents: [head.commit] } });
    }).then(function (c) {
      return gh('/git/refs/heads/' + BRANCH, { method: 'PATCH', body: { sha: c.sha, force: false } }).then(function () { return c.sha; });
    });
  }
  function conflictCheck() {  // 我開始改之後，GitHub 上這一期有沒有被別人改過
    if (E.isNew) return publishedDates().indexOf(E.date) >= 0 ? '已經有人發布了 ' + E.date + ' 這一期' : null;
    var now = edFiles(E.date), was = E.base.files || {};
    var diff = Object.keys(now).concat(Object.keys(was)).some(function (p) { return now[p] !== was[p]; });
    return diff ? '這一期在你開始修改後，已經被別人發布過新版本' : null;
  }
  function publish(msg) {
    var log = [];
    return saveDraft().then(loadHead).then(function () {
      var c = conflictCheck();
      if (c && !window.confirm(c + '。\n\n仍要用你的版本蓋過去嗎？（按「取消」就先不發布）')) throw new Error(c + '，已取消發布');
      var pre = edPath(E.date), cur = E.cur, entries = [];
      cur.meta = Object.assign({}, cur.meta || {}, { updated: nowStr(), draft: false });
      entries.push({ path: pre + 'template.html', mode: '100644', type: 'blob', content: cur.template });
      entries.push({ path: pre + 'i18n.json', mode: '100644', type: 'blob', content: JSON.stringify(cur.i18n, null, 1) });
      entries.push({ path: pre + 'i18n_src.json', mode: '100644', type: 'blob', content: JSON.stringify(cur.i18nSrc || {}, null, 1) });
      entries.push({ path: pre + 'edition.json', mode: '100644', type: 'blob', content: JSON.stringify(cur.meta, null, 1) });
      var keep = {}, uploads = [];
      Object.keys(cur.media).forEach(function (n) {
        var m = cur.media[n], path = pre + 'img/' + n + m.ext; keep[path] = 1;
        if (m.blobKey) uploads.push(getBlob(m.blobKey).then(blobToB64).then(function (b64) {
          log.push('上傳 ' + n + m.ext);
          return gh('/git/blobs', { method: 'POST', body: { content: b64, encoding: 'base64' } }).then(function (r) { entries.push({ path: path, mode: '100644', type: 'blob', sha: r.sha }); });
        }));
        else if (m.sha && m.path !== path) entries.push({ path: path, mode: '100644', type: 'blob', sha: m.sha });  // 複製出來的同一個檔
      });
      Object.keys(head.entries).forEach(function (p) { if (p.indexOf(pre + 'img/') === 0 && !keep[p]) entries.push({ path: p, mode: '100644', type: 'blob', sha: null }); });
      return Promise.all(uploads).then(function () {
        return commitFiles(entries, (msg || '修改內容') + '（' + E.date + '）');
      }).catch(function (e) {
        if (e.status === 422) return commitFiles(entries, (msg || '修改內容') + '（' + E.date + '）');  // 剛好有人同時推送 → 重試一次
        throw e;
      });
    }).then(function (sha) {
      log.push('已存到 GitHub（' + sha.slice(0, 7) + '）');
      return cleanupAfterPublish().then(function () {
        watchBuild(sha);
        log.push('GitHub 正在重新產生網站，約 1～2 分鐘後網址上就是新版（左上角會顯示進度）。');
        return { ok: true, log: log.join('\n') };
      });
    });
  }
  function cleanupAfterPublish() {
    var date = E.date;
    return dropDraft(date).then(loadHead).then(function () { titleCache = {}; return openEdition(date); });
  }
  function watchBuild(sha) {
    var chip = document.getElementById('ed-build'), t0 = Date.now();
    chip.className = 'show'; chip.textContent = '網站更新中…';
    (function poll() {
      gh('/actions/runs?head_sha=' + sha).then(function (r) {
        var run = (r.workflow_runs || [])[0];
        if (run && run.status === 'completed') {
          chip.textContent = run.conclusion === 'success' ? '網站已更新 ✓（按 F5 看新版）' : '網站產生失敗，請通知管理者';
          chip.className = 'show ' + (run.conclusion === 'success' ? 'ok' : 'err');
          setTimeout(function () { chip.className = ''; }, 15000);
          return;
        }
        chip.textContent = '網站更新中…（' + Math.round((Date.now() - t0) / 1000) + ' 秒）';
        if (Date.now() - t0 < 600000) setTimeout(poll, 8000);
      }).catch(function () { setTimeout(poll, 15000); });
    })();
  }

  // ---------- 期數 ----------
  function editionTitle(date) {
    if (E && date === E.date) return Promise.resolve(String(E.cur.i18n.t.h1 && E.cur.i18n.t.h1.tw || '').replace(/<[^>]+>/g, ''));
    if (titleCache[date] != null) return Promise.resolve(titleCache[date]);
    var p = head.entries[edPath(date) + 'i18n.json'];
    if (!p) return Promise.resolve('');
    return readBlobText(p.sha).then(function (t) { var d = JSON.parse(t); return (titleCache[date] = String(d.t.h1 && d.t.h1.tw || '').replace(/<[^>]+>/g, '')); });
  }
  function listing() {
    return allDrafts().then(function (drs) {
      var pub = publishedDates(), ds = {};
      pub.forEach(function (d) { ds[d] = 1; });
      drs.forEach(function (d) { if (d.isNew) ds[d.date] = 1; });
      var dates = Object.keys(ds).sort(newestFirst);
      return Promise.all(dates.map(function (d) {
        var dr = drs.filter(function (x) { return x.date === d; })[0];
        return (dr && dr.isNew ? Promise.resolve(String(dr.cur.i18n.t.h1 && dr.cur.i18n.t.h1.tw || '').replace(/<[^>]+>/g, '')) : editionTitle(d)).then(function (t) {
          return { date: d, title: t, published: pub.indexOf(d) >= 0, active: E && d === E.date, editable: true, draft: !!dr };
        });
      })).then(function (eds) { return { active: E && E.date, latest: pub[0] || null, editions: eds }; });
    });
  }
  function switchTo(date) {
    return saveDraft().then(function () {
      if (date === 'latest') date = publishedDates()[0];
      return openEdition(date);
    });
  }
  function newEdition(date) {
    date = date || new Date().toISOString().slice(0, 10);
    if (!DATE_RE.test(date)) return Promise.reject(new Error('日期格式要像 2026-11-06（同一天第二篇：2026-11-06-2）'));
    return saveDraft().then(allDrafts).then(function (drs) {
      if (publishedDates().indexOf(date) >= 0 || drs.some(function (d) { return d.date === date; })) throw new Error('已經有 ' + date + ' 這一期了');
      var st = clone(E.cur);
      SE.newEdition(st, date);
      st.meta = { updated: date.slice(0, 10).replace(/-/g, '.'), draft: false };
      E = { date: date, isNew: true, baseCommit: head.commit, base: clone(st), cur: st, undo: [] };
      E.base.files = {};
      return saveDraft();
    });
  }
  function deleteEdition(date) {
    var pub = publishedDates();
    return allDrafts().then(function (drs) {
      var total = pub.length + drs.filter(function (d) { return d.isNew && pub.indexOf(d.date) < 0; }).length;
      if (total <= 1) throw new Error('只剩這一期，不能刪');
      var p = Promise.resolve();
      if (pub.indexOf(date) >= 0) {
        if (pub.length <= 1) throw new Error('這是唯一公開的一期，不能刪');
        var pre = edPath(date), entries = Object.keys(head.entries).filter(function (x) { return x.indexOf(pre) === 0; })
          .map(function (x) { return { path: x, mode: '100644', type: 'blob', sha: null }; });
        p = commitFiles(entries, '刪除 ' + date + ' 這一期').then(function (sha) { watchBuild(sha); });
      }
      return p.then(function () { return dropDraft(date); }).then(loadHead).then(function () {
        if (E && E.date === date) { E = null; return openEdition(publishedDates()[0]); }
      });
    });
  }

  // ---------- /api/… 模擬 ----------
  function json(o, status) { return new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }); }
  function body(opt) { try { return JSON.parse((opt && opt.body) || '{}'); } catch (e) { return {}; } }
  var routes = {
    'GET /api/strings': function () {
      return { langs: E.cur.i18n.langs, t: E.cur.i18n.t, groups: EdRender.groups(E.cur.template, E.cur.i18n.t), src: E.cur.i18nSrc || {} };
    },
    'POST /api/save': function (b) {
      var t = b.t || {}, src = b.src || {};
      Object.keys(t).forEach(function (k) { if (E.cur.i18n.t[k]) Object.keys(E.cur.i18n.t[k]).forEach(function (l) { if (typeof t[k][l] === 'string') E.cur.i18n.t[k][l] = t[k][l]; }); });
      E.cur.i18nSrc = E.cur.i18nSrc || {};
      Object.keys(src).forEach(function (k) { if (typeof src[k] === 'string') E.cur.i18nSrc[k] = src[k]; });
      return saveDraft().then(function () { return { ok: true }; });
    },
    'POST /api/struct': function (b) {
      var before = clone(E.cur);
      try {
        var r = SE.apply(E.cur, b.op, b.ref, b.kind, b.src);
        E.undo.push({ label: r.label, cur: before });
        return saveDraft().then(function () { return { ok: true, label: r.label, focus: r.focus }; });
      } catch (e) { E.cur = before; if (e instanceof SE.StructError) return { ok: false, error: e.message }; throw e; }
    },
    'POST /api/describe': function (b) {
      try { return Object.assign({ ok: true }, SE.describe(E.cur, b.ref)); } catch (e) { return { ok: false, error: e.message }; }
    },
    'POST /api/undo': function () {
      var s = E.undo.pop();
      if (!s) return { ok: false, error: '沒有可以復原的動作了' };
      E.cur = s.cur;
      return saveDraft().then(function () { return { ok: true, label: s.label }; });
    },
    'POST /api/changes': function () { return Object.assign({ ok: true }, changes()); },
    'POST /api/discard': function () {
      var c = changes();
      if (!c.template && !c.texts && !c.media.length) return { ok: false, error: '跟上次發布一模一樣，沒有東西可以捨棄' };
      snapshot('捨棄全部變更');
      E.cur = clone(E.base); delete E.cur.files;
      return saveDraft().then(function () { return { ok: true, label: '捨棄全部變更' }; });
    },
    'POST /api/publish': function (b) { return publish(b.msg).catch(function (e) { return { ok: false, log: '發布失敗：' + e.message }; }); },
    'GET /api/editions': function () { return listing().then(function (L) { return Object.assign({ ok: true }, L); }); },
    'POST /api/editions': function (b) {
      var p = b.op === 'switch' ? switchTo(b.date) : b.op === 'new' ? newEdition(b.date) : b.op === 'delete' ? deleteEdition(b.date) : Promise.reject(new Error('不認得的操作'));
      return p.then(listing).then(function (L) { history.replaceState(null, '', location.pathname + (BRANCH !== 'main' ? '?branch=' + BRANCH : '')); return Object.assign({ ok: true }, L); })
        .catch(function (e) { return { ok: false, error: e.message }; });
    }
  };
  function edFetch(url, opt) {
    var u = String(url), path = u.replace(/^https?:\/\/[^/]+/, '').split('?')[0], method = ((opt && opt.method) || 'GET').toUpperCase();
    if (path.indexOf('/api/') !== 0) return fetch(url, opt);
    if (path === '/api/media' && method === 'POST') {  // 換圖：檔案先放草稿，發布時才上傳
      var q = new URLSearchParams(u.split('?')[1] || ''), name = q.get('name'), ext = (q.get('ext') || '').toLowerCase();
      if (!/^\w+$/.test(name) || !MIME[ext]) return Promise.resolve(json({ ok: false, error: '只收 JPG／PNG／WEBP／GIF 圖片或 MP4／WEBM 影片' }));
      return putBlob(opt.body).then(function (k) {
        snapshot('替換圖片／影片「' + name + '」');
        E.cur.media[name] = { ext: ext, blobKey: k };
        blobURLs[k] = URL.createObjectURL(opt.body);
        return saveDraft().then(function () { return json({ ok: true, file: name + ext, url: blobURLs[k] }); });
      });
    }
    var fn = routes[method + ' ' + path];
    if (!fn) return Promise.resolve(json({ ok: false, error: '網頁版不支援 ' + path }, 404));
    return Promise.resolve().then(function () { return fn(body(opt)); }).then(function (o) { return json(o); })
      .catch(function (e) { return json({ ok: false, error: e.message, log: e.message }); });
  }

  // ---------- 對外 ----------
  window.EdBackend = {
    BRANCH: BRANCH, OWNER: OWNER, REPO: REPO, TOKEN_KEY: TOKEN_KEY,
    checkToken: function () {
      return gh('').then(function (r) { return { push: !!(r.permissions && r.permissions.push) }; });
    },
    start: function (want) {
      return loadHead().then(function () {
        var pub = publishedDates();
        if (!pub.length) throw new Error('GitHub 上找不到任何一期（src/editions/）');
        var d = want && want !== 'latest' ? want : pub[0];
        // 共用檔（ui.css／ui.js）跟這一期的檔案同時抓
        return Promise.all([loadShared(), allDrafts().then(function (drs) {
          if (pub.indexOf(d) < 0 && !drs.some(function (x) { return x.date === d; })) d = pub[0];
          return openEdition(d);
        })]);
      });
    },
    renderHTML: renderHTML,
    edFetch: edFetch,
    mediaURL: function (n) { return mediaURL(n); },
    current: function () { return E; },
    // 「返回」要去的網站頁（相對 edit/）：最新一期＝首頁、其他已發布的＝archive/<日期>.html、還沒發布的新期數＝首頁
    siteURL: function () {
      var pub = head ? publishedDates() : [], i = E ? pub.indexOf(E.date) : -1;
      return i > 0 ? '../archive/' + E.date + '.html' : '../';
    }
  };
})();
