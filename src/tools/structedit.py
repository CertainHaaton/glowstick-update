# 網站編輯器的「結構」操作：插入／刪除／移動／複製貼上 段落、圖片影片、項目、分類。
# 直接改 template.html（版型）＋ i18n.json（文字），由 editor_server.py 的 POST /api/struct、/api/undo 呼叫。
# 每次操作前把 template.html、i18n.json 備份到 backups\struct_<時間>\，刪除時搬走的媒體檔也放那裡 → undo() 可一步步復原。
#
# 區塊（block）四種，右鍵點到的物件會對應到其中一種：
#   para    段落：項目裡或開頭（<div class="lead">）的 <p data-i18n>
#   media   圖片影片：<figure>{{media:名稱|說明}}</figure>（可能包在 <div class="pair"> 並排框裡）
#   item    項目：<div class="item">（h3 標題＋段落＋圖片）
#   section 分類：<section>（h2 標題＋項目）
# 其他（大標題、頁首頁尾、附註）是固定物件，只能改字不能動結構。
# 新增的東西照現有版型的形狀與縮排寫，週報排程與 build.py 都依賴這個形狀。
import json, re, time, shutil, datetime, pathlib

ROOT = pathlib.Path(__file__).parent
TEMPLATE = ROOT / "template.html"
I18N = ROOT / "i18n.json"
IMG = ROOT / "img"
BACKUP = ROOT / "backups"
MEDIA_EXT = (".webp", ".jpg", ".png", ".gif", ".mp4", ".webm")
LEVEL_NAME = {"para": "段落", "media": "圖片／影片", "item": "項目", "section": "分類"}


class StructError(Exception):
    pass


# ---------- 讀寫與備份 ----------
def load():
    return TEMPLATE.read_bytes().decode("utf-8"), json.loads(I18N.read_text(encoding="utf-8"))


def save(s, d):
    TEMPLATE.write_bytes(s.encode("utf-8"))  # 原樣寫回，保留 CRLF
    I18N.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")


def snapshot(label):
    # 名稱含微秒：undo() 用名稱排序找「最近一次」，同一秒內多次操作也排得對
    p = BACKUP / ("struct_" + datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f"))
    while p.exists():
        time.sleep(0.001)
        p = BACKUP / ("struct_" + datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f"))
    p.mkdir(parents=True)
    shutil.copyfile(TEMPLATE, p / "template.html")
    shutil.copyfile(I18N, p / "i18n.json")
    write_op(p, {"label": label, "moved": [], "copied": []})
    return p


def read_op(p):
    return json.loads((p / "op.json").read_text(encoding="utf-8"))


def write_op(p, op):
    (p / "op.json").write_text(json.dumps(op, ensure_ascii=False), encoding="utf-8")


def undo():
    """還原最近一次結構操作，回傳那次的說明。可連續按，一步步往回。"""
    snaps = [x for x in BACKUP.glob("struct_*") if (x / "op.json").exists() and not (x / "undone").exists()]
    if not snaps:
        raise StructError("沒有可以復原的動作了")
    p = max(snaps, key=lambda x: x.name)
    op = read_op(p)
    keep = BACKUP / (p.name + "_復原前")  # 復原前的狀態也留一份，萬一復原錯了找得回來
    keep.mkdir(exist_ok=True)
    shutil.copyfile(TEMPLATE, keep / "template.html")
    shutil.copyfile(I18N, keep / "i18n.json")
    shutil.copyfile(p / "template.html", TEMPLATE)
    shutil.copyfile(p / "i18n.json", I18N)
    # 先收走這次放進 img\ 的檔（貼上複製的、換圖換上的、捨棄時放回的發布版），再把搬走的舊檔搬回來；同名時順序很重要
    for m in op.get("copied", []):
        if (IMG / m).exists():
            shutil.move(str(IMG / m), str(keep / m))
    for m in op.get("moved", []):
        if (p / m).exists() and not (IMG / m).exists():
            shutil.move(str(p / m), str(IMG / m))
    (p / "undone").write_text("1", encoding="utf-8")
    return op.get("label", "")


# ---------- 換圖片影片（也進復原紀錄） ----------
def replace_media(name, ext, data):
    """同名舊檔（任何副檔名）搬進這一步的備份，寫入新檔；Ctrl+Z 可換回來。"""
    if not re.fullmatch(r"\w+", name) or ext not in MEDIA_EXT:
        raise StructError("名稱或檔案類型不對")
    snap = snapshot("替換圖片／影片「%s」" % name)
    op = read_op(snap)
    for f in media_files(name):
        shutil.move(str(f), str(snap / f.name))
        op["moved"].append(f.name)
    (IMG / (name + ext)).write_bytes(data)
    op["copied"].append(name + ext)
    write_op(snap, op)
    return name + ext


# ---------- 上次發布的狀態：捨棄全部變更用 ----------
PUBLISHED = ROOT / "published"  # publish.py 推送成功後把 template.html、i18n.json、img\ 整份複製到這裡


def save_published():
    tmp = PUBLISHED.with_name("published_new")
    if tmp.exists():
        shutil.rmtree(tmp)
    (tmp / "img").mkdir(parents=True)
    shutil.copyfile(TEMPLATE, tmp / "template.html")
    shutil.copyfile(I18N, tmp / "i18n.json")
    for f in IMG.iterdir():
        if f.is_file():
            shutil.copyfile(f, tmp / "img" / f.name)
    old = PUBLISHED.with_name("published_old")
    if PUBLISHED.exists():
        PUBLISHED.rename(old)
    tmp.rename(PUBLISHED)
    if old.exists():
        shutil.rmtree(old)


def _img_diff():
    """回傳 (跟發布版不同或新增的檔, 發布版有但現在沒有的檔)。"""
    pub = {f.name: f for f in (PUBLISHED / "img").iterdir()} if (PUBLISHED / "img").exists() else {}
    cur = {f.name: f for f in IMG.iterdir() if f.is_file()}
    changed = [n for n, f in cur.items() if n not in pub or f.read_bytes() != pub[n].read_bytes()]
    missing = [n for n in pub if n not in cur]
    return changed, missing


def changes():
    """跟上次發布比，改了哪些。"""
    if not PUBLISHED.exists():
        raise StructError("還沒有發布紀錄，無法比對（發布一次之後就有）")
    t = TEMPLATE.read_bytes() != (PUBLISHED / "template.html").read_bytes()
    a = json.loads(I18N.read_text(encoding="utf-8"))["t"]
    b = json.loads((PUBLISHED / "i18n.json").read_text(encoding="utf-8"))["t"]
    texts = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
    changed, missing = _img_diff()
    return {"template": t, "texts": len(texts), "media": sorted(set(n.rsplit(".", 1)[0] for n in changed + missing))}


def discard():
    """整個回到上次發布的樣子。這一步本身也進復原紀錄（Ctrl+Z 可以把剛捨棄的找回來）。"""
    c = changes()
    if not (c["template"] or c["texts"] or c["media"]):
        raise StructError("跟上次發布一模一樣，沒有東西可以捨棄")
    snap = snapshot("捨棄全部變更")
    op = read_op(snap)
    changed, missing = _img_diff()
    for n in changed:  # 現在的版本搬進備份
        shutil.move(str(IMG / n), str(snap / n))
        op["moved"].append(n)
    for n in changed + missing:  # 發布版放回來（新增的檔發布版沒有，就只是搬走）
        src = PUBLISHED / "img" / n
        if src.exists():
            shutil.copyfile(src, IMG / n)
            op["copied"].append(n)
    write_op(snap, op)
    shutil.copyfile(PUBLISHED / "template.html", TEMPLATE)
    shutil.copyfile(PUBLISHED / "i18n.json", I18N)
    return "捨棄全部變更"


# ---------- 文字位置工具 ----------
def nl_of(s):
    return "\r\n" if "\r\n" in s else "\n"


def line_start(s, i):
    return s.rfind("\n", 0, i) + 1


def line_end(s, i):
    j = s.find("\n", i)
    return len(s) if j < 0 else j + 1


def indent_at(s, i):
    return re.match(r"[ \t]*", s[line_start(s, i):]).group(0)


def tidy(s):
    nl = nl_of(s)
    return re.sub(r"(?:[ \t]*\r?\n){3,}", nl + nl, s)


def match_close(s, start, tag):
    depth = 0
    for m in re.finditer(r"<%s\b|</%s>" % (tag, tag), s[start:]):
        depth += 1 if m.group(0)[1] != "/" else -1
        if depth == 0:
            return start + m.end()
    raise StructError("版型的 <%s> 沒有對應的結尾" % tag)


def enclosing(s, pos, tag, cls=None):
    """包住 pos 的最近一個 <tag class="cls">，回傳 (開始, 結束) 或 None。"""
    pat = r"<%s\b[^>]*>" % tag if cls is None else r'<%s\b[^>]*class="%s"[^>]*>' % (tag, cls)
    for m in reversed(list(re.finditer(pat, s[:pos + 1]))):
        b = match_close(s, m.start(), tag)
        if b > pos:
            return m.start(), b
    return None


def lines_of(s, a, b):
    return line_start(s, a), line_end(s, b - 1)


# ---------- 區塊辨識 ----------
def ref_pos(s, ref):
    if ref.startswith("media:"):
        i = s.find("{{media:%s|" % ref[6:])
    else:
        m = re.search(r'data-i18n="%s"' % re.escape(ref), s)
        i = s.rfind("<", 0, m.start()) if m else -1
    if i < 0:
        raise StructError("版型裡找不到這個物件（%s），可能已經被刪掉了，請重新整理" % ref)
    return i


def block_of(s, ref):
    """ref → (level, 開始, 結束)。固定物件回 ('fixed', pos, pos)。"""
    pos = ref_pos(s, ref)
    if ref.startswith("media:"):
        f = enclosing(s, pos, "figure")
        return ("media",) + f if f else ("fixed", pos, pos)
    tag = re.match(r"<(\w+)", s[pos:]).group(1).lower()
    if tag == "p" and (enclosing(s, pos, "div", "item") or enclosing(s, pos, "div", "lead")):
        return "para", pos, s.find("</p>", pos) + 4
    if tag == "h3" and enclosing(s, pos, "div", "item"):
        return ("item",) + enclosing(s, pos, "div", "item")
    if tag == "h2" and enclosing(s, pos, "section"):
        return ("section",) + enclosing(s, pos, "section")
    return "fixed", pos, pos


def parent_of(s, level, a):
    if level == "para":
        return enclosing(s, a, "div", "item") or enclosing(s, a, "div", "lead")
    if level == "media":
        return enclosing(s, a, "div", "pair") or enclosing(s, a, "div", "item")
    if level == "item":
        return enclosing(s, a, "section")
    return enclosing(s, a, "main")


BLOCK_RE = {"para": r"<p\b[^>]*data-i18n=", "media": r"<figure\b", "item": r'<div\b[^>]*class="item"', "section": r"<section\b"}
BLOCK_TAG = {"para": "p", "media": "figure", "item": "div", "section": "section"}


def siblings(s, level, a):
    par = parent_of(s, level, a)
    out = []
    for m in re.finditer(BLOCK_RE[level], s[par[0]:par[1]]):
        x = par[0] + m.start()
        if parent_of(s, level, x) == par:
            out.append((x, match_close(s, x, BLOCK_TAG[level])))
    return out


def insert_point(s, level, ref):
    """新的 level 區塊要插在 ref 物件「下方」的位置 → (插入位置, 縮排)。"""
    tl, a, b = block_of(s, ref)
    pos = ref_pos(s, ref)
    item = enclosing(s, pos, "div", "item")
    sec = enclosing(s, pos, "section")
    if level == "para":
        if tl == "para":
            return line_end(s, b - 1), indent_at(s, a)
        if item:  # 點到項目標題或圖片：加在項目最後一段文字後面（沒有段落就接在標題後）
            ps = [m for m in re.finditer(r"<p\b.*?</p>", s[item[0]:item[1]], re.S)]
            end = item[0] + (ps[-1].end() if ps else s[item[0]:item[1]].find("</h3>") + 5)
            return line_end(s, end - 1), indent_at(s, item[0]) + "  "
        raise StructError("段落要加在項目或開頭段落裡：請在項目上按右鍵")
    if level == "media":
        if tl == "media":
            return line_end(s, b - 1), indent_at(s, a)
        if item:
            close = s.rfind("</div>", item[0], item[1])
            return line_start(s, close), indent_at(s, item[0]) + "  "
        raise StructError("圖片影片要放在項目裡：請在項目上按右鍵")
    if level == "item":
        if item:
            return line_end(s, item[1] - 1), indent_at(s, item[0])
        if sec:  # 點到分類標題：加成分類的第一個項目
            h2 = s.find("</h2>", sec[0]) + 5
            return line_end(s, h2 - 1), indent_at(s, sec[0]) + "  "
        raise StructError("項目要放在分類裡：請在分類標題或項目上按右鍵")
    if level == "section":
        if sec:
            return line_end(s, sec[1] - 1), indent_at(s, sec[0])
        first = re.search(r"<section\b", s)
        if first:  # 點到開頭段落、大標題：加在第一個分類前面
            return line_start(s, first.start()), indent_at(s, first.start())
        main_end = s.find("<div class=\"note\"")
        return line_start(s, main_end), indent_at(s, main_end)
    raise StructError("不認得的種類")


def reindent(text, old, new):
    out = []
    for ln in text.splitlines(True):
        out.append(new + ln[len(old):] if ln.startswith(old) else ln)
    return "".join(out)


def put(s, at, text):
    nl = nl_of(s)
    # 項目／分類前後空一行，跟現有版型一致
    if re.match(r"\s*<(div class=\"item\"|section)", text):
        text = nl + text + nl
    return tidy(s[:at] + text + s[at:])


# ---------- 文字鍵 ----------
def new_id(prefix):
    time.sleep(0.002)
    return "%s%x" % (prefix, int(time.time() * 1000) % (16 ** 8))


def add_text(d, key, tw):
    """新鍵：繁中填字，其他語言留空（頁面先顯示繁中，翻好再補）。"""
    d["t"][key] = {L["code"]: (tw if L["code"] == "tw" else "") for L in d["langs"]}


def keys_in(text):
    return re.findall(r'data-i18n(?:-alt|-aria)?="(\w+)"', text) + ["cap_" + n for n in media_in(text)]


def media_in(text):
    return re.findall(r"\{\{media:(\w+)\|", text)


def media_files(name):
    return [IMG / (name + e) for e in MEDIA_EXT if (IMG / (name + e)).exists()]


# ---------- 新區塊 ----------
def new_block(level, ind, nl, d):
    i2 = ind + "  "
    if level == "para":
        k = new_id("p"); add_text(d, k, "新段落")
        return ind + '<p data-i18n="%s">新段落</p>' % k + nl, k
    if level == "media":
        n = new_id("m"); add_text(d, "cap_" + n, "圖說")
        return ind + "<figure>{{media:%s|圖說}}</figure>" % n + nl, "media:" + n
    if level == "item":
        k = new_id("i"); add_text(d, k + "_h", "新項目標題"); add_text(d, k + "_p", "新項目內文")
        return (ind + '<div class="item">' + nl + i2 + '<h3 data-i18n="%s_h">新項目標題</h3>' % k + nl +
                i2 + '<p data-i18n="%s_p">新項目內文</p>' % k + nl + ind + "</div>" + nl), k + "_h"
    if level == "section":
        k = new_id("s"); add_text(d, "sec_" + k, "新分類")
        add_text(d, k + "i_h", "新項目標題"); add_text(d, k + "i_p", "新項目內文")
        i3 = i2 + "  "
        return (ind + '<section id="%s">' % k + nl + i2 + '<h2 data-i18n="sec_%s">新分類</h2>' % k + nl + nl +
                i2 + '<div class="item">' + nl + i3 + '<h3 data-i18n="%si_h">新項目標題</h3>' % k + nl +
                i3 + '<p data-i18n="%si_p">新項目內文</p>' % k + nl + i2 + "</div>" + nl + ind + "</section>" + nl), "sec_" + k


def clone_block(text, d, op):
    """複製區塊：所有文字鍵、媒體名、分類 id 換新（媒體檔也複製一份），回傳 (新文字, 第一個鍵)。"""
    first = None
    for k in dict.fromkeys(re.findall(r'data-i18n(?:-alt|-aria)?="(\w+)"', text)):
        nk = new_id("c") + "_" + k[-12:]
        d["t"][nk] = json.loads(json.dumps(d["t"].get(k, {})))
        text = text.replace('"%s"' % k, '"%s"' % nk)
        first = first or nk
    for n in dict.fromkeys(media_in(text)):
        nn = new_id("m")
        d["t"]["cap_" + nn] = json.loads(json.dumps(d["t"].get("cap_" + n, {})))
        for f in media_files(n):
            shutil.copyfile(f, IMG / (nn + f.suffix))
            op["copied"].append(nn + f.suffix)
        text = text.replace("{{media:%s|" % n, "{{media:%s|" % nn)
        first = first or "media:" + nn
    text = re.sub(r'<section id="\w+"', lambda m: '<section id="%s"' % new_id("s"), text)
    return text, first


# ---------- 對外操作 ----------
def describe(ref):
    """右鍵選單用：這個物件屬於哪種區塊、能不能上下移。"""
    s, _ = load()
    level, a, b = block_of(s, ref)
    if level == "fixed":
        return {"level": "fixed"}
    sib = [x[0] for x in siblings(s, level, a)]
    i = sib.index(a) if a in sib else -1
    return {"level": level, "name": LEVEL_NAME[level], "up": i > 0, "down": 0 <= i < len(sib) - 1}


def apply(op, ref, kind=None, src=None):
    """
    op：insert（kind＝para/media/item/section）、delete、up、down、
        paste（src＝來源物件、kind＝copy 或 cut）、dup（複製且貼上＝貼在自己下面）
    回傳 {label, focus}；focus＝新東西或移動後東西的鍵，頁面重整後捲過去。
    """
    s, d = load()
    nl = nl_of(s)

    if op == "insert":
        if kind not in LEVEL_NAME:
            raise StructError("不認得的種類")
        at, ind = insert_point(s, kind, ref)
        text, focus = new_block(kind, ind, nl, d)
        label = "插入" + LEVEL_NAME[kind]
        snapshot(label)
        save(put(s, at, text), d)
        return {"label": label, "focus": focus}

    level, a, b = block_of(s, ref)
    if level == "fixed":
        raise StructError("這是固定物件（大標題、頁首頁尾、附註等），只能改字")

    if op == "delete":
        label = "刪除" + LEVEL_NAME[level]
        snap = snapshot(label)
        block = s[a:b]
        for k in keys_in(block):
            d["t"].pop(k, None)
        op_rec = read_op(snap)
        for n in media_in(block):  # 媒體檔搬進備份，復原時搬回來
            for f in media_files(n):
                shutil.move(str(f), str(snap / f.name))
                op_rec["moved"].append(f.name)
        write_op(snap, op_rec)
        la, lb = lines_of(s, a, b)
        s = tidy(s[:la] + s[lb:])
        save(s, d)
        return {"label": label, "focus": None}

    if op in ("up", "down"):
        sib = siblings(s, level, a)
        i = [x[0] for x in sib].index(a)
        j = i - 1 if op == "up" else i + 1
        if j < 0 or j >= len(sib):
            raise StructError("已經是%s一個了" % ("第" if op == "up" else "最後"))
        (a1, b1), (a2, b2) = sorted([sib[i], sib[j]])
        a1, b1 = lines_of(s, a1, b1)
        a2, b2 = lines_of(s, a2, b2)
        label = ("上移" if op == "up" else "下移") + LEVEL_NAME[level]
        snapshot(label)
        save(s[:a1] + s[a2:b2] + s[b1:a2] + s[a1:b1] + s[b2:], d)
        return {"label": label, "focus": ref}

    if op in ("paste", "dup"):
        if op == "dup":
            src, kind = ref, "copy"
        slevel, sa, sb = block_of(s, src)
        if slevel == "fixed":
            raise StructError("剪貼簿裡的東西已經找不到了")
        if kind == "cut" and sa <= ref_pos(s, ref) < sb:
            raise StructError("不能貼到自己裡面")
        insert_point(s, slevel, ref)  # 先驗證目的地放得下，放不下就直接報錯、不留備份
        la, lb = lines_of(s, sa, sb)
        text = s[la:lb]
        label = ("移動" if kind == "cut" else "貼上") + LEVEL_NAME[slevel]
        snap = snapshot(label)
        op_rec = read_op(snap)
        if kind == "cut":
            s = tidy(s[:la] + s[lb:])  # 先拿掉來源，再算目的地位置（ref 還在）
            focus = src
        else:
            text, focus = clone_block(text, d, op_rec)
            write_op(snap, op_rec)
        at, ind = insert_point(s, slevel, ref)
        text = reindent(text, indent_at(text, 0), ind)
        save(put(s, at, text), d)
        return {"label": label, "focus": focus}

    raise StructError("不認得的操作：%s" % op)
