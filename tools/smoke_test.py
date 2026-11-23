"""app.js 스모크 테스트 하네스 (개발용, 배포물 아님).

quickjs로 js/app.js를 실행해 각 화면 렌더링이 예외 없이 HTML을 만드는지 확인한다.
실행: python3 tools/smoke_test.py
"""
import json
import re
import sys
from pathlib import Path

import quickjs

ROOT = Path(__file__).resolve().parent.parent
APP = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
DATA = json.loads((ROOT / "data" / "dramas.json").read_text(encoding="utf-8"))

# 테스트를 위해 내부 함수 노출
APP = APP.replace(
    "document.addEventListener('DOMContentLoaded', boot);",
    "globalThis.__app = {boot, render, renderHome, renderExplore, renderLibrary, renderDetail, "
    "renderWatch, cardHTML, gridHTML, filterDramas, esc, fmtDur, timecode, dramaById, state, store};\n"
    "document.addEventListener('DOMContentLoaded', boot);",
)

STUBS = r"""
globalThis.window = globalThis;
class El {
  constructor(tag){ this.tagName = tag; this._html = ''; this.style = {}; this.dataset = {};
    this.classList = {add(){}, remove(){}, toggle(){}, contains(){ return false; }};
    this.hidden = false; this.children = []; this.textContent = '';
  }
  get innerHTML(){ return this._html; }
  set innerHTML(v){ this._html = String(v); }
  addEventListener(){}
  appendChild(c){ this.children.push(c); return c; }
  remove(){}
  replaceWith(){}
  querySelector(){ return null; }
  querySelectorAll(){ return []; }
  closest(){ return null; }
  focus(){}
  scrollIntoView(){}
}
const els = {
  view: new El('main'), toast: new El('div'), topbar: new El('header'),
  tabbar: new El('nav'), heroTrack: null, heroDots: null, ytplayer: null
};
globalThis.document = {
  addEventListener(){},
  getElementById(id){ return els[id] || null; },
  querySelector(sel){ const map = {'#view':'view','#tabbar':'tabbar','#topbar':'topbar','#toast':'toast'};
    if (map[sel]) return els[map[sel]];
    if (!els[sel]) els[sel] = new El('div');
    return els[sel]; },
  querySelectorAll(){ return []; },
  createElement(tag){ return new El(tag); },
  head: { appendChild(){} },
  body: new El('body'),
  hidden: false,
  visibilityState: 'visible'
};
const storage = {};
globalThis.localStorage = {
  getItem(k){ return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
  setItem(k, v){ storage[k] = String(v); },
  removeItem(k){ delete storage[k]; }
};
globalThis.location = { hash: '#/home', origin: 'https://example.github.io' };
globalThis.history = { replaceState(){}, pushState(){} };
globalThis.navigator = { serviceWorker: { register(){ return Promise.resolve(); } } };
globalThis.caches = { match(){ return Promise.resolve(null); } };
globalThis.fetch = function(){ return Promise.resolve({ ok: true, json(){ return Promise.resolve(DATA_JSON); } }); };
globalThis.setInterval = function(){ return 1; };
globalThis.clearInterval = function(){};
globalThis.setTimeout = function(fn){ return 1; };
globalThis.clearTimeout = function(){};
globalThis.addEventListener = function(){};
globalThis.scrollTo = function(){};

"""


def main() -> int:
    ctx = quickjs.Context()
    ctx.eval("var DATA_JSON = " + json.dumps(DATA, ensure_ascii=False) + ";")
    ctx.eval(STUBS)
    try:
        ctx.eval(APP)
    except quickjs.JSException as exc:  # noqa: BLE001
        print("APP LOAD FAILED:", str(exc)[:1200])
        return 1

    app = ctx.eval("__app")
    ctx.eval("__app.state.data = DATA_JSON;")

    checks = []
    first = DATA["dramas"][0]
    cases = [
        ("home", f'#/home', None),
        ("explore", "#/explore", None),
        ("library", "#/library", None),
        ("detail", f"#/drama/{first['id']}", None),
        ("watch", f"#/watch/{first['id']}/{first['episodes'][0]['n']}", None),
    ]
    ok = True
    for name, route_hash, _ in cases:
        route_js = json.dumps({
            "home": {"name": "home", "params": {}},
            "explore": {"name": "explore", "params": {}},
            "library": {"name": "library", "params": {}},
            "detail": {"name": "detail", "params": {"id": first["id"]}},
            "watch": {"name": "watch", "params": {"id": first["id"], "ep": first["episodes"][0]["n"]}},
        }[name])
        ctx.eval(f"__app.state.route = {route_js}; __app.state.explore = {{q:'', genre:'all', channel:'all'}};")
        try:
            ctx.eval("__app.render();")
        except quickjs.JSException as exc:  # noqa: BLE001
            print(f"[FAIL] {name}: {str(exc)[:600]}")
            ok = False
            continue
        html = ctx.eval("document.getElementById('view').innerHTML")
        html = str(html)
        checks.append((name, len(html)))
        if len(html) < 200:
            print(f"[WARN] {name}: 렌더 결과가 너무 짧습니다 ({len(html)}자)")
            ok = False
        if name == "home" and first["title"] not in html:
            print("[WARN] home 화면에 첫 작품 제목이 없습니다")
            ok = False
        if name == "detail" and first["title"] not in html:
            print("[WARN] detail 화면에 작품 제목이 없습니다")
            ok = False
        if name == "watch" and "player-screen" not in html:
            print("[WARN] watch 화면에 플레이어가 없습니다")
            ok = False

    # 검색 필터 동작 확인
    try:
        ctx.eval("__app.state.explore = {q: DATA_JSON.dramas[0].title.slice(0,3), genre:'all', channel:'all'};")
        count = ctx.eval("__app.filterDramas().length")
        print(f"검색 필터 결과: {count}건")
        if int(count) < 1:
            print("[WARN] 검색 결과가 없습니다")
            ok = False
    except quickjs.JSException as exc:  # noqa: BLE001
        print("[FAIL] 검색 필터:", str(exc)[:400])
        ok = False

    for name, size in checks:
        print(f"  {name:8} 렌더 OK ({size}자)")
    print("SMOKE TEST:", "PASS" if ok else "CHECK NEEDED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
