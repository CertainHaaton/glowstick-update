# 把一期的原始檔（template.html＋i18n.json＋img\）組成單一 HTML（媒體內嵌成 base64，每個都能下載）。
# GitHub Actions 的 build_site.py 用它產生所有網頁；網頁編輯器（src/edit/render.js）在瀏覽器裡用同一套規則即時預覽。
# 兩邊規則要一致：改這裡就要同步改 render.js。
import base64, json, pathlib, re

MIME = {".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
        ".mp4": "video/mp4", ".webm": "video/webm"}
SHARED = pathlib.Path(__file__).parent  # ui.css、ui.js（每期共用的介面元件）


def find(img_dir, name):
    for ext in MIME:
        p = img_dir / (name + ext)
        if p.exists():
            return p
    return None


def render(ed_dir, updated, history_href="archive/"):
    """回傳 (html, 缺少的媒體名稱清單)。updated＝頁首顯示的「更新」時間字串。"""
    ed_dir = pathlib.Path(ed_dir)
    img_dir = ed_dir / "img"
    I18N = json.loads((ed_dir / "i18n.json").read_text(encoding="utf-8"))
    missing = []

    def uri(p):
        return "data:%s;base64,%s" % (MIME[p.suffix], base64.b64encode(p.read_bytes()).decode())

    def img(m):
        p = find(img_dir, m.group(1))
        if not p:
            missing.append(m.group(1))
            return ""
        return uri(p)

    def media(m):
        name, cap = m.group(1), m.group(2)
        p = find(img_dir, name)
        if not p:
            missing.append(name)
            return '<div class="ph">畫面準備中：%s</div>' % cap
        isv = p.suffix in (".mp4", ".webm")
        if isv:
            tag = '<video src="%s" autoplay loop muted playsinline controls></video>' % uri(p)
        else:
            tag = '<img src="%s" alt="%s" loading="lazy">' % (uri(p), cap)
        # 下載鈕：href 由頁面 script 在點擊時填入媒體本身的 data URI；檔名依目前語言組出
        dl = '<a class="dl" href="#" download="閃光雞海賊團_%s%s" data-ext="%s" data-i18n="%s">下載%s</a>' % (
            cap, p.suffix, p.suffix, "dl_vid" if isv else "dl_img", "影片" if isv else "圖片")
        return tag + '<figcaption><span data-i18n="cap_%s">%s</span>%s</figcaption>' % (name, cap, dl)

    html = (ed_dir / "template.html").read_text(encoding="utf-8")
    html = html.replace("{{i18n_json}}", json.dumps(I18N, ensure_ascii=False))
    html = html.replace("{{ui_css}}", (SHARED / "ui.css").read_text(encoding="utf-8"))
    html = html.replace("{{ui_js}}", (SHARED / "ui.js").read_text(encoding="utf-8"))
    html = html.replace("{{updated}}", updated)
    html = html.replace("{{history_href}}", history_href)
    html = re.sub(r"\{\{img:(\w+)\}\}", img, html)
    html = re.sub(r"\{\{media:(\w+)\|([^}]*)\}\}", media, html)
    return html, missing
