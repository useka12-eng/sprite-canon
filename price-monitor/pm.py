import html, re, subprocess, sys, time
PARTS = {
 "cpu": ("CPU 7800X3D", "19627934 19627808"),
 "ram": ("RAM KingBank DDR5 16Gx2 화이트", "124480105 124480038"),
 "gpu": ("GPU RX 9070 XT", "99711887 94815662 77380985 90701579 77378288 77382845 77461292 79578347 77381780 99892346 77382896 77381483 77378039 96981881 77318285 99288146 99128543 77378093 106694891 124480904 124480888"),
 "case": ("케이스 CH160 PLUS", "97117673 97117652"),
 "psu": ("파워 SFX 화이트 750W+ 골드", "100695704 98409965 113761283 100695731"),
}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
LI = '<li class="list-item">'
def fetch(pc):
    part = None
    for i in range(4):
        r = subprocess.run(["curl", "-sS", "-L", "-m", "40", "-A", UA, "https://prod.danawa.com/info/?pcode=" + pc], capture_output=True)
        b = r.stdout.decode("utf-8", "replace")
        if r.returncode == 0 and "ld+json" in b:
            if LI in b: return b
            part = b
        time.sleep(2 * i + 2)
    return part
def txt(s): return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s))).strip()
def num(s): return int(re.sub(r"\D", "", s))
def offers(pg):
    out = []
    m = re.search(r'"lowPrice"\s*:\s*"?(\d+)', pg)
    low = int(m.group(1)) if m else 0
    if low: out.append((low, "다나와최저가", ""))
    for li in re.findall(LI + r"(.*?)</li>", pg, re.S):
        p = re.search(r'text__num">([\d,]+)<', li) or re.search(r'text__discount-price">([\d,]+)', li)
        if not p: continue
        mall = re.search(r"alt='([^']*)'", li)
        mall = html.unescape(mall.group(1)) if mall else ""
        t = txt(li)
        if "box__membership-price" in li: kind = "N+멤버십혜택가" if "멤버십" in t else "카드혜택가"
        elif "badge__cash" in li: kind = "현금가"
        else: kind = "판매가"
        c = re.search(r"\S+카드 결제 시", t)
        out.append((num(p.group(1)), kind, mall + (" " + c.group(0) if c else "")))
    m = re.search(r"현금최저가:\s*([\d,]+)원", pg)
    if m: out.append((num(m.group(1)), "현금가", ""))
    return sorted(o for o in out if o[0] >= low * 0.6)
old = {k: [int(a), int(c)] for k, a, c in re.findall(r"(\w+) (\d+)/(\d+)", sys.argv[1])}
new, alerts, fails = {k: v[:] for k, v in old.items()}, [], []
for pid, (label, pcs) in PARTS.items():
    rows = []
    for pc in pcs.split():
        pg = fetch(pc)
        if not pg: fails.append(pc); continue
        n = re.search(r'og:title" content="(?:\[다나와\] )?([^"]*)', pg)
        rows += [(pr, kd, ml, html.unescape(n.group(1)) if n else pc, pc) for pr, kd, ml in offers(pg)]
        time.sleep(1.2)
    rows.sort()
    for i, (title, rs) in enumerate((("전체최저(현금포함)", rows), ("카드·혜택최저(현금제외)", [r for r in rows if r[1] != "현금가"]))):
        if not rs: fails.append(pid + ":" + title); continue
        pr, kd, ml, nm, pc = rs[0]
        base = old.get(pid, [0, 0])[i]
        line = f"{label} / {title}: {pr:,}원 [{kd}] {nm} {ml} (기준 {base:,}원, {pr - base:+,}원) https://prod.danawa.com/info/?pcode={pc}"
        print(line)
        if base == 0 or pr < base:
            new.setdefault(pid, [0, 0])[i] = pr
            if base: alerts.append("ALERT " + line)
print("\n".join(alerts) if alerts else "NO_DROP")
if fails: print("FAILED", " ".join(fails))
print("NEW_STATE " + " ".join(f"{k} {a}/{c}" for k, (a, c) in new.items()))
