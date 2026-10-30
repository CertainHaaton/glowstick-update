# 本機／每週排程用：在 git 資料夾裡開新的一期、發布（推送後 GitHub 會自動重產網站）。
# 在 D:\AI\temp\pirate-progress\publish 執行：
#   python -X utf8 src/tools/edition_cli.py list
#   python -X utf8 src/tools/edition_cli.py new [YYYY-MM-DD]        以最新一期的版型當底開新一期（內容區清空、草稿 draft:true，不會公開）
#   python -X utf8 src/tools/edition_cli.py publish YYYY-MM-DD "說明" [--home]
#                                                                    更新 edition.json 時間、draft:false → commit → push。
#                                                                    發布不會搶首頁（首頁看 src/site.json 的 home）；加 --home 才把這一期設為首頁
#   python -X utf8 src/build_site.py                                 本機預覽整站（輸出到 _site/，不會上傳）
# 改內容：直接改 src/editions/<日期>/ 的 template.html、i18n.json（ensure_ascii=False、indent=1），媒體放 img/。
# 網頁版編輯器（https://certainhaaton.github.io/glowstick-update/edit/）也是改同一份檔案；推送前一定先 git pull。
import datetime, json, pathlib, re, shutil, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
EDS = ROOT / "src" / "editions"

# 期數代號＝日期；同一天第二篇起加 -2、-3…（例 2026-10-30-2），排序時同一天依序號
DATE_RE = re.compile(r"\d{4}-\d\d-\d\d(-([2-9]|[1-9]\d))?$")


def ed_key(name):
    return (name[:10], int(name[11:] or 1))


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
    # 版型、文字、翻譯紀錄交給 new_edition.js（跟網頁版編輯器「新增文章」同一支 structedit.js）
    r = subprocess.run(["node", str(ROOT / "src" / "tools" / "new_edition.js"), str(dst), d],
                       capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        shutil.rmtree(dst)
        sys.exit("開新一期失敗：" + r.stderr)
    used = set(json.loads(r.stdout))
    for f in list((dst / "img").iterdir()):
        if f.is_file() and f.stem not in used:
            f.unlink()  # 這是剛複製出來的副本，上一期的原檔不受影響
    (dst / "edition.json").write_text(json.dumps({"updated": d[:10].replace("-", "."), "draft": True}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("已開新的一期（草稿，還不會公開）：src/editions/%s/" % d)


def site_home():
    f = ROOT / "src" / "site.json"
    return json.loads(f.read_text(encoding="utf-8")).get("home") if f.exists() else None


def publish(d, msg, make_home=False):
    if d not in dates():
        sys.exit("沒有 %s 這一期" % d)
    # 首頁由 src/site.json 的 home 決定。沒指定 --home 時，發布不能換掉首頁：還沒有 site.json 就先把目前的首頁（最新公開那期）釘住
    home = d if make_home else (site_home() or (published()[0] if published() else d))
    (ROOT / "src" / "site.json").write_text(json.dumps({"home": home}, indent=1) + "\n", encoding="utf-8")
    m = meta(d)
    m["updated"] = datetime.datetime.now().strftime("%Y.%m.%d %H:%M")
    m["draft"] = False
    (EDS / d / "edition.json").write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
    r = subprocess.run([sys.executable, "-X", "utf8", str(ROOT / "src" / "build_site.py"), "_site"], cwd=ROOT)
    if r.returncode:
        sys.exit("產生網站失敗，沒有推送")
    git("add", "src/editions/" + d, "src/site.json")
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
        rest = [x for x in a[2:] if x != "--home"]
        publish(a[1], rest[0] if rest else "更新內容", "--home" in a)
    else:
        sys.exit("用法見檔案開頭")
