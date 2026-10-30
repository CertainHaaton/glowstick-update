# 歷史回顧清單頁 archive/index.html（六語言，跟首頁共用語言選擇 gp_lang）。build_site.py 用。
import json


def archive_index(eds, i18n, favicon_tag, ui_css, ui_js):
    labels = {k: i18n["t"][k] for k in ("hist", "back_latest", "latest", "title")}
    return TEMPLATE % (favicon_tag, ui_css, ui_js, json.dumps(eds, ensure_ascii=False),
                       json.dumps(labels, ensure_ascii=False), json.dumps(i18n["langs"], ensure_ascii=False))


TEMPLATE = """<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>閃光雞雞海賊團 | 更新週報</title>
%s
<style>
body{margin:0;background:#f3f2f0;color:#4a4845;font-family:"Noto Sans TC","Microsoft JhengHei","PingFang TC",sans-serif}
main{max-width:760px;margin:0 auto;padding:72px 20px 100px}
.top{display:flex;justify-content:space-between;align-items:center}
.brand{font-family:"Noto Serif TC","PMingLiU",serif;font-size:11px;letter-spacing:1.2em;color:#b9b5ae}
%s
h1{font-family:"Noto Serif TC","PMingLiU",serif;font-size:30px;color:#2b2a28;letter-spacing:.14em;margin:28px 0 8px}
a.hist.back{margin-left:0}
a.hist.back::before{content:"‹";font-size:14px;line-height:1;color:#e8d6aa}
a.hist.back::after{content:none}
.list{margin-top:30px;border-top:1px solid #d9d6d0}
a.row{display:flex;align-items:center;gap:22px;padding:18px 6px;border-bottom:1px solid #d9d6d0;text-decoration:none;color:#2b2a28}
a.row:hover{background:rgba(255,255,255,.6)}
.d{font-size:13px;color:#8d8a85;letter-spacing:.06em;flex:none;width:92px}
.t{font-family:"Noto Serif TC","PMingLiU",serif;font-size:18px;letter-spacing:.06em}
.new{margin-left:auto;font-size:11px;color:#e8d6aa;background:#1d1a17;padding:1px 10px;letter-spacing:.12em;flex:none;font-family:"Noto Serif TC","PMingLiU",serif}
</style></head><body><main>
<div class="top"><div class="brand">GLOWSTICK PIRATES</div><div class="lang" id="lang"><button type="button" class="lang-btn" id="langBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Language"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.6-4-9s1.4-6.5 4-9z"/></svg><span id="langCur"></span><svg class="caret" viewBox="0 0 10 10"><path d="M1.5 3.5L5 7l3.5-3.5"/></svg></button><ul class="lang-menu" id="langMenu" role="listbox"></ul></div></div>
<h1 id="h"></h1>
<a class="hist back" href="../" id="back"></a>
<div class="list" id="list"></div>
</main>
<script>
%s
</script>
<script>
var EDS = %s, LBL = %s, LANGS = %s, KEY = 'gp_lang';
function detect(){var a=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||'en'];for(var i=0;i<a.length;i++){var l=(a[i]||'').toLowerCase();if(/^zh-(tw|hk|mo)|^zh-hant/.test(l))return'tw';if(/^zh/.test(l))return'cn';if(/^ja/.test(l))return'ja';if(/^ko/.test(l))return'ko';if(/^(ru|uk|be|kk)/.test(l))return'ru';if(/^en/.test(l))return'en';}return'en';}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function render(lang){
  document.title=LBL.title[lang]; document.getElementById('h').textContent=LBL.hist[lang]; document.getElementById('back').textContent=LBL.back_latest[lang].replace(/^‹ */,"");
  document.getElementById('list').innerHTML=EDS.map(function(e,i){return '<a class="row" href="'+e.file+'"><span class="d">'+e.date.replace(/-/g,'.')+'</span><span class="t">'+esc(e.title[lang]||e.title.tw)+'</span>'+(i===0?'<span class="new">'+LBL.latest[lang]+'</span>':'')+'</a>';}).join('');
  var m=LANGS.filter(function(x){return x.code===lang;})[0]; document.documentElement.lang=m?m.html:lang; setLangMenu(lang, m?m.label:lang);
}
initLangMenu(LANGS,function(c){try{localStorage.setItem(KEY,c);}catch(e){}render(c);});
var saved=null; try{saved=localStorage.getItem(KEY);}catch(e){}
render(saved&&LBL.title[saved]?saved:detect());
</script></body></html>
"""
