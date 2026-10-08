"""대화 라벨 추천 칩 검사 (labels/label-suggest.js). 가짜 왼쪽 목록과 가짜 추천을 쓴다.

실행: python tests/test_label_suggest.py   (설치된 Chrome 을 headless 로 사용)
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
U = lambda n: f"0000000{n}-0000-4000-8000-00000000000{n}"

ROWS = "".join(
    f'<div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:{U(n)}" '
    f'data-app-action-sidebar-thread-kind="local" data-app-action-sidebar-thread-title="대화 {n}" onclick="window.__navigated = {n}">'
    f'<span class="cdx-label">{badge}</span><span>대화 {n}</span></div>'
    for n, badge in [(1, "＋"), (2, "＋"), (3, "개발"), (4, "＋"), (5, "＋"), (6, "＋"), (7, "＋")])
HTML = f'<!doctype html><html><head><meta charset="utf-8"></head><body><aside>{ROWS}</aside></body></html>'

MOCKS = f"""
window.__calls = []; window.__assigned = [];
const SUGGEST = {{ '{U(1)}': {{ labelId: 'dev', confidence: 0.91 }}, '{U(2)}': {{ labelId: 'knowhow', confidence: 0.85 }},
                   '{U(3)}': {{ labelId: 'dev', confidence: 0.99 }}, '{U(6)}': {{ labelId: 'dev', confidence: 0.88 }},
                   '{U(5)}': {{ labelId: 'knowhow', confidence: 0.45, confident: false }} }};
window.codexLabels = {{
  read: async () => ({{ config: {{ labels: [{{ id: 'dev', name: '개발', backgroundColor: '#f87171', enabled: true }},
                                       {{ id: 'knowhow', name: '노하우', backgroundColor: '#111111', enabled: true }}] }}, assignments: {{}} }}),
  onChanged: (fn) => {{ window.__changed = fn; return () => {{}}; }},
  assign: async (key, id, kind) => {{
    window.__assigned.push([key, id, kind]);
    window.__snapshot.categoryAssignments[key] = id;
    window.__changed();
    return window.__snapshot;
  }},
  labelScores: async (id) => ({{ dev: 0.62, knowhow: 0.31 }}),
  labelSuggest: async (ids, titles) => {{ window.__calls.push(ids); (window.__titles ||= []).push(titles); return Object.fromEntries(ids.filter(i => SUGGEST[i]).map(i => [i, SUGGEST[i]])); }},
}};
window.__initialRead = window.codexLabels.read;
window.codexLabels.read = async () => (window.__snapshot ||= {{
  ...await window.__initialRead(), categoryAssignments: {{}}
}});
"""

ok = True
def check(name, cond, extra=""):
    global ok
    ok &= bool(cond)
    print(("✔ " if cond else "✘ ") + name, extra)


def chips(page):
    return page.evaluate("[...document.querySelectorAll('.cxm-label-suggest')].map(c => c.closest('[data-app-action-sidebar-thread-row]').dataset.appActionSidebarThreadTitle + ':' + c.textContent)")


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    page = b.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # 저장소(localStorage)를 쓰려면 실제 주소가 필요해서 가짜 주소로 띄운다
    page.route("https://codex.test/", lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=HTML))
    page.goto("https://codex.test/")
    page.add_script_tag(content=MOCKS)
    page.add_script_tag(content=(ROOT / "labels/common.js").read_text(encoding="utf-8"))
    page.add_script_tag(content=(ROOT / "labels/label-suggest.js").read_text(encoding="utf-8"))
    page.wait_for_timeout(2500)

    c = chips(page)
    check("라벨 없는 대화에 추천 칩 + 추천도 %", "대화 1:개발?91%" in c and "대화 2:노하우?85%" in c and "대화 6:개발?88%" in c, c)
    check("이미 라벨이 있는 대화(3)·추천 없는 대화(4,7)에는 칩 없음", not any(x.startswith(("대화 3", "대화 4", "대화 7")) for x in c))
    check("확신이 낮으면 회색 '?'와 가장 높은 확신도", "대화 5:?45%" in c
          and "'노하우' 45%" in page.get_attribute("[data-app-action-sidebar-thread-title='대화 5'] .cxm-label-suggest", "title"), c)
    # vendor/renderer.js 처럼 배지 클릭은 캡처 단계에서 가로채 메뉴를 연다 (대화로 이동하지 않음)
    page.evaluate("""() => document.addEventListener('click', (e) => { const b = e.target.closest?.('.cdx-label');
      if (!b || b.closest('[data-app-action-sidebar-thread-title="대화 4"]')) return;
      e.stopImmediatePropagation(); window.__menuOpened = Number(b.closest('[data-app-action-sidebar-thread-row]').dataset.appActionSidebarThreadTitle.split(' ')[1]); }, true)""")
    page.locator("[data-app-action-sidebar-thread-row]:has-text('대화 5') .cxm-label-suggest").click()
    page.wait_for_timeout(200)
    check("낮은 확신 칩 클릭 → 지정하지 않고 라벨 메뉴 열기", page.evaluate("window.__menuOpened") == 5
          and page.evaluate("window.__assigned") == [] and page.evaluate("window.__navigated") is None)
    calls = page.evaluate("window.__calls")
    check("한 번에 5개 이하로 묻고, 라벨 있는 대화는 묻지 않음", all(len(x) <= 5 for x in calls) and U(3) not in sum(calls, []), calls)

    page.locator(".cxm-label-suggest").first.click()
    page.wait_for_timeout(200)
    check("칩 클릭 → 대화로 이동하지 않음", page.evaluate("window.__navigated") is None)
    check("칩 클릭 → 올바른 열쇠로 카테고리 지정", page.evaluate("window.__assigned") == [[f"thread:local:local:local:{U(1)}", "dev", "category"]],
          page.evaluate("window.__assigned"))
    check("지정한 칩은 사라짐", not any(x.startswith("대화 1") for x in chips(page)))
    check("추천 하나를 적용해도 다른 추천 버튼 유지", all(any(x.startswith(f"대화 {n}:") for x in chips(page)) for n in (2, 5, 6)), chips(page))
    calls_after_assignment = len(page.evaluate("window.__calls"))
    page.evaluate("window.__snapshot.assignments['unrelated-thread'] = 'completed'; window.__changed()")
    page.wait_for_timeout(200)
    check("진행 상태 변경도 다른 추천을 초기화하지 않음", all(any(x.startswith(f"대화 {n}:") for x in chips(page)) for n in (2, 5, 6)), chips(page))
    check("라벨 적용 후 기존 추천을 다시 요청하지 않음", len(page.evaluate("window.__calls")) == calls_after_assignment)

    page.locator("[data-app-action-sidebar-thread-row]:has-text('대화 2') .cxm-label-suggest").click(button="right")
    page.wait_for_timeout(200)
    page.evaluate("document.body.append(document.createElement('div'))")   # 목록 변경 → 다시 맞추기
    page.wait_for_timeout(2000)
    check("오른쪽 클릭 → 숨김, 목록이 바뀌어도 다시 안 뜸", not any(x.startswith("대화 2") for x in chips(page)), chips(page))
    check("숨긴 대화는 저장됨", U(2) in page.evaluate("localStorage.getItem('cxm-label-suggest-dismissed') || ''"))

    page.evaluate("document.querySelector('[data-app-action-sidebar-thread-title=\"대화 6\"] .cdx-label').textContent = '노하우'")
    page.wait_for_timeout(600)
    check("다른 방법으로 라벨이 붙으면 칩 제거", not any(x.startswith("대화 6") for x in chips(page)))
    # 라벨 배지를 눌러 직접 고를 때: 메뉴(vendor/renderer.js 와 같은 모양)의 분류 라벨마다 확신 %
    page.evaluate("""() => {
      const badge = document.querySelector('[data-app-action-sidebar-thread-title="대화 4"] .cdx-label');
      badge.addEventListener('click', () => {
        const menu = document.createElement('div'); menu.id = 'cdx-label-menu'; menu.role = 'menu';
        for (const name of ['개발', '노하우', '라벨 해제']) { const b = document.createElement('button'); b.role = 'menuitem';
          const dot = document.createElement('span'); dot.className = 'swatch'; b.append(dot, document.createTextNode(name)); menu.append(b); }
        document.body.append(menu);
      });
    }""")
    page.locator("[data-app-action-sidebar-thread-row]:has-text('대화 4') .cdx-label").click()
    page.wait_for_timeout(300)
    scores = page.evaluate("[...document.querySelectorAll('#cdx-label-menu button')].map(b => b.textContent)")
    check("라벨 메뉴에 분류 라벨별 확신 %", scores == ["개발62%", "노하우31%", "라벨 해제"], scores)
    check("가장 높은 라벨 강조", page.evaluate("document.querySelector('#cdx-label-menu .cxm-label-top')?.textContent") == "개발62%")
    page.evaluate("document.getElementById('cdx-label-menu').remove()")

    calls_before = len(page.evaluate("window.__calls"))
    page.evaluate("window.dispatchEvent(new Event('cxm:auto-refresh'))")
    page.wait_for_timeout(2500)   # 칩을 지우는 변경으로 목록 감시의 1.5초 대기가 다시 시작될 수 있음
    check("새로 고침 이벤트 → 다시 묻기", len(page.evaluate("window.__calls")) > calls_before, page.evaluate("window.__calls"))
    titles = page.evaluate("window.__titles")
    check("제목도 함께 보냄 (클라우드 대화용)", bool(titles) and titles[0].get(U(1)) == "대화 1", titles[:1])
    calls_before = len(page.evaluate("window.__calls"))
    page.evaluate("window.__snapshot.config.labels[1].name = '변경된 분류'; window.__changed()")
    page.wait_for_timeout(2500)
    check("분류 설정 변경은 기존 추천을 갱신함", len(page.evaluate("window.__calls")) > calls_before and "대화 5:?45%" in chips(page), chips(page))
    check("페이지 오류 없음", not errors, errors[:3])
    b.close()

print("\n결과:", "모두 통과" if ok else "실패 있음")
sys.exit(0 if ok else 1)
