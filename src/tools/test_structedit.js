// structedit.js 測試：用一期的真實版型跑一串結構操作，檢查結果。
// 用法：node src/tools/test_structedit.js src/editions/<日期>
var fs = require('fs'), path = require('path');
var SE = require('../edit/structedit.js');
var ED = process.argv[2] || 'src/editions/2026-10-29';
var n = 0, fails = 0;
SE._setIdGen(function (p) { n++; return p + n.toString(16); });
function ok(c, msg) { console.log((c ? '✔ ' : '✘ ') + msg); if (!c) fails++; }
function load() {
  var st = { template: fs.readFileSync(path.join(ED, 'template.html'), 'utf8'), i18n: JSON.parse(fs.readFileSync(path.join(ED, 'i18n.json'), 'utf8')), media: {} };
  fs.readdirSync(path.join(ED, 'img')).forEach(function (f) { st.media[f.replace(/\.[^.]+$/, '')] = { ext: path.extname(f) }; });
  return st;
}
function order(st) {  // 內容區裡的物件順序（文字鍵／media:名稱）
  var s = st.template, a = s.indexOf('<div class="flow"'), seg = s.slice(a, s.indexOf('<div class="note"')), out = [], re = /data-i18n="(\w+)"|\{\{media:(\w+)\|/g, m;
  while ((m = re.exec(seg))) out.push(m[1] || 'media:' + m[2]);
  return out;
}
function err(fn) { try { fn(); return null; } catch (e) { return e.message; } }

var st = load();
SE.flatten(st);
var s0 = st.template;
ok(s0.indexOf('<div class="flow"') > 0 && !/<section\b|class="item"|class="lead"/.test(s0), '舊版型攤平成一個內容區');
ok(SE.flatten({ template: s0 }).template === s0, '攤平兩次結果不變');

var o = order(st), i = o.indexOf('qte_h');
SE.apply(st, 'delete', 'qte_h');
var o2 = order(st);
ok(o2.indexOf('qte_h') < 0 && o2.indexOf('qte_p') >= 0 && o2.indexOf('media:qte') >= 0 && !st.i18n.t.qte_h && st.i18n.t.qte_p, '刪小標題：只刪標題，底下段落和圖片留著');

var r = SE.apply(st, 'insert', 'qte_p', 'item');
ok(order(st)[order(st).indexOf('qte_p') + 1] === r.focus && st.i18n.t[r.focus].tw === '新小標題', '在段落下方插入小標題');

r = SE.apply(st, 'insert', 'media:qte', 'section');
ok(order(st)[order(st).indexOf('media:qte') + 1] === r.focus, '在圖片下方插入分類標題');

var d = SE.describe(st, 'dmg_h');
SE.apply(st, 'up', 'dmg_h');
ok(d.level === 'item' && order(st).indexOf('dmg_h') < order(st).indexOf(r.focus), '小標題可以上移越過分類標題');

SE.apply(st, 'delete', 'media:shopsell');
ok(/class="pair"/.test(st.template) && !st.media.shopsell, '刪並排裡的一張圖，另一張還在並排裡');
SE.apply(st, 'delete', 'media:shopbatch');
ok(!/class="pair"/.test(st.template), '並排裡最後一張也刪掉 → 空的並排外框一起拿掉');

SE.apply(st, 'paste', 'win_p', 'cut', 'sec_info');
o = order(st);
ok(o[o.length - 1] === 'sec_info', '剪下分類標題貼到最後');

r = SE.apply(st, 'dup', 'skill_p');
ok(order(st)[order(st).indexOf('skill_p') + 1] === r.focus && st.i18n.t[r.focus].tw === st.i18n.t.skill_p.tw, '複製且貼上段落');

r = SE.apply(st, 'insert', 'h1', 'para');
ok(order(st)[0] === r.focus, '在大標題上插入 → 放在內容區最前面');
ok(/頁尾/.test(err(function () { SE.apply(st, 'insert', 'footer', 'para'); }) || ''), '頁尾不能插入');
ok(/固定物件/.test(err(function () { SE.apply(st, 'delete', 'h1'); }) || ''), '大標題不能刪');
ok(/自己後面/.test(err(function () { SE.apply(st, 'paste', 'tip_p', 'cut', 'tip_p'); }) || ''), '剪下的東西不能貼到自己後面');

var st2 = load();
SE.newEdition(st2, '2026-11-06-2');
o = order(st2);
ok(o.length === 4 && o[0] === 'lead1' && /^sec_/.test(o[1]), '開新一期：只留第一段開頭＋分類標題＋小標題＋段落');
ok(st2.i18n.t.h1.tw === '開發週報<i>・</i>2026.11.06 #2', '開新一期：大標題帶日期與序號');
ok(Object.keys(st2.media).sort().join() === 'banner,favicon', '開新一期：媒體只留主視覺與圖示');

console.log(fails ? '\n失敗 ' + fails + ' 項' : '\n全部通過');
process.exit(fails ? 1 : 0);
