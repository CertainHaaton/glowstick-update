// 網頁編輯器後端（src/edit/backend.js）對真的 GitHub 做整套測試，只動測試分支（預設 editor-test），不碰 main／線上網站。
// 用法：node src/tools/test_backend_e2e.js [分支]
// 金鑰：從這台電腦的 git 認證拿（git credential fill），不寫進任何檔案。
// 在 Node 裡用最小替身補上瀏覽器才有的東西（localStorage、IndexedDB、FileReader、document）。
var fs = require('fs'), path = require('path'), cp = require('child_process'), vm = require('vm');
var BR = process.argv[2] || 'editor-test';
var cred = cp.execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
var TOKEN = /password=(.*)/.exec(cred)[1].trim();

// ---- 瀏覽器替身 ----
var ls = { gp_ghToken: TOKEN };
global.localStorage = { getItem: function (k) { return ls[k] || null; }, setItem: function (k, v) { ls[k] = String(v); }, removeItem: function (k) { delete ls[k]; } };
global.location = { search: '?branch=' + BR, pathname: '/edit/' };
global.history = { replaceState: function () {} };
global.confirm = function () { return true; };
global.window = global;
var chip = { className: '', textContent: '' };
global.document = { getElementById: function () { return chip; } };
global.FileReader = function () {
  var self = this;
  this.readAsDataURL = function (b) { b.arrayBuffer().then(function (ab) { self.result = 'data:x;base64,' + Buffer.from(ab).toString('base64'); self.onload(); }); };
};
var stores = {};
global.indexedDB = { open: function () {
  var req = {};
  var dbo = {
    createObjectStore: function (n) { stores[n] = stores[n] || new Map(); },
    transaction: function (n) {
      var tx = { objectStore: function () {
        var m = stores[n];
        function r(v) { return { result: v }; }
        return { put: function (v, k) { m.set(k, v); return r(k); }, get: function (k) { return r(m.get(k)); }, delete: function (k) { m.delete(k); return r(); }, getAll: function () { return r(Array.from(m.values())); } };
      } };
      setTimeout(function () { tx.oncomplete && tx.oncomplete(); }, 0);
      return tx;
    }
  };
  setTimeout(function () { req.result = dbo; if (!stores.drafts) { req.onupgradeneeded && req.onupgradeneeded(); } req.onsuccess(); }, 0);
  return req;
} };
var ED = path.join(__dirname, '..', 'edit');
['structedit.js', 'render.js', 'backend.js'].forEach(function (f) { vm.runInThisContext(fs.readFileSync(path.join(ED, f), 'utf8'), { filename: f }); });
var B = global.EdBackend;

var fails = 0;
function ok(c, m) { console.log((c ? '  OK  ' : '  FAIL ') + m); if (!c) fails++; }
function api(p, b, method) { return B.edFetch(p, { method: method || (b === undefined ? 'GET' : 'POST'), body: b instanceof Blob ? b : JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
function tree() {
  return fetch('https://api.github.com/repos/CertainHaaton/glowstick-update/git/trees/' + BR + '?recursive=1', { headers: { Authorization: 'Bearer ' + TOKEN }, cache: 'no-store' })
    .then(function (r) { return r.json(); }).then(function (t) { var o = {}; t.tree.forEach(function (x) { o[x.path] = x.sha; }); return o; });
}
function blob(sha) { return fetch('https://api.github.com/repos/CertainHaaton/glowstick-update/git/blobs/' + sha, { headers: { Authorization: 'Bearer ' + TOKEN } }).then(function (r) { return r.json(); }).then(function (d) { return Buffer.from(d.content, 'base64').toString('utf8'); }); }

(async function () {
  var pre = 'src/editions/2026-10-29/';
  await B.checkToken().then(function (r) { ok(r.push, '金鑰有寫入權限'); });
  await B.start('2026-10-29');
  var html = await B.renderHTML();
  ok(/data-media="qte"/.test(html) && /raw\.githubusercontent\.com\/CertainHaaton\/glowstick-update\/[0-9a-f]{40}\/src\/editions\/2026-10-29\/img\/qte\.mp4/.test(html), '組網頁：媒體用 GitHub 檔案網址、標好 data-media');
  var S = await api('/api/strings');
  ok(S.groups.length > 3 && S.groups.some(function (g) { return g.items.some(function (i) { return i.label === '新增時機判定｜內文'; }); }), '/api/strings：分組名稱跟本機版一樣');
  var t0 = B.current().cur.template;
  var r = await api('/api/struct', { op: 'insert', ref: 'qte_h', kind: 'item' });
  ok(r.ok && r.focus && B.current().cur.template !== t0, '插入項目');
  r = await api('/api/undo', {});
  ok(r.ok && B.current().cur.template === t0, '復原插入');
  var tag = '（網頁版測試 ' + Date.now() + '）';
  var lead = B.current().cur.i18n.t.lead1; lead.tw = lead.tw + tag;
  await api('/api/save', { t: { lead1: lead } });
  r = await api('/api/struct', { op: 'insert', ref: 'qte_h', kind: 'item' });
  var newItem = r.focus;
  var png = new Blob([fs.readFileSync(path.join(__dirname, '..', 'editions', '2026-10-29', 'img', 'favicon.png'))]);
  r = await B.edFetch('/api/media?name=stagecon&ext=.png', { method: 'POST', body: png }).then(function (x) { return x.json(); });
  ok(r.ok && r.file === 'stagecon.png', '換圖：jpg 換成 png（先放草稿）');
  var c = await api('/api/changes', {});
  ok(c.template && c.texts >= 2 && c.media.join() === 'stagecon', '改動清單：版型、文字、圖片 ' + JSON.stringify(c));
  r = await api('/api/publish', { msg: '網頁版編輯器測試' });
  ok(r.ok, '發布：' + (r.log || '').split('\n').join(' / '));
  var T = await tree();
  ok(T[pre + 'img/stagecon.png'] && !T[pre + 'img/stagecon.jpg'], 'GitHub 上：stagecon.jpg 換成 stagecon.png');
  var tpl = await blob(T[pre + 'template.html']), i18 = JSON.parse(await blob(T[pre + 'i18n.json']));
  ok(tpl.indexOf('data-i18n="' + newItem + '"') > 0 && i18.t.lead1.tw.indexOf(tag) > 0 && i18.t[newItem], 'GitHub 上：新項目、改過的文字都在');
  ok(JSON.parse(await blob(T[pre + 'edition.json'])).updated, 'GitHub 上：edition.json 有更新時間');
  c = await api('/api/changes', {});
  ok(!c.template && !c.texts && !c.media.length, '發布後：重新讀回、沒有未發布改動');
  // 開新一期 → 發布 → 刪除
  r = await api('/api/editions', { op: 'new', date: '2026-11-06' });
  ok(r.ok && r.active === '2026-11-06' && r.editions.some(function (e) { return e.date === '2026-11-06' && !e.published; }), '新增文章：草稿、尚未發布');
  r = await api('/api/publish', { msg: '測試新的一期' });
  T = await tree();
  ok(r.ok && T['src/editions/2026-11-06/template.html'] && T['src/editions/2026-11-06/img/banner.jpg'] === T[pre + 'img/banner.jpg'], '新的一期發布：檔案在、主視覺直接共用同一個檔（不重傳）');
  r = await api('/api/editions', { op: 'switch', date: '2026-10-29' });
  ok(r.ok && r.active === '2026-10-29', '切回 10/29');
  ok(r.home === '2026-10-29' && r.editions.some(function (e) { return e.date === '2026-11-06' && e.published; }), '發布較新的一期：首頁沒有被搶走，還是 10/29');
  T = await tree();
  ok(JSON.parse(await blob(T['src/site.json'])).home === '2026-10-29', 'site.json 記著首頁是 10/29');
  r = await api('/api/editions', { op: 'home', date: '2026-11-06' });
  T = await tree();
  ok(r.ok && r.home === '2026-11-06' && JSON.parse(await blob(T['src/site.json'])).home === '2026-11-06', '設為首頁：11/06，site.json 跟著改');
  r = await api('/api/editions', { op: 'new', date: '2026-11-07' });
  r = await api('/api/editions', { op: 'home', date: '2026-11-07' });
  ok(!r.ok && /還沒發布/.test(r.error), '還沒發布的不能設為首頁：' + r.error);
  r = await api('/api/editions', { op: 'delete', date: '2026-11-07' });
  r = await api('/api/editions', { op: 'switch', date: '2026-10-29' });
  r = await api('/api/editions', { op: 'delete', date: '2026-11-06' });
  T = await tree();
  ok(r.ok && !Object.keys(T).some(function (p) { return p.indexOf('src/editions/2026-11-06/') === 0; }), '刪除新的一期：GitHub 上那個資料夾不見了');
  ok(r.home === '2026-10-29' && JSON.parse(await blob(T['src/site.json'])).home === '2026-10-29', '刪掉的是首頁那期：site.json 改回剩下的 10/29');
  r = await api('/api/editions', { op: 'delete', date: '2026-10-29' });
  T = await tree();
  ok(!r.ok && T['src/editions/2026-10-29/template.html'], '只剩一期不能刪，GitHub 上也還在：' + r.error);
  // 衝突：別人在我改的時候發布 → 有提示
  var askd = 0; global.confirm = function () { askd++; return false; };
  var E1 = B.current(); E1.base.files = Object.assign({}, E1.base.files, { 'src/editions/2026-10-29/template.html': 'deadbeef' });
  lead = E1.cur.i18n.t.lead1; lead.tw += '!'; await api('/api/save', { t: { lead1: lead } });
  r = await api('/api/publish', { msg: '衝突測試' });
  ok(!r.ok && askd === 1, '有人同時改過：先問、選取消就不發布');
  await api('/api/discard', {});
  console.log(fails ? '\n失敗 ' + fails + ' 項' : '\n全部通過');
  process.exit(fails ? 1 : 0);
})().catch(function (e) { console.error('測試中斷：', e); process.exit(2); });
