// structedit.js 對照測試：同一串操作分別給本機 Python 版（site/structedit.py）與這支 JS 版跑，
// 版型與文字必須逐字相同。用法：node src/tools/test_structedit.js <site 資料夾> <一期的資料夾>
// （編號用固定的計數器，兩邊才比得起來）
var fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
var SE = require('../edit/structedit.js');
var SITE = process.argv[2], ED = process.argv[3];
var OPS = [
  ['insert', 'qte_p', 'para'], ['insert', 'qte_h', 'item'], ['insert', 'sec_info', 'section'], ['insert', 'lead1', 'para'],
  ['up', 'dmg_h'], ['down', 'dmg_h'], ['dup', 'skill_h'], ['paste', 'sec_qol', 'cut', 'hb_h'], ['paste', 'tip_p', 'copy', 'media:stagecon'],
  ['paste', 'auto_p', 'cut', 'win_p'], ['delete', 'media:shopsell'], ['delete', 'tip_h'], ['delete', 'sec_battle'], ['delete', 'lead2'],
  ['insert', 'h1', 'para'], ['delete', 'h1'], ['up', 'sec_battle'], ['paste', 'sec_qol', 'copy', 'media:qte']
];
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'separity_'));
fs.copyFileSync(path.join(ED, 'template.html'), path.join(tmp, 'template.html'));
fs.copyFileSync(path.join(ED, 'i18n.json'), path.join(tmp, 'i18n.json'));
fs.mkdirSync(path.join(tmp, 'img'));
// Python 版
var py = [
  'import sys, json, pathlib, shutil',
  'sys.path.insert(0, ' + JSON.stringify(SITE) + ')',
  'import structedit as se',
  'T = pathlib.Path(' + JSON.stringify(tmp) + ')',
  'se.TEMPLATE, se.I18N, se.IMG, se.BACKUP = T/"template.html", T/"i18n.json", T/"img", T/"backups"',
  'n = [0]',
  'def nid(p):\n    n[0] += 1\n    return p + "%x" % n[0]',
  'se.new_id = nid',
  'out = []',
  'for op in json.loads(sys.argv[1]):',
  '    try:',
  '        r = se.apply(op[0], op[1], op[2] if len(op) > 2 else None, op[3] if len(op) > 3 else None)',
  '        out.append(["ok", r["focus"]])',
  '    except se.StructError as e:',
  '        out.append(["err", str(e)])',
  'print(json.dumps({"res": out, "t": se.TEMPLATE.read_bytes().decode("utf-8"), "d": json.loads(se.I18N.read_text(encoding="utf-8"))}, ensure_ascii=False))'
].join('\n');
fs.writeFileSync(path.join(tmp, 'run.py'), py);
var pyOut = JSON.parse(cp.execFileSync('python', ['-X', 'utf8', path.join(tmp, 'run.py'), JSON.stringify(OPS)], { encoding: 'utf8', maxBuffer: 1 << 26 }));
// JS 版
var n = 0;
SE._setIdGen(function (p) { n++; return p + n.toString(16); });
var st = { template: fs.readFileSync(path.join(ED, 'template.html'), 'utf8'), i18n: JSON.parse(fs.readFileSync(path.join(ED, 'i18n.json'), 'utf8')), media: {} };
fs.readdirSync(path.join(ED, 'img')).forEach(function (f) { st.media[f.replace(/\.[^.]+$/, '')] = { ext: path.extname(f) }; });
var jsRes = OPS.map(function (op) {
  try { var r = SE.apply(st, op[0], op[1], op[2], op[3]); return ['ok', r.focus]; } catch (e) { if (!(e instanceof SE.StructError)) throw e; return ['err', e.message]; }
});
var fails = 0;
function ok(c, m) { console.log((c ? '  OK  ' : '  FAIL ') + m); if (!c) fails++; }
OPS.forEach(function (op, i) { ok(JSON.stringify(pyOut.res[i]) === JSON.stringify(jsRes[i]), op.join(' ') + ' → ' + JSON.stringify(jsRes[i])); });
ok(pyOut.t === st.template, '版型逐字相同（' + st.template.length + ' 字）');
ok(JSON.stringify(pyOut.d) === JSON.stringify(st.i18n), '文字（i18n）完全相同');
if (pyOut.t !== st.template) {
  var a = pyOut.t.split('\n'), b = st.template.split('\n');
  for (var i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { console.log('第 ' + (i + 1) + ' 行不同\n PY: ' + JSON.stringify(a[i]) + '\n JS: ' + JSON.stringify(b[i])); break; }
}
var used = SE.mediaIn(st.template);
ok(used.every(function (n) { return st.media[n]; }) && Object.keys(st.media).every(function (n) { return used.indexOf(n) >= 0 || n === 'banner' || n === 'favicon'; }) && !st.media.shopsell, '媒體表跟版型一致（版型用到的都在、刪掉的都拿掉）：' + Object.keys(st.media).sort().join(','));
// 開新一期
var st2 = { template: fs.readFileSync(path.join(ED, 'template.html'), 'utf8'), i18n: JSON.parse(fs.readFileSync(path.join(ED, 'i18n.json'), 'utf8')), media: { banner: {}, favicon: {}, qte: {} }, i18nSrc: { h1: 'x', lead1: 'y', qte_p: 'z' } };
SE.newEdition(st2, '2026-11-06');
ok((st2.template.match(/<section/g) || []).length === 1 && st2.i18n.t.h1.tw.indexOf('2026.11.06') > 0 && st2.i18n.t.lead1.tw === '以下整理本週的主要更新內容。' && !st2.i18n.t.lead2, '開新一期：一個空分類、大標題換日期、開頭只留一段');
ok(Object.keys(st2.media).sort().join() === 'banner,favicon' && !st2.i18nSrc.h1 && !st2.i18nSrc.qte_p, '開新一期：媒體只留主視覺與圖示、翻譯紀錄清掉');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? '\n失敗 ' + fails + ' 項' : '\n全部通過');
process.exit(fails ? 1 : 0);
