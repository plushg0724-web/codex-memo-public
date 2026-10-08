"""대화 상태 표시 검사. 가짜 목록·API와 설치된 Chrome(headless)을 사용한다.

실행: python tests/test_thread_status.py  (--screenshot: 공존 화면 캡처)
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
# 실제 앱처럼 공통 도구(common.js)를 먼저 넣는다
SCRIPT = "\n".join((ROOT / f).read_text(encoding="utf-8") for f in ("labels/common.js", "labels/thread-status.js"))
U = lambda n: f"00000000-0000-4000-8000-{n:012d}"
ROW = "[data-app-action-sidebar-thread-row]"


def row(n, extra="", badge=True):
    return (
        f'<div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:{U(n)}" '
        f'data-app-action-sidebar-thread-title="대화 {n}" data-app-action-sidebar-thread-kind="local" {extra} '
        f'onclick="window.__navigated={n}; document.querySelectorAll(\'{ROW}\').forEach(r => r.dataset.appActionSidebarThreadSelected=\'false\'); '
        'this.dataset.appActionSidebarThreadSelected=\'true\'">'
        + ('<span class="cdx-label">＋</span>' if badge else '')
        + f'<span>대화 {n}</span></div>'
    )


HTML = (
    '<!doctype html><html><head><meta charset="utf-8"><style>'
    'body {font: 14px sans-serif; background:#202123; color:#eee; margin:16px;}'
    '[data-app-action-sidebar-thread-row] {display:flex; align-items:center; height:30px; width:320px; cursor:pointer;}'
    '.cdx-label {margin-right:6px;} aside {width:360px;}'
    '</style></head><body><aside>'
    + ''.join(row(n, 'data-app-action-sidebar-thread-selected="true"' if n == 6 else '', badge=n != 7) for n in range(1, 8))
    + row(8, 'style="display:none"')
    + '<div style="height:25px; overflow:hidden"><div style="height:60px"></div>' + row(10) + '</div>'
    + row(9, 'style="margin-top:1000px"')
    + '</aside></body></html>'
)

STATES = {
    U(1): {"state": "ask", "confidence": 0.95},
    U(2): {"state": "blocked", "confidence": 0.9},
    U(4): {"state": "done", "confidence": 0.99},   # 기준 확신은 백엔드가 거른다 (화면은 ask·blocked 만 표시)
    U(5): {"state": "ask", "confidence": 0.97},
    U(6): {"state": "blocked", "confidence": 0.99},
    U(7): {"state": "ask", "confidence": 0.91},
    U(8): {"state": "ask", "confidence": 0.95},
    U(9): {"state": "ask", "confidence": 0.95},
    U(10): {"state": "ask", "confidence": 0.95},
}
MOCKS = "window.__states = " + json.dumps(STATES, ensure_ascii=False) + ";" + r"""
window.__calls = []; window.__assigned = []; window.__navigated = null;
window.__fail = false; window.__hold = false; window.__pending = [];
const response = ids => Object.fromEntries(ids.filter(id => window.__states[id]).map(id => [id, window.__states[id]]));
window.codexLabels = {
  threadStatus: async ids => {
    window.__calls.push(ids);
    if (window.__fail) throw Error('가짜 분류기 중단');
    if (window.__hold) return new Promise(resolve => window.__pending.push(() => resolve(response(ids))));
    return response(ids);
  },
  read: async () => ({config: {labels: [{id:'dev', name:'개발', enabled:true, backgroundColor:'#f87171'}]}, assignments:{}}),
  onChanged: () => () => {},
  assign: async (key, id) => { window.__assigned.push([key, id]); return {}; },
  labelSuggest: async ids => Object.fromEntries(ids.map(id => [id, {labelId:'dev', confidence:0.96}])),
};
"""


def check(name, condition):
    print("✔ " + name if condition else "✘ " + name)
    assert condition, name


def item(page, n):
    return page.locator(f'{ROW}[data-app-action-sidebar-thread-id="local:{U(n)}"]')


def open_page(browser, errors):
    page = browser.new_page(viewport={"width": 900, "height": 700})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("https://codex.test/", lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=HTML))
    page.goto("https://codex.test/")
    page.clock.install(time=0)
    page.clock.pause_at(1000)
    page.add_script_tag(content=MOCKS)
    return page


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    errors = []
    page = open_page(browser, errors)
    page.add_script_tag(content=SCRIPT)
    page.clock.run_for(1000)
    page.evaluate("document.body.append(document.createElement('div'))")
    page.clock.run_for(1499)
    check("목록 변경부터 1.5초 디바운스", page.evaluate("window.__calls.length") == 0)
    page.clock.run_for(1)
    calls = page.evaluate("window.__calls")
    check("보이는 행만 5개씩 요청", [len(c) for c in calls] == [5, 2] and set(sum(calls, [])) == {U(n) for n in range(1, 8)})
    check("답 필요·막힘 표시 (done 은 표시 안 함)", item(page, 1).locator('.cxm-thread-status').inner_text() == '답 필요'
          and item(page, 2).locator('.cxm-thread-status').inner_text() == '막힘'
          and item(page, 3).locator('.cxm-thread-status').count() == 0
          and item(page, 4).locator('.cxm-thread-status').count() == 0)
    check("처음부터 열린 대화는 숨김", item(page, 6).locator('.cxm-thread-status').count() == 0)
    check("라벨 배지가 없는 행에도 표시", item(page, 7).locator('.cxm-thread-status').count() == 1)
    check("설명·확신 툴팁", '확신 95%' in item(page, 1).locator('.cxm-thread-status').get_attribute('title')
          and '권한·환경' in item(page, 2).locator('.cxm-thread-status').get_attribute('title'))
    check("파랑·주황의 작은 점", item(page, 1).locator('.cxm-thread-status').evaluate("e => getComputedStyle(e, '::before').backgroundColor") == 'rgb(96, 165, 250)'
          and item(page, 2).locator('.cxm-thread-status').evaluate("e => getComputedStyle(e, '::before').backgroundColor") == 'rgb(251, 146, 60)')

    item(page, 1).locator('.cxm-thread-status').click()
    check("표시 클릭은 대화로 이동하며 선택 즉시 숨김", page.evaluate("window.__navigated") == 1
          and item(page, 1).locator('.cxm-thread-status').count() == 0)
    item(page, 1).evaluate("e => e.dataset.appActionSidebarThreadSelected = 'false'")
    page.evaluate("document.body.append(document.createElement('div'))")
    page.clock.run_for(2000)
    check("선택을 해제하고 DOM이 바뀌어도 다음 갱신 전에는 숨김 유지", item(page, 1).locator('.cxm-thread-status').count() == 0
          and page.evaluate("window.__calls.length") == 2)

    page.add_script_tag(content=(ROOT / 'labels/common.js').read_text(encoding='utf-8'))
    page.add_script_tag(content=(ROOT / 'labels/label-suggest.js').read_text(encoding='utf-8'))
    page.clock.run_for(3500)
    check("추천 칩과 같은 행에 공존", item(page, 2).locator('.cxm-thread-status').count() == 1
          and item(page, 2).locator('.cxm-label-suggest').count() == 1)
    check("라벨·점·추천 칩이 서로 겹치지 않음", item(page, 2).evaluate("""e => {
      const boxes = [...e.querySelectorAll('.cxm-thread-status,.cdx-label,.cxm-label-suggest')].map(n => n.getBoundingClientRect());
      return boxes.every((a,i) => boxes.every((b,j) => i === j || a.right <= b.left || b.right <= a.left));
    }"""))
    if '--screenshot' in sys.argv:
        target = ROOT / 'output/playwright/test-thread-status.png'
        target.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(target), clip={"x": 0, "y": 0, "width": 420, "height": 290})
    item(page, 5).locator('.cxm-label-suggest').click()
    check("추천 칩 클릭이 상태 표시를 지우지 않음", item(page, 5).locator('.cxm-thread-status').count() == 1
          and len(page.evaluate("window.__assigned")) == 1)

    before = page.evaluate("window.__calls.length")
    page.add_script_tag(content=SCRIPT)
    page.clock.run_for(2000)
    check("같은 VERSION 재주입은 중복 요청·표시 없음", page.evaluate("window.__calls.length") == before
          and item(page, 2).locator('.cxm-thread-status').count() == 1)
    page.clock.run_for(120000)
    check("2분마다 기존 대화도 갱신하고 숨김 해제", page.evaluate("window.__calls.length") > before
          and item(page, 1).locator('.cxm-thread-status').count() == 1)
    page.evaluate(f"delete window.__states['{U(2)}']; window.__states['{U(1)}'] = {{state:'blocked', confidence:0.96}}")
    page.clock.run_for(120000)
    check("다음 갱신에서 완료 표시는 제거하고 바뀐 상태는 반영", item(page, 2).locator('.cxm-thread-status').count() == 0
          and item(page, 1).locator('.cxm-thread-status').inner_text() == '막힘')

    # 실제 목록은 스크롤·행 추가로 새 행이 보인다 (style 변경은 감시하지 않음 — 답변 중 너무 잦음)
    item(page, 8).evaluate("e => { e.style.display = 'flex'; document.dispatchEvent(new Event('scroll')); }")
    page.clock.run_for(2000)
    check("새로 보인 행은 디바운스 후 요청", U(8) in page.evaluate("window.__calls.at(-1)")
          and item(page, 8).locator('.cxm-thread-status').count() == 1)
    page.evaluate("window.__cxmThreadStatus.destroy()")
    before = page.evaluate("window.__calls.length")
    page.clock.run_for(120000)
    check("destroy는 표시·타이머를 정리하며 추천 칩은 보존", page.locator('.cxm-thread-status').count() == 0
          and page.evaluate("window.__calls.length") == before and page.locator('.cxm-label-suggest').count() > 0)
    page.close()

    # 요청 중에 열고 닫은 대화를 늦은 응답이 되살리지 않아야 한다.
    page = open_page(browser, errors)
    page.evaluate("window.__hold = true")
    page.add_script_tag(content=SCRIPT)
    page.clock.run_for(1500)
    item(page, 1).evaluate("e => e.dataset.appActionSidebarThreadSelected = 'true'")
    item(page, 1).evaluate("e => e.dataset.appActionSidebarThreadSelected = 'false'")
    item(page, 8).evaluate("e => e.style.display = 'flex'")
    page.clock.run_for(1500)
    page.evaluate("window.__hold = false; window.__pending.splice(0).forEach(f => f())")
    check("늦은 응답은 열었던 대화 표시를 되살리지 않음", item(page, 1).locator('.cxm-thread-status').count() == 0
          and item(page, 2).locator('.cxm-thread-status').count() == 1)
    page.clock.run_for(1500)
    check("요청 중 새로 보인 행도 기존 응답 후 스캔", item(page, 8).locator('.cxm-thread-status').count() == 1)
    page.evaluate("window.__hold = true")
    page.clock.run_for(120000)
    page.evaluate("window.__cxmThreadStatus.destroy(); window.__hold=false; window.__pending.splice(0).forEach(f => f())")
    check("destroy 이후 늦은 응답도 표시를 만들지 않음", page.locator('.cxm-thread-status').count() == 0)
    page.close()

    page = open_page(browser, errors)
    page.evaluate("window.__fail = true")
    page.add_script_tag(content=SCRIPT)
    page.clock.run_for(1500)
    check("분류기 실패 시 조용히 표시 없음", page.locator('.cxm-thread-status').count() == 0)
    page.evaluate("window.__fail = false")
    page.clock.run_for(120000)
    check("분류기 회복 후 다음 스캔에서 표시", item(page, 1).locator('.cxm-thread-status').count() == 1)
    check("페이지 오류 없음", not errors)
    browser.close()

print("\n결과: 모두 통과")
