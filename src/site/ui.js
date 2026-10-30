// ===== 共用元件：自製語言下拉選單＋回到頂端（首頁與 archive 清單頁共用，build.py／publish.py 內嵌） =====
// 用法：initLangMenu(langs, current, onPick)；langs＝[{code,label}]，onPick(code) 由頁面負責套用與存 localStorage。
//       setLangMenu(code) 更新按鈕文字與選中標記。
function initLangMenu(langs, onPick) {
  var box = document.getElementById('lang'), btn = document.getElementById('langBtn'), menu = document.getElementById('langMenu');
  langs.forEach(function (x) {
    var li = document.createElement('li');
    li.textContent = x.label; li.setAttribute('data-code', x.code); li.setAttribute('role', 'option'); li.tabIndex = -1;
    li.addEventListener('click', function () { close(); onPick(x.code); });
    li.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.click(); }
      if (e.key === 'ArrowDown' && li.nextSibling) { e.preventDefault(); li.nextSibling.focus(); }
      if (e.key === 'ArrowUp' && li.previousSibling) { e.preventDefault(); li.previousSibling.focus(); }
    });
    menu.appendChild(li);
  });
  function open() { box.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); var on = menu.querySelector('.on') || menu.firstChild; if (on) on.focus(); }
  function close() { box.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
  btn.addEventListener('click', function (e) { e.stopPropagation(); box.classList.contains('open') ? close() : open(); });
  document.addEventListener('click', function (e) { if (!box.contains(e.target)) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { close(); btn.focus(); } });
}
function setLangMenu(code, label) {
  document.getElementById('langCur').textContent = label;
  [].forEach.call(document.querySelectorAll('#langMenu li'), function (li) {
    var on = li.getAttribute('data-code') === code; li.classList.toggle('on', on); li.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}
(function () {
  var t = document.querySelector('.totop'); if (!t) return;
  function upd() { t.classList.toggle('show', window.scrollY > 500); }
  window.addEventListener('scroll', upd, { passive: true }); upd();
})();
// ===== 「修改」鈕（只給可以改網站的人） =====
// 網址加 ?editor=on 開一次 → 這個瀏覽器記住並在語言選單下方顯示「修改」；?editor=off 關掉。一般訪客看不到。
// 首頁連到 edit/?edition=latest、歷史存檔頁連到那一期；真正能不能存，由 GitHub 權限決定（要是儲存庫協作者）。
(function () {
  var KEY = 'gp_editor', m = /[?&]editor=(on|off)\b/.exec(location.search);
  try {
    if (m) {
      if (m[1] === 'on') localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY);
      history.replaceState(null, '', location.pathname + location.hash);
    }
    if (localStorage.getItem(KEY) !== '1' || window.frameElement) return;  // 編輯器裡面預覽時不顯示
    var box = document.getElementById('lang'); if (!box) return;
    var d = /\/archive\/(\d{4}-\d\d-\d\d)\.html/.exec(location.pathname), inArc = /\/archive\//.test(location.pathname);
    var a = document.createElement('a');
    a.className = 'hist edit'; a.textContent = '修改';
    a.href = (inArc ? '../' : '') + 'edit/' + (d ? '?edition=' + d[1] : inArc ? '' : '?edition=latest');
    box.insertBefore(a, document.getElementById('langMenu'));
  } catch (e) {}
})();
