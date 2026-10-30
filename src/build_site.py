# 產生整個網站到 _site/（GitHub Actions 每次有人改 src/ 就跑一次，產物直接部署到 GitHub Pages）。
#   src/editions/<日期>/      每一期的原始檔：template.html、i18n.json、i18n_src.json、img/、edition.json
#   src/site/                 共用：render.py（組網頁）、archive_index.py（歷史回顧清單）、ui.css、ui.js
#   src/edit/                 網頁編輯器（照原樣複製到 _site/edit/）
# 產物：index.html（最新一期）、archive/<日期>.html、archive/editions.json、archive/index.html、edit/
# edition.json：{"updated": "2026.10.30 10:24", "draft": false}；draft＝true 的期數不公開。
# 本機預覽：python src/build_site.py → 開 _site/index.html。
import base64, json, pathlib, re, shutil, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
sys.path.insert(0, str(SRC / "site"))
from render import render  # noqa: E402
from archive_index import archive_index  # noqa: E402

OUT = ROOT / (sys.argv[1] if len(sys.argv) > 1 else "_site")
DATE_RE = re.compile(r"\d{4}-\d\d-\d\d$")


def meta(d):
    f = d / "edition.json"
    m = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    m.setdefault("updated", d.name.replace("-", "."))
    m.setdefault("draft", False)
    return m


def main():
    eds_dir = SRC / "editions"
    dirs = sorted([d for d in eds_dir.iterdir() if d.is_dir() and DATE_RE.match(d.name) and (d / "template.html").exists()],
                  key=lambda d: d.name, reverse=True)
    pub = [d for d in dirs if not meta(d)["draft"]]
    if not pub:
        sys.exit("沒有任何可公開的期數")
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "archive").mkdir(parents=True)
    eds, problems = [], []
    for i, d in enumerate(pub):
        m = meta(d)
        i18n = json.loads((d / "i18n.json").read_text(encoding="utf-8"))
        page, missing = render(d, m["updated"], "./")
        if missing:
            problems.append("%s 缺少媒體：%s" % (d.name, "、".join(missing)))
        (OUT / "archive" / (d.name + ".html")).write_text(page, encoding="utf-8")
        if i == 0:  # 最新一期＝首頁
            (OUT / "index.html").write_text(render(d, m["updated"], "archive/")[0], encoding="utf-8")
        eds.append({"date": d.name, "file": d.name + ".html",
                    "title": {k: re.sub(r"<[^>]+>", "", v).strip() for k, v in i18n["t"]["h1"].items()}})
        print("第 %s 期 OK（%.1f MB）" % (d.name, len(page.encode("utf-8")) / 1048576))
    (OUT / "archive" / "editions.json").write_text(json.dumps(eds, ensure_ascii=False, indent=1), encoding="utf-8")
    latest = pub[0]
    fav = latest / "img" / "favicon.png"
    fav_tag = '<link rel="icon" type="image/png" href="data:image/png;base64,%s">' % base64.b64encode(fav.read_bytes()).decode() if fav.exists() else ""
    (OUT / "archive" / "index.html").write_text(archive_index(
        eds, json.loads((latest / "i18n.json").read_text(encoding="utf-8")), fav_tag,
        (SRC / "site" / "ui.css").read_text(encoding="utf-8"), (SRC / "site" / "ui.js").read_text(encoding="utf-8")), encoding="utf-8")
    if (SRC / "edit").exists():
        shutil.copytree(SRC / "edit", OUT / "edit")
    (OUT / ".nojekyll").write_text("", encoding="utf-8")
    for p in problems:
        print("注意：" + p)
    print("完成：%d 期 → %s" % (len(pub), OUT))


if __name__ == "__main__":
    main()
