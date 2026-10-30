# 本機／每週排程用：在 git 資料夾裡開新的一期、發布（推送後 GitHub 會自動重產網站）。
# 在 D:\AI\temp\pirate-progress\publish 執行：
#   python -X utf8 src/tools/edition_cli.py list
#   python -X utf8 src/tools/edition_cli.py new [YYYY-MM-DD]        以最新一期的版型當底開新一期（內容區清空、草稿 draft:true，不會公開）
#   python -X utf8 src/tools/edition_cli.py publish YYYY-MM-DD "說明" 更新 edition.json 時間、draft:false → commit → push
#   python -X utf8 src/build_site.py                                 本機預覽整站（輸出到 _site/，不會上傳）
# 改內容：直接改 src/editions/<日期>/ 的 template.html、i18n.json（ensure_ascii=False、indent=1），媒體放 img/。
# 網頁版編輯器（https://certainhaaton.github.io/glowstick-update/edit/）也是改同一份檔案；推送前一定先 git pull。
import datetime, json, pathlib, re, shutil, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
EDS = ROOT / "src" / "editions"
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import structedit as se  # noqa: E402

# 期數代號＝日期；同一天第二篇起加 -2、-3…（例 2026-10-30-2），排序時同一天依序號
DATE_RE = re.compile(r"\d{4}-\d\d-\d\d(-([2-9]|[1-9]\d))?$")


def ed_key(name):
    return (name[:10], int(name[11:] or 1))


def ed_label(name):
    return name[:10].replace("-", ".") + (" #" + name[11:] if len(name) > 10 else "")


def git(*a, check=True):
    print("> git " + " ".join(a))
    return subprocess.run(["git"] + list(a), cwd=ROOT, check=check)


def meta(d):
    f = EDS / d / "edition.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def dates():
    return sorted([p.name for p in EDS.iterdir() if p.is_dir() and DATE_RE.match(p.name) and (p / "template.html").exists()], key=ed_key, reverse=True)


def published():
    return [d for d in dates() if not meta(d).get("draft")]


def point_to(d):
    p = EDS / d
    se.TEMPLATE, se.I18N, se.IMG, se.BACKUP = p / "template.html", p / "i18n.json", p / "img", ROOT / "_backups"


def new(d):
    if not d:  # 沒指定：今天；今天已經有了就自動接 -2、-3…
        d, n = datetime.date.today().isoformat(), 2
        while d in dates():
            d, n = d[:10] + "-%d" % n, n + 1
    if not DATE_RE.match(d):
        sys.exit("日期格式要像 2026-11-06（同一天第二篇：2026-11-06-2）")
    if d in dates():
        sys.exit("已經有 %s 這一期了" % d)
    base = published()[0]
    dst = EDS / d
    shutil.copytree(EDS / base, dst)
    point_to(d)
    s, dd = se.load()
    nl = se.nl_of(s)
    while True:  # 拿掉所有分類
        m = re.search(r"<section\b", s)
        if not m:
            break
        b = se.match_close(s, m.start(), "section")
        for k in se.keys_in(s[m.start():b]):
            dd["t"].pop(k, None)
        a1, b1 = se.lines_of(s, m.start(), b)
        s = s[:a1] + s[b1:]
    lp = s.find('<div class="lead"')
    lead = se.enclosing(s, s.find(">", lp), "div", "lead") if lp >= 0 else None
    first = None
    if lead:  # 開頭只留第一段
        ps = list(re.finditer(r'<p\b[^>]*data-i18n="(\w+)"[^>]*>.*?</p>', s[lead[0]:lead[1]], re.S))
        first = ps[0].group(1) if ps else None
        for m in reversed(ps[1:]):
            dd["t"].pop(m.group(1), None)
            a1, b1 = se.lines_of(s, lead[0] + m.start(), lead[0] + m.end())
            s = s[:a1] + s[b1:]
    at, ind = se.insert_point(s, "section", first or "h1")
    text, _ = se.new_block("section", ind, nl, dd)
    s = se.put(s, at, text)
    langs = [L["code"] for L in dd["langs"]]
    dd["t"]["h1"] = {L: ("開發週報<i>・</i>" + ed_label(d) if L == "tw" else "") for L in langs}
    if first:
        dd["t"][first] = {L: ("以下整理本週的主要更新內容。" if L == "tw" else "") for L in langs}
    se.save(se.tidy(s), dd)
    srcf = dst / "i18n_src.json"
    src = json.loads(srcf.read_text(encoding="utf-8")) if srcf.exists() else {}
    src = {k: v for k, v in src.items() if k in dd["t"] and k not in ("h1", first)}
    srcf.write_text(json.dumps(src, ensure_ascii=False, indent=1), encoding="utf-8")
    used = set(re.findall(r"\{\{img:(\w+)\}\}", s)) | set(se.media_in(s))
    for f in list((dst / "img").iterdir()):
        if f.is_file() and f.stem not in used:
            f.unlink()  # 這是剛複製出來的副本，上一期的原檔不受影響
    (dst / "edition.json").write_text(json.dumps({"updated": d[:10].replace("-", "."), "draft": True}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("已開新的一期（草稿，還不會公開）：src/editions/%s/" % d)


def publish(d, msg):
    if d not in dates():
        sys.exit("沒有 %s 這一期" % d)
    m = meta(d)
    m["updated"] = datetime.datetime.now().strftime("%Y.%m.%d %H:%M")
    m["draft"] = False
    (EDS / d / "edition.json").write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
    r = subprocess.run([sys.executable, "-X", "utf8", str(ROOT / "src" / "build_site.py"), "_site"], cwd=ROOT)
    if r.returncode:
        sys.exit("產生網站失敗，沒有推送")
    git("add", "src/editions/" + d)
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT).returncode == 0:
        print("沒有變更，不需要發布")
        return
    git("-c", "user.name=Glowstick Pirates", "commit", "-q", "-m", "%s（%s）\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" % (msg, d))
    git("pull", "-q", "--rebase")
    git("push", "-q", "origin", "main")
    print("已推送第 %s 期。GitHub 正在產生網站，約 1～2 分鐘後 https://certainhaaton.github.io/glowstick-update/ 就是新版。" % d)


if __name__ == "__main__":
    a = sys.argv[1:] or ["list"]
    if a[0] == "list":
        for d in dates():
            print(d, "（草稿）" if meta(d).get("draft") else "", meta(d).get("updated", ""))
    elif a[0] == "new":
        new(a[1] if len(a) > 1 else None)
    elif a[0] == "publish" and len(a) >= 2:
        publish(a[1], a[2] if len(a) > 2 else "更新內容")
    else:
        sys.exit("用法見檔案開頭")
