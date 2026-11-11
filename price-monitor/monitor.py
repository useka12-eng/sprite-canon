#!/usr/bin/env python3
"""PC 부품 최저가 모니터 (다나와 기준).

부품별 후보 상품 페이지에서 관측 가능한 모든 가격(다나와 최저가, 카드결제 혜택가,
N+멤버십 혜택가, 현금 최저가)을 모아 가장 낮은 값을 구하고, baseline.json 에 저장된
기준가보다 내려갔는지 판정한다.

  python3 monitor.py            현재가 조회 + 기준가 대비 판정 (기준가는 건드리지 않음)
  python3 monitor.py --update   하락한 부품의 기준가를 새 최저가로 갱신
  python3 monitor.py --init     기준가를 현재가로 새로 만든다 (최초 1회)
  python3 monitor.py --state "cpu 335200/357580 ram ..."
                                baseline.json 대신 문자열(부품ID 전체최저/카드최저)을 기준가로 쓰고,
                                갱신된 문자열을 NEW_STATE 줄로 출력한다 (파일을 쓰지 않음)

종료 코드: 0 = 하락 없음, 10 = 하락 있음, 2 = 조회 실패(판정 불가 부품 존재)
표준 라이브러리만 사용한다. 네트워크는 curl 로 호출한다(프록시 설정을 그대로 따른다).
"""
import html
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
PARTS = os.path.join(HERE, "parts.json")
BASELINE = os.path.join(HERE, "baseline.json")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
KST = timezone(timedelta(hours=9))
# 다나와 최저가의 이 비율 미만인 값은 오등록(부속품·사은품 가격 등)으로 보고 버린다.
SANITY_RATIO = 0.6
CASH = "현금 최저가"


def fetch(pcode):
    url = "https://prod.danawa.com/info/?pcode=" + pcode
    # 간혹 판매처 목록(혜택가·현금가)이 빠진 축약 응답이 온다. 목록이 있는 응답을 우선하고,
    # 끝까지 없으면 최저가만 담긴 응답이라도 쓴다(가격이 높게 보일 뿐 오탐은 없다).
    partial = None
    for attempt in range(4):
        r = subprocess.run(
            ["curl", "-sS", "-L", "-m", "40", "-A", UA,
             "-H", "Accept-Language: ko-KR,ko;q=0.9", url],
            capture_output=True)
        body = r.stdout.decode("utf-8", "replace")
        if r.returncode == 0 and "application/ld+json" in body:
            if '<li class="list-item">' in body:
                return body
            partial = body
        time.sleep(2 * (attempt + 1))
    return partial


def num(s):
    return int(re.sub(r"[^\d]", "", s))


def text(s):
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s))).strip()


def parse(page):
    """상품 페이지에서 (가격, 종류, 판매처, 조건) 목록을 뽑는다."""
    offers = []
    m = re.search(r'"lowPrice"\s*:\s*"?(\d+)', page)
    low = int(m.group(1)) if m else None
    if low:
        offers.append({"price": low, "kind": "다나와 최저가", "mall": "", "cond": ""})

    for li in re.findall(r'<li class="list-item">(.*?)</li>', page, re.S):
        mall = re.search(r"alt='([^']*)'", li)
        mall = html.unescape(mall.group(1)) if mall else ""
        deliv = re.search(r'class="box__delivery">(.*?)</div>', li, re.S)
        deliv = text(deliv.group(1)) if deliv else ""
        if "box__membership-price" in li:
            p = (re.search(r'class="text__num">([\d,]+)<', li)
                 or re.search(r'class="text__discount-price">([\d,]+)', li))
            if not p:
                continue
            cond = re.search(r'class="text__line">(.*?)</span>', li, re.S) or \
                re.search(r'class="(?:text__desc|box__desc-wrap)">(.*?)</div>', li, re.S)
            cond = text(cond.group(1)) if cond else ""
            kind = "N+멤버십 혜택가" if "멤버십" in cond else "카드결제 혜택가"
            offers.append({"price": num(p.group(1)), "kind": kind, "mall": mall,
                           "cond": cond + (" / 배송비 " + deliv if deliv else "")})
        elif "badge__cash" in li:
            p = re.search(r'class="text__num">([\d,]+)<', li)
            if p:
                offers.append({"price": num(p.group(1)), "kind": "현금 최저가", "mall": mall,
                               "cond": "현금결제" + (" / " + deliv if deliv else "")})
        else:
            p = re.search(r'class="text__num">([\d,]+)<', li)
            if p:
                offers.append({"price": num(p.group(1)), "kind": "쇼핑몰 판매가", "mall": mall,
                               "cond": deliv})

    m = re.search(r"현금최저가:\s*([\d,]+)원", page)
    if m:
        offers.append({"price": num(m.group(1)), "kind": "현금 최저가", "mall": "", "cond": "현금결제"})

    if low:
        offers = [o for o in offers if o["price"] >= low * SANITY_RATIO]
    # 같은 (가격, 종류) 중복 제거: 판매처 정보가 있는 쪽을 남긴다.
    best = {}
    for o in offers:
        k = (o["price"], o["kind"])
        if k not in best or (o["mall"] and not best[k]["mall"]):
            best[k] = o
    return sorted(best.values(), key=lambda o: o["price"])


def scan():
    cfg = json.load(open(PARTS, encoding="utf-8"))
    out = []
    for part in cfg["parts"]:
        rows, failed = [], []
        for c in part["candidates"]:
            page = fetch(c["pcode"])
            offers = parse(page) if page else []
            if not offers:
                failed.append(c["name"])
                continue
            o = offers[0]
            by_kind = {}
            for x in offers:
                by_kind.setdefault(x["kind"], x["price"])
            url = "https://prod.danawa.com/info/?pcode=" + c["pcode"]
            for x in offers:
                rows.append({"pcode": c["pcode"], "name": c["name"], "price": x["price"],
                             "kind": x["kind"], "mall": x["mall"], "cond": x["cond"],
                             "by_kind": by_kind, "url": url})
            time.sleep(1.2)
        rows.sort(key=lambda r: r["price"])
        card = [r for r in rows if r["kind"] != CASH]
        out.append({"id": part["id"], "label": part["label"],
                    "best": rows[0] if rows else None,
                    "card": card[0] if card else None, "failed": failed})
    return out


def won(n):
    return f"{n:,}원"


def snap(o, now):
    return {"price": o["price"], "name": o["name"], "kind": o["kind"],
            "mall": o["mall"], "since": now}


def describe(o):
    return (f"{won(o['price'])} [{o['kind']}] {o['name']}"
            f"{' @' + o['mall'] if o['mall'] else ''}{' (' + o['cond'] + ')' if o['cond'] else ''}")


# 부품마다 두 가지 기준가를 본다.
#   all  : 현금가까지 포함해 관측되는 모든 가격 중 최저
#   card : 현금가를 뺀 최저 (다나와 최저가·카드결제 혜택가·N+멤버십 혜택가)
TRACKS = (("all", "best", "전체 최저(현금 포함)"), ("card", "card", "카드·혜택 최저(현금 제외)"))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M KST")
    result = scan()
    incomplete = [p["label"] for p in result if not p["best"]]

    if mode == "--init":
        if incomplete:
            print("조회 실패로 기준가를 만들 수 없음:", ", ".join(incomplete))
            return 2
        base = {"created": now, "updated": now, "parts": {
            p["id"]: {"label": p["label"],
                      **{t: snap(p[f], now) for t, f, _ in TRACKS if p[f]}}
            for p in result}}
        json.dump(base, open(BASELINE, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print("기준가 생성 완료")
    state = None
    if mode == "--state":
        state = {}
        for pid, pair in re.findall(r"(\w+) (\d+/\d+)", sys.argv[2]):
            a, c = pair.split("/")
            state[pid] = {"all": {"price": int(a)}, "card": {"price": int(c)}}
        base = {"parts": state}
    else:
        base = json.load(open(BASELINE, encoding="utf-8"))

    drops, lines = [], []
    totals = {t: [0, 0] for t, _, _ in TRACKS}
    for p in result:
        b = base["parts"].get(p["id"], {})
        if not p["best"]:
            lines.append(f"- {p['label']}: 조회 실패")
            continue
        lines.append(f"- {p['label']}")
        for t, f, title in TRACKS:
            cur = p[f]
            if not cur:
                continue
            old = b.get(t)
            diff = cur["price"] - old["price"] if old else 0
            mark = "하락" if diff < 0 else ("동일" if diff == 0 else "상승")
            totals[t][0] += cur["price"]
            totals[t][1] += old["price"] if old else cur["price"]
            lines.append(f"    {title}: {describe(cur)}\n"
                         f"        기준 {won(old['price']) if old else '-'} → {mark} {diff:+,}원")
            if diff < 0 or not old:
                drops.append((p, t, title, cur, old, diff))
        kinds = ", ".join(f"{k} {won(v)}" for k, v in p["best"]["by_kind"].items())
        lines.append(f"    최저 상품의 가격 종류별: {kinds}\n    {p['best']['url']}")

    print(f"[PC 부품 최저가] {now}")
    print("\n".join(lines))
    for t, _, title in TRACKS:
        n, o = totals[t]
        print(f"합계 {title}: 현재 {won(n)} / 기준 {won(o)} ({n - o:+,}원)")

    real = [d for d in drops if d[4]]
    if real:
        print("\nDROP_DETECTED")
        for p, t, title, cur, old, diff in real:
            print(f"ALERT {p['label']} / {title}: {won(old['price'])} → {won(cur['price'])} "
                  f"({diff:,}원) {describe(cur)} {cur['url']}")
    else:
        print("\nNO_DROP")
    if mode == "--update" and drops:
        for p, t, title, cur, old, diff in drops:
            base["parts"].setdefault(p["id"], {"label": p["label"]})[t] = snap(cur, now)
        base["updated"] = now
        json.dump(base, open(BASELINE, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print("기준가 갱신 완료 (baseline.json)")
    if state is not None:
        for p, t, title, cur, old, diff in drops:
            state.setdefault(p["id"], {})[t] = {"price": cur["price"]}
        print("NEW_STATE " + " ".join(
            f"{pid} {v['all']['price']}/{v['card']['price']}" for pid, v in state.items()))
    if incomplete:
        print("조회 실패 부품:", ", ".join(incomplete))
    for p in result:
        if p["failed"] and p["best"]:
            print(f"(참고) {p['label']} 일부 후보 조회 실패: {', '.join(p['failed'])}")
    return 10 if real else (2 if incomplete else 0)


if __name__ == "__main__":
    sys.exit(main())
