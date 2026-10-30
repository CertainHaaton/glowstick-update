// 網頁編輯器用：把一期（記憶體裡的 st）組成編輯預覽用的網頁。
// 規則跟 src/site/render.py 相同，差別只在：媒體不內嵌（用網址／瀏覽器暫存），並標上 data-media 讓右鍵能換圖。
// 另外附 groups()：每個文字鍵在右鍵選單／AI 翻譯清單顯示的名稱（例「新增時機判定｜內文」），對應本機版 editor_server.py。
(function (root) {
  'use strict';
  var EXT_ORDER = ['.webp', '.jpg', '.png', '.gif', '.mp4', '.webm'];

  // st：{template, i18n, media:{名稱:{ext,...}}}；mediaURL(名稱) → 網址；shared：{css, js}（src/site/ui.css、ui.js）
  function renderLive(st, mediaURL, shared, updated) {
    var html = st.template;
    function has(name) { return st.media[name] && EXT_ORDER.indexOf(st.media[name].ext) >= 0; }
    html = html.split('{{i18n_json}}').join(JSON.stringify(st.i18n));
    html = html.split('{{ui_css}}').join(shared.css).split('{{ui_js}}').join(shared.js);
    html = html.split('{{updated}}').join(updated).split('{{history_href}}').join('../archive/');
    // 主視覺等 {{img:名稱}} 也標上名稱，編輯器才能右鍵換圖
    html = html.replace(/(<img\b[^>]*?)src="\{\{img:(\w+)\}\}"/g, function (m, a, n) { return a + 'data-media="' + n + '" src="{{img:' + n + '}}"'; });
    html = html.replace(/\{\{img:(\w+)\}\}/g, function (m, n) { return has(n) ? mediaURL(n) : ''; });
    html = html.replace(/\{\{media:(\w+)\|([^}]*)\}\}/g, function (m, name, cap) {
      var dm = ' data-media="' + name + '"';
      if (!has(name)) return '<div class="ph"' + dm + '>畫面準備中：' + cap + '</div>';
      var ext = st.media[name].ext, isv = ext === '.mp4' || ext === '.webm', url = mediaURL(name);
      var tag = isv ? '<video src="' + url + '"' + dm + ' autoplay loop muted playsinline controls></video>'
                    : '<img src="' + url + '" alt="' + cap + '"' + dm + ' loading="lazy">';
      var dl = '<a class="dl" href="#" download="閃光雞海賊團_' + cap + ext + '" data-ext="' + ext + '" data-i18n="' + (isv ? 'dl_vid' : 'dl_img') + '">下載' + (isv ? '影片' : '圖片') + '</a>';
      return tag + '<figcaption><span data-i18n="cap_' + name + '">' + cap + '</span>' + dl + '</figcaption>';
    });
    return html;
  }

  var TAG_LABEL = { h1: '大標題', h2: '分類標題', h3: '項目標題', p: '內文', div: '附註', a: '按鈕文字', span: '文字', img: '圖片替代文字' };
  var SHARED_LABEL = {
    title: '瀏覽器分頁標題', fname: '下載檔名前綴（遊戲名）', hero_alt: '主視覺替代文字', team: '署名',
    updated: '「更新：」字樣', hist: '歷史回顧按鈕', dl_img: '下載圖片按鈕', dl_vid: '下載影片按鈕',
    totop: '回到頂端（螢幕閱讀器用）', back_latest: '歷史頁：回到最新一期', latest: '歷史頁：最新標記',
    lead1: '開頭第一段', lead2: '開頭第二段', h1: '大標題', note: '頁尾附註',
    brand: '左上角英文名', hero_en: '主視覺小標（英文）', footer: '頁尾版權'
  };
  function plain(s) { return String(s || '').replace(/<[^>]+>/g, ''); }
  // 依版型出現順序把文字鍵分組：頁首／各分類／頁尾／網站共用（同 editor_server.py 的 groups）
  function groups(template, data) {
    var re = /<section\b|<\/section>|data-i18n(?:-alt|-aria)?="([\w-]+)"|\{\{media:(\w+)\|/g, m, tokens = [];
    while ((m = re.exec(template))) {
      var s0 = m[0];
      if (s0.indexOf('<section') === 0) tokens.push(['sec']);
      else if (s0.indexOf('</section') === 0) tokens.push(['endsec']);
      else if (m[2]) tokens.push(['key', 'cap_' + m[2], '圖說']);
      else {
        var before = template.slice(0, m.index), tags = before.match(/<(\w+)/g), tag = tags ? tags[tags.length - 1].slice(1).toLowerCase() : 'span';
        tokens.push(['key', m[1], TAG_LABEL[tag] || '文字']);
      }
    }
    var out = [], cur = { name: '頁首', items: [] }, seen = {}, inSec = false, item = '';
    tokens.forEach(function (tk) {
      if (tk[0] === 'sec') { if (cur.items.length) out.push(cur); cur = { name: '', items: [] }; inSec = true; }
      else if (tk[0] === 'endsec') { out.push(cur); cur = { name: '頁尾', items: [] }; inSec = false; }
      else if (data[tk[1]] && !seen[tk[1]]) {
        var key = tk[1], lab = tk[2]; seen[key] = 1;
        if (inSec && !cur.name && lab === '分類標題') cur.name = data[key].tw;
        if (lab === '項目標題') item = plain(data[key].tw);
        if (lab === '分類標題') item = '';
        cur.items.push({ key: key, label: SHARED_LABEL[key] || ((inSec && item) ? item + '｜' + lab.replace('項目', '') : lab) });
      }
    });
    if (cur.items.length) out.push(cur);
    var rest = Object.keys(data).filter(function (k) { return !seen[k]; });
    if (rest.length) out.push({ name: '網站共用文字', items: rest.map(function (k) { return { key: k, label: SHARED_LABEL[k] || k }; }) });
    out.forEach(function (g) { if (!g.name) g.name = '分類'; });
    return out;
  }

  root.EdRender = { renderLive: renderLive, groups: groups, EXT_ORDER: EXT_ORDER };
})(this);
