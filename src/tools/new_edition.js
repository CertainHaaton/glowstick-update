// 開新一期的版型處理（edition_cli.py new 呼叫），跟網頁版編輯器「新增文章」用同一支 structedit.js，兩邊結果一致。
// 用法：node src/tools/new_edition.js <新一期資料夾（已從上一期複製好）> <期數代號，例 2026-11-06 或 2026-11-06-2>
// 會改寫資料夾裡的 template.html、i18n.json、i18n_src.json，並在標準輸出印出還用得到的媒體名稱（JSON 陣列），
// 用不到的圖檔由 edition_cli.py 刪掉。
var fs = require('fs'), path = require('path');
var SE = require('../edit/structedit.js');
var dir = process.argv[2], date = process.argv[3];
function rd(n, dflt) { var f = path.join(dir, n); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : dflt; }
var st = { template: rd('template.html'), i18n: JSON.parse(rd('i18n.json')), i18nSrc: JSON.parse(rd('i18n_src.json', '{}')), media: {} };
var img = path.join(dir, 'img');
if (fs.existsSync(img)) fs.readdirSync(img).forEach(function (f) { st.media[f.replace(/\.[^.]+$/, '')] = { ext: path.extname(f) }; });
SE.newEdition(st, date);
fs.writeFileSync(path.join(dir, 'template.html'), st.template);
fs.writeFileSync(path.join(dir, 'i18n.json'), JSON.stringify(st.i18n, null, 1));
fs.writeFileSync(path.join(dir, 'i18n_src.json'), JSON.stringify(st.i18nSrc, null, 1));
process.stdout.write(JSON.stringify(Object.keys(st.media)));
