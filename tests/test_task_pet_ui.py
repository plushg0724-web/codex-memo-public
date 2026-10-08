"""Click-only task pet UI regression, using a real headless Chrome and stub read API.

Run: python tests/test_task_pet_ui.py
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
SCRIPT = (ROOT / "labels/task-pet.js").read_text(encoding="utf-8")
THREADS = (ROOT / "labels/thread-open.js").read_text(encoding="utf-8")
UUID = "00000001-0000-4000-8000-000000000001"
OTHER_UUID = "00000002-0000-4000-8000-000000000002"
CURRENT_UUID = "00000003-0000-4000-8000-000000000003"
HTML = f"""<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="root"><main id="app">
<aside class="sidebar-navigation"><div id="row" data-app-action-sidebar-thread-row
 data-app-action-sidebar-thread-id="local:{UUID}" data-app-action-sidebar-thread-selected="false"
 style="width:240px;height:32px" onclick="window.__navigated='row';window.__selectThread('{UUID}')">테스트 대화</div>
<div id="current" data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:{CURRENT_UUID}"
 data-app-action-sidebar-thread-selected="true">현재 대화</div></aside>
<textarea id="composer" aria-label="메시지 입력" style="position:fixed;bottom:10px;left:10px;width:calc(100% - 20px);height:80px"></textarea>
</main></div>
</body></html>"""
MOCKS = f"""() => {{
  window.__cxmTaskPetAuto = false; sessionStorage.removeItem('cxm-task-pet-result'); localStorage.removeItem('cxm-task-pet-skipped');
  window.__calls = []; window.__pending = []; window.__mode = 'ok';
  window.__reads = 0; window.__readMode = 'ok'; window.__readPending = [];
  window.__snapshot = {{config:{{labels:[{{id:'in_progress',name:'진행 중',enabled:true}}]}},
    assignments:{{'thread:local:local:local:{UUID}':'in_progress'}},categoryAssignments:{{}}}};
  window.__memoData = [{{id:'memo1',category:'todo',conv:'{UUID}',note:'기록한 할 일'}}];
  window.__labelSubs = new Set(); window.__memoSubs = new Set(); window.__navigated = null;
  window.__selectThread = id => {{
    const rows = [...document.querySelectorAll('[data-app-action-sidebar-thread-row]')];
    let target = rows.find(row => row.dataset.appActionSidebarThreadId === 'local:' + id);
    if (!target) {{ target = document.getElementById('current'); target.dataset.appActionSidebarThreadId = 'local:' + id; }}
    rows.forEach(row => row.dataset.appActionSidebarThreadSelected = String(row === target));
  }};
  window.__installRouter = (mode = 'sync', source = 'props', seed = 'app') => {{
    window.__routerCalls = []; window.__navPending = [];
    window.__router = {{state: {{location: {{pathname: '/local/{CURRENT_UUID}'}}}}, navigate: path => {{
      window.__routerCalls.push(path);
      if (mode === 'reject') return Promise.reject(new Error('navigation failed'));
      if (mode === 'noop') return Promise.resolve();
      const complete = () => {{window.__router.state.location.pathname = path;}};
      if (mode === 'defer') return new Promise(resolve => window.__navPending.push(() => {{complete(); resolve();}}));
      complete(); return Promise.resolve();
    }}}};
    let fiber = {{memoizedProps: source === 'props' ? {{value: {{router: window.__router}}}} : {{}}}};
    if (source === 'context') {{
      let context = {{memoizedValue: {{router: window.__router}}, next: null}};
      for (let i = 0; i < 12; i++) context = {{memoizedValue: {{unrelated: true}}, next: context}};
      fiber.dependencies = {{firstContext: context}};
    }}
    for (let i = 0; i < 90; i++) fiber = {{memoizedProps: {{}}, return: fiber}};
    document.getElementById(seed).__reactFiber$test = fiber;
  }};
  window.__item = (title = '이어 할 작업', id = 'thread:{UUID}') => ({{
    id, threadId: '{UUID}', title, state: 'progress', badge: '진행', action: '남은 검토를 이어가세요.',
    quote: '테스트는 마쳤고 배포 확인이 남았습니다.', quoteKind: 'agent', labelName: '진행',
    updatedAt: Math.floor(Date.now() / 1000) - 7200
  }});
  window.__result = (title = '이어 할 작업') => ({{status: 'ok', checkedAt: '2026-10-06T04:30:00Z',
    totalCandidates: 4, items: [window.__item(title)]}});
  window.codexLabels = {{
    read: async () => {{window.__reads++; if(window.__readMode==='defer') return new Promise(r=>window.__readPending.push(r));
      if(window.__readMode==='throw') throw Error('read failed'); return structuredClone(window.__snapshot);}},
    taskPetSuggest: async (request) => {{
      window.__calls.push(request);
      if (window.__mode === 'defer') return new Promise(resolve => window.__pending.push(resolve));
      if (window.__mode === 'throw') throw new Error('private backend plumbing');
      if (window.__mode === 'ok') return window.__result();
      if (window.__mode === 'custom') return window.__custom;
      return {{status: window.__mode, checkedAt: '2026-10-06T04:30:00Z', items: []}};
    }},
    onChanged: fn => {{ window.__labelSubs.add(fn); return () => window.__labelSubs.delete(fn); }}
  }};
  window.__codexMemo = {{list:()=>structuredClone(window.__memoData),subscribe: fn => {{window.__memoSubs.add(fn); return () => window.__memoSubs.delete(fn);}}}};
  window.__cxmThreadActions = {{rowOf: id => id === '{UUID}' ? document.getElementById('row') : null}};
  window.__change = () => window.__labelSubs.forEach(fn => fn());
  window.__sameMemos = () => window.__memoSubs.forEach(fn => fn(structuredClone(window.__memoData)));
  window.__memos = () => {{window.__memoData[0].note+=' 변경';window.__sameMemos();}};
}}"""


def check(name, condition):
    assert condition, name
    print("✔", name)


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1024, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("https://codex.test/**", lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=HTML))
    page.goto("https://codex.test/index.html")
    page.evaluate(MOCKS)
    page.add_script_tag(content=(ROOT / "labels/common.js").read_text(encoding="utf-8"))
    page.add_script_tag(content=THREADS)
    page.add_script_tag(content=SCRIPT)
    pet = page.locator("#cxm-task-pet")
    launcher = page.get_by_role("button", name="메모 펫 · 다음 할 일 추천 열기")
    panel = page.get_by_role("dialog", name="메모 펫의 다음 할 일")
    refresh = page.get_by_role("button", name="추천 새로고침")
    check("mount makes no recommendation call", page.evaluate("window.__calls.length") == 0)
    expect(pet).to_have_attribute("data-phase", "idle")
    check("v9 fast-first UI is active", page.evaluate("window.__cxmTaskPet.version") == 9)
    check("no restore link before any skip", page.locator(".cxm-pet-restore").is_hidden())

    page.evaluate("window.__mode = 'defer'")
    launcher.focus()
    page.keyboard.press("Enter")
    expect(panel).to_be_visible()
    expect(panel).to_have_attribute("aria-busy", "true")
    expect(pet).to_have_attribute("data-phase", "loading")
    expect(refresh).to_be_disabled()
    check("keyboard opens and passes current thread", page.evaluate("window.__calls") == [{"currentThreadId": CURRENT_UUID, "dismissedIds": [], "dismissed": {}, "advice": False}])
    page.evaluate("window.__pending.shift()(window.__result())")
    expect(page.locator(".cxm-pet-card h3")).to_have_text("이어 할 작업")
    expect(panel).to_have_attribute("aria-busy", "false")
    expect(pet).to_have_attribute("data-phase", "ready")
    expect(page.locator(".cxm-pet-open").first).to_be_focused()
    check("rules stay folded until asked", page.locator(".cxm-pet-rules").is_hidden())
    page.get_by_role("button", name="추천 기준").click()
    check("criteria scope, quoted sentence and age are explicit", "대화의 마지막 답변·진행 상태·할 일 메모 기준" in panel.inner_text()
          and "테스트는 마쳤고 배포 확인이 남았습니다." in page.locator(".cxm-pet-quote").inner_text()
          and page.locator(".cxm-pet-quote-who").inner_text() == "Codex" and "2시간 전" in panel.inner_text())
    check("label name equal to the badge is not repeated", page.locator(".cxm-pet-card .cxm-pet-meta").inner_text().count("진행") == 1)
    check("recommendation order is disclosed", page.get_by_role("button", name="추천 기준").get_attribute("aria-expanded") == "true"
          and "Codex가 답을 기다리는 대화" in page.locator(".cxm-pet-rules").text_content())
    page.keyboard.press("Escape")
    expect(panel).to_be_hidden()
    expect(launcher).to_be_focused()
    launcher.click()
    check("opening cached panel never repeats inference", page.evaluate("window.__calls.length") == 1)
    launcher.click()
    expect(panel).to_be_hidden()
    launcher.click()

    page.evaluate("window.__mode = 'ok'")
    refresh.click()
    expect(refresh).to_be_enabled()
    check("refresh explicitly repeats inference", page.evaluate("window.__calls.length") == 2)
    page.locator(".cxm-pet-open").first.click()
    check("visible sidebar row navigation reused", page.evaluate("window.__navigated") == "row")
    expect(panel).to_be_hidden()
    page.evaluate(f"window.__selectThread('{CURRENT_UUID}')")
    launcher.click()

    # Changes invalidate cached recommendations without spending an inference.
    before = page.evaluate("window.__calls.length")
    page.evaluate("window.__change(); window.__memos()")
    expect(page.locator(".cxm-pet-stale")).to_be_visible()
    check("memo/label changes mark stale without a model call", page.evaluate("window.__calls.length") == before)
    check("stale cards retained for context", page.locator(".cxm-pet-card").count() == 1)
    refresh.click()
    expect(page.locator(".cxm-pet-stale")).to_be_hidden()

    # A change while pending must discard the old result and restore retry.
    page.evaluate("window.__mode='defer'")
    refresh.click()
    page.evaluate("window.__memos(); window.__pending.shift()(window.__result('오래된 결과'))")
    expect(refresh).to_be_enabled()
    expect(page.locator(".cxm-pet-card h3")).to_have_text("이어 할 작업")
    check("source change discards in-flight stale result", page.evaluate("window.__cxmTaskPet.stale"))

    # Two independent promises returning in reverse order cannot overwrite latest.
    page.evaluate("() => { window.__cxmTaskPet.refresh(); }")
    page.wait_for_function("window.__pending.length===1")
    page.evaluate("() => { window.__cxmTaskPet.refresh(); }")
    page.wait_for_function("window.__pending.length===2")
    page.evaluate("window.__pending[1](window.__result('최신 결과'))")
    expect(page.locator(".cxm-pet-card h3")).to_have_text("최신 결과")
    page.evaluate("window.__pending[0](window.__result('늦은 이전 결과')); window.__pending=[]")
    expect(page.locator(".cxm-pet-card h3")).to_have_text("최신 결과")
    check("out-of-order result ignored", True)

    # Switching current chat invalidates requests; cached cards exclude the new chat.
    refresh.click()
    page.evaluate("document.getElementById('current').dataset.appActionSidebarThreadSelected='false';document.getElementById('row').dataset.appActionSidebarThreadSelected='true'")
    page.evaluate("window.__pending.shift()(window.__result('이동 전 요청'))")
    expect(page.locator(".cxm-pet-card")).to_have_count(0)
    expect(page.locator(".cxm-pet-stale")).to_be_visible()
    expect(refresh).to_be_enabled()
    check("current-chat switch discards pending and cached self recommendation", True)
    page.keyboard.press("Escape")
    page.evaluate("document.getElementById('current').dataset.appActionSidebarThreadSelected='true';document.getElementById('row').dataset.appActionSidebarThreadSelected='false'")
    before = page.evaluate("window.__calls.length")
    launcher.click()
    page.wait_for_function("window.__pending.length===1")
    check("opening a stale pet revalidates at once", page.evaluate("window.__calls.length") == before + 1
          and page.locator(".cxm-pet-stale").is_hidden())
    page.evaluate("window.__pending.shift()(window.__result())")
    expect(page.locator(".cxm-pet-card h3")).to_have_text("이어 할 작업")

    # A remote sidebar row with the same UUID must never receive navigation.
    page.evaluate("window.__mode='ok';window.__navigated=null;document.getElementById('row').dataset.appActionSidebarThreadHostId='remote-host'")
    refresh.click()
    page.locator(".cxm-pet-open").first.click()
    check("remote same-UUID row never clicked", page.evaluate("window.__navigated") is None)
    expect(panel).to_be_visible()
    expect(page.locator(".cxm-pet-live")).to_contain_text("왼쪽 목록")
    page.evaluate("document.getElementById('current').dataset.appActionSidebarThreadHostId='remote-host'")
    refresh.click()
    check("selected remote row is not sent as a local current id", page.evaluate("window.__calls.at(-1).currentThreadId") is None)
    page.evaluate("delete document.getElementById('row').dataset.appActionSidebarThreadHostId;delete document.getElementById('current').dataset.appActionSidebarThreadHostId")

    page.evaluate("window.__mode='custom';window.__custom={status:'ok',items:[],totalCandidates:4,message:'지금 권할 일을 고르지 않았습니다.'}")
    refresh.click()
    expect(page.locator(".cxm-pet-live")).to_have_text("지금 권할 일을 고르지 않았습니다.")
    check("model abstention preserves reason instead of claiming no source candidates", True)

    # All supplied strings are text, including source fields and low confidence.
    page.evaluate("""() => {
      const x = '<img src=x onerror="window.__xss=1">';
      window.__custom = window.__result();
      window.__custom.items = [0,1,2,3].map(n => ({...window.__item(x, 'memo:x'+n), action:x, badge:x, quote:x, labelName:x,
        quoteKind:'memo', state:'ask'})); window.__mode='custom';
    }""")
    refresh.click()
    expect(page.locator(".cxm-pet-card")).to_have_count(3)
    check("max three and untrusted content stays inert", page.locator(".cxm-pet-card img").count() == 0 and not page.evaluate("window.__xss"))
    check("memo quote source and urgent badge shown", page.locator(".cxm-pet-quote-who").first.inner_text() == "메모"
          and page.locator(".cxm-pet-card[data-urgent]").count() == 3)
    page.evaluate("window.__custom.limit=4;window.__custom.items.forEach(item=>{item.adviceModel='gpt-6-luna';item.adviceEffort='high';})")
    refresh.click()
    expect(page.locator('.cxm-pet-card')).to_have_count(4)
    expect(page.locator('.cxm-pet-card').first).to_contain_text('gpt-6-luna · high 설명')
    check('configured count and actual advice model are visible', True)
    page.evaluate('delete window.__custom.limit')
    refresh.click()
    expect(page.locator('.cxm-pet-card')).to_have_count(3)
    page.get_by_role("button", name="이번엔 넘기기", exact=True).first.click()
    expect(page.locator(".cxm-pet-card[data-id='memo:x0']")).to_have_count(0)
    refresh.click()
    check("dismiss only passes client exclusion to read API", page.evaluate("window.__calls.at(-1).dismissedIds") == ["memo:x0"])
    restore = page.get_by_role("button", name="넘긴 후보 1개 다시 보기")
    expect(restore).to_be_visible()
    restore.click()
    expect(page.locator(".cxm-pet-card[data-id='memo:x0']")).to_have_count(1)
    expect(restore).to_be_hidden()
    check("restoring skipped candidates clears the exclusion and refreshes",
          page.evaluate("window.__calls.at(-1).dismissedIds") == [] and page.evaluate("localStorage.getItem('cxm-task-pet-skipped')") is None)

    # Closing during a slow request: the pet signals when the answer is ready.
    page.evaluate("window.__mode='defer'")
    refresh.click()
    expect(pet).to_have_attribute("data-phase", "loading")
    page.keyboard.press("Escape")
    expect(panel).to_be_hidden()
    badge = page.locator(".cxm-pet-count")
    page.evaluate("window.__pending.shift()(window.__result('닫힌 동안 준비'))")
    expect(badge).to_be_visible()
    expect(badge).to_have_text("1")
    expect(badge).to_have_attribute("data-new", "")
    expect(launcher).to_have_attribute("aria-label", "메모 펫 · 다음 할 일 추천 열기 · 할 일 1개 · 추천 준비됨")
    launcher.click()
    expect(page.locator(".cxm-pet-card h3")).to_have_text("닫힌 동안 준비")
    check("result ready while closed is signalled and cleared on open", badge.get_attribute("data-new") is None)
    page.evaluate("window.__change(); window.__memos()")
    expect(badge).to_have_attribute("data-kind", "stale")
    check("source change shows the stale notice without repeating it in the status line",
          page.locator(".cxm-pet-stale").is_visible() and "바뀌었" not in page.locator(".cxm-pet-live").inner_text())
    page.keyboard.press("Escape")
    launcher.click()
    page.wait_for_function("window.__pending.length===1")
    check("stale cards stay visible while the reopened pet rechecks", page.locator(".cxm-pet-card").count() == 1
          and "다시 확인 중" in page.locator(".cxm-pet-time").inner_text())
    page.evaluate("window.__pending.shift()(window.__result('닫힌 동안 준비'))")
    expect(badge).to_have_attribute("data-kind", "normal")

    # An existing actual Codex link remains usable without a discoverable router.
    page.evaluate(f"""() => {{
      window.__mode='custom'; window.__custom=window.__result('목록 밖 대화');
      window.__custom.items[0].threadId='{OTHER_UUID}';
    }}""")
    refresh.click()
    page.locator(".cxm-pet-open").first.click()
    expect(page.locator(".cxm-pet-live")).to_contain_text("왼쪽 목록")
    page.evaluate(f"""() => {{const a=document.createElement('a'); a.href='/local/{OTHER_UUID}'; a.textContent='앱 대화 링크';
      a.onclick=e=>{{e.preventDefault();window.__navigated='anchor';window.__selectThread('{OTHER_UUID}');}}; document.body.append(a);}}""")
    page.locator(".cxm-pet-open").first.click()
    check("verified existing route link is used", page.evaluate("window.__navigated") == "anchor")
    expect(panel).to_be_hidden()
    page.evaluate(f"document.getElementById('current').dataset.appActionSidebarThreadId='local:{CURRENT_UUID}';window.__selectThread('{CURRENT_UUID}')")
    launcher.click()

    for status, message in [("empty", "지금 손댈 대화가 없어요"), ("source_error", "메모와 대화 목록을 읽지 못했어요"), ("unavailable", "지금은 추천 도우미"), ("throw", "지금은 추천 도우미")]:
        page.evaluate("mode => window.__mode=mode", status)
        refresh.click()
        expect(page.locator(".cxm-pet-live")).to_contain_text(message)
        expect(page.locator(".cxm-pet-card")).to_have_count(0)
    check("empty/source failure/unavailability/exception remain distinct", True)

    page.evaluate("delete window.codexLabels.taskPetSuggest")
    refresh.click()
    expect(pet).to_have_attribute("data-status", "unavailable")
    check("missing recommendation API has visible unavailable state", True)

    # Size stays inside viewport, leaves composer clear, supports app theme + motion.
    page.set_viewport_size({"width": 320, "height": 480})
    # Resize positioning runs in requestAnimationFrame; wait for its observable
    # result before measuring rather than reading the previous viewport layout.
    page.wait_for_function("""() => {
      const panel=document.getElementById('cxm-task-pet-panel'), composer=document.getElementById('composer');
      if(!panel?.getClientRects().length||!composer)return false;
      const bounds=panel.getBoundingClientRect(), input=composer.getBoundingClientRect();
      return bounds.x>=0&&bounds.right<=innerWidth&&bounds.bottom<input.y;
    }""", timeout=5000)
    bounds = panel.bounding_box()
    composer = page.locator("#composer").bounding_box()
    check("narrow popover within viewport and above composer", bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= 320 and bounds["y"] + bounds["height"] < composer["y"])
    page.emulate_media(reduced_motion="reduce", color_scheme="dark")
    check("reduced-motion animation disabled", panel.evaluate("el => getComputedStyle(el).animationName") == "none")
    check("dark theme active", pet.evaluate("el => getComputedStyle(el).colorScheme") == "dark")
    token = "name => getComputedStyle(document.getElementById('cxm-task-pet')).getPropertyValue(name).trim()"
    check("OS dark recolors warning tokens", page.evaluate(token, "--pet-warn-bg") == "#4b3c26")
    page.emulate_media(color_scheme="light")
    page.evaluate("document.documentElement.classList.add('dark')")
    check("app dark class recolors warning and confidence tokens even on light OS",
          page.evaluate(token, "--pet-warn-bg") == "#4b3c26" and page.evaluate(token, "--pet-warn-ink") == "#ecd6ae")
    page.evaluate("document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')")
    page.emulate_media(color_scheme="dark")
    check("app light class wins over OS dark", page.evaluate(token, "--pet-warn-bg") == "#fff1d6"
          and pet.evaluate("el => getComputedStyle(el).colorScheme") == "light")
    page.evaluate("document.documentElement.classList.remove('light')")
    page.locator("#composer").focus()
    page.keyboard.type("typing remains available")
    expect(panel).to_be_hidden()
    expect(page.locator("#composer")).to_have_value("typing remains available")
    check("typing focus closes non-modal panel", True)

    # Same-version repeat is a no-op; upgraded reinjection cleans subscriptions.
    page.add_script_tag(content=SCRIPT)
    expect(pet).to_have_count(1)
    check("same-version reinjection does not duplicate subscribers", page.evaluate("[window.__labelSubs.size,window.__memoSubs.size]") == [1, 1])
    page.evaluate("window.__cxmTaskPet.version=0")
    page.add_script_tag(content=SCRIPT)
    expect(pet).to_have_count(1)
    check("replacement reinjection cleans subscriptions", page.evaluate("[window.__labelSubs.size,window.__memoSubs.size]") == [1, 1])
    launcher.click()
    page.get_by_role("button", name="잠시 숨기기 · 30분").click()
    expect(launcher).to_be_hidden()
    wake = page.get_by_role("button", name="메모 펫 다시 보이기")
    expect(wake).to_be_visible()
    check("hidden pet leaves a small handle instead of vanishing", page.evaluate("window.__cxmTaskPet.hidden"))
    remaining = page.evaluate("Number(sessionStorage.getItem('cxm-task-pet-hidden-until'))-Date.now()")
    check("hide records reversible 30-minute tab state", 1790000 < remaining <= 1800000)
    page.evaluate("window.__cxmTaskPet.version=0")
    page.add_script_tag(content=SCRIPT)
    expect(launcher).to_be_hidden()
    page.evaluate("window.__cxmTaskPet.show()")
    expect(launcher).to_be_visible()
    check("show reverses hiding without inference", page.evaluate("sessionStorage.getItem('cxm-task-pet-hidden-until')") is None)

    # Existing timeout wakes without fetching, including after script replacement.
    before = page.evaluate("window.__calls.length")
    page.evaluate("sessionStorage.setItem('cxm-task-pet-hidden-until',String(Date.now()+180));window.__cxmTaskPet.version=0")
    page.add_script_tag(content=SCRIPT)
    expect(launcher).to_be_hidden()
    expect(launcher).to_be_visible(timeout=2000)
    check("wake timer only restores launcher", page.evaluate("window.__calls.length") == before)

    # The handle brings the pet back at once, with keyboard focus on the pet.
    page.set_viewport_size({"width": 1024, "height": 900})
    launcher.click()
    page.get_by_role("button", name="잠시 숨기기 · 30분").click()
    wake.focus()
    page.keyboard.press("Enter")
    expect(launcher).to_be_visible()
    expect(wake).to_be_hidden()
    expect(launcher).to_be_focused()
    check("handle restores the pet and clears the hide timer", page.evaluate("sessionStorage.getItem('cxm-task-pet-hidden-until')") is None
          and not page.evaluate("window.__cxmTaskPet.hidden"))

    # Drag moves the pet without opening the panel, and the position is remembered.
    calls = page.evaluate("window.__calls.length")
    box = launcher.bounding_box()
    page.mouse.move(box["x"] + 30, box["y"] + 30)
    page.mouse.down()
    page.mouse.move(box["x"] - 300, box["y"] + 150, steps=8)
    page.mouse.move(60, box["y"] + 200, steps=8)
    page.mouse.up()
    expect(panel).to_be_hidden()
    moved = launcher.bounding_box()
    check("drag moves the pet and does not open the panel", moved["x"] < 100 and moved["y"] > box["y"] + 150
          and page.evaluate("window.__calls.length") == calls)
    saved = page.evaluate("JSON.parse(localStorage.getItem('cxm-task-pet-position'))")
    check("dragged position is saved", saved and saved["right"] > 800)
    launcher.click()
    expect(panel).to_be_visible()
    expect(page.get_by_role("button", name="펫을 원래 위치로 되돌리기")).to_be_visible()
    expect(panel).to_have_attribute("data-side", "left")
    pbox = panel.bounding_box()
    check("panel opens toward the screen when the pet sits on the left", pbox["x"] >= 0 and pbox["x"] + pbox["width"] <= 1024)
    page.keyboard.press("Escape")

    # Alt+arrow moves by keyboard; the position survives reinjection; reset returns home.
    launcher.focus()
    before_x = launcher.bounding_box()["x"]
    page.keyboard.press("Alt+ArrowRight")
    check("Alt+arrow moves the pet 16px", abs(launcher.bounding_box()["x"] - before_x - 16) < 1.5)
    page.evaluate("window.__cxmTaskPet.version=0")
    page.add_script_tag(content=SCRIPT)
    check("position is restored after reinjection", abs(launcher.bounding_box()["x"] - before_x - 16) < 1.5)
    page.set_viewport_size({"width": 500, "height": 900})
    page.wait_for_function("() => { const r=document.querySelector('.cxm-pet-launcher').getBoundingClientRect(); return r.x >= 0 && r.x + r.width <= 500; }")
    lb = launcher.bounding_box()
    check("pet stays inside a narrower window", lb["x"] >= 0 and lb["x"] + lb["width"] <= 500)
    page.set_viewport_size({"width": 1024, "height": 900})
    launcher.click()
    page.get_by_role("button", name="펫을 원래 위치로 되돌리기").click()
    home_box = launcher.bounding_box()
    check("reset returns the pet to the top-right corner", home_box["x"] > 900 and home_box["y"] < 80
          and page.evaluate("localStorage.getItem('cxm-task-pet-position')") is None)
    page.keyboard.press("Escape")
    page.set_viewport_size({"width": 320, "height": 480})
    # Leave a fresh, never-requested pet for the checks below.
    page.evaluate("window.__cxmTaskPet.version=0")
    page.add_script_tag(content=SCRIPT)

    page.evaluate("() => { window.codexLabels.taskPetSuggest = () => new Promise(r=>window.__pending.push(r)); }")
    launcher.click()
    page.evaluate("document.getElementById('cxm-task-pet').remove()")
    expect(pet).to_have_count(0)
    page.evaluate("window.__pending.shift()(window.__result('분리된 결과'))")
    check("detached UI disposes subscribers and delayed callback", page.evaluate("[window.__labelSubs.size,window.__memoSubs.size,Boolean(window.__cxmTaskPet)]") == [0, 0, False])
    check("style removed on destroy", page.locator("#cxm-task-pet-style").count() == 0)

    for route in ["/hotkey-window", "/avatar-overlay"]:
        page.goto("https://codex.test/index.html?initialRoute=" + route)
        page.evaluate(MOCKS)
        page.add_script_tag(content=SCRIPT)
        expect(pet).to_have_count(0)
        check("auxiliary route ignored: " + route, page.evaluate("window.__calls.length") == 0)

    page.goto("https://codex.test/index.html")
    page.evaluate(MOCKS)
    page.evaluate("delete window.__codexMemo")
    page.evaluate("() => {" + SCRIPT + """
      window.__codexMemo = {list:()=>structuredClone(window.__memoData),subscribe: fn => {window.__memoSubs.add(fn);return ()=>window.__memoSubs.delete(fn);}};
    }""")
    check("same-task later memo API attached at microtask tail", page.evaluate("window.__memoSubs.size") == 1)
    launcher.click()
    page.evaluate("window.__memos()")
    expect(page.locator(".cxm-pet-stale")).to_be_visible()
    check("late memo subscription invalidates without another request", page.evaluate("window.__calls.length") == 1)
    page.evaluate("window.__cxmTaskPet.destroy();delete window.__codexMemo")
    page.add_script_tag(content=SCRIPT)
    check("initially absent memo API is safe", page.evaluate("window.__memoSubs.size") == 0)
    page.evaluate("""() => {
      window.__codexMemo = {list:()=>structuredClone(window.__memoData),subscribe: fn => {window.__memoSubs.add(fn);return ()=>window.__memoSubs.delete(fn);}};
    }""")
    launcher.click()
    check("opening lazily connects later memo API exactly once", page.evaluate("window.__memoSubs.size") == 1)
    page.evaluate("window.__memos()")
    expect(page.locator(".cxm-pet-stale")).to_be_visible()

    # Source signatures ignore delivery noise and fields unrelated to task choice.
    page.goto("https://codex.test/index.html")
    page.set_viewport_size({"width": 1024, "height": 900})
    page.evaluate(MOCKS)
    page.add_script_tag(content=SCRIPT)
    page.evaluate("window.__mode='defer'")
    launcher.click()
    page.wait_for_function("window.__pending.length===1")
    page.evaluate("""() => {
      window.__sameMemos();
      window.__memoData.push({id:'plain',category:'memo',note:'추천과 관계없는 기록'});window.__sameMemos();
      window.__snapshot.categoryAssignments.x='dev';
      window.__snapshot.config.labels[0].backgroundColor='#aabbcc';
      window.__snapshot.config.labels[0].kind='status';
      window.__snapshot.config.labels.push({id:'dev',name:'개발',kind:'category',enabled:true});
      window.__change();
    }""")
    expect(pet).to_have_attribute("data-phase", "loading")
    page.evaluate("window.__pending.shift()(window.__result())")
    expect(pet).to_have_attribute("data-phase", "ready")
    check("identical memo/category/color/default-kind notifications preserve pending recommendation", page.evaluate("window.__calls.length") == 1 and not page.evaluate("window.__cxmTaskPet.stale"))

    refresh.click()
    page.wait_for_function("window.__pending.length===1")
    page.evaluate("Object.keys(window.__snapshot.assignments).forEach(k=>window.__snapshot.assignments[k]='completed');window.__change()")
    expect(pet).to_have_attribute("data-phase", "stale")
    page.evaluate("window.__pending.shift()(window.__result('실제 상태 변경 전 후보'))")
    expect(page.locator(".cxm-pet-card h3")).to_have_text("이어 할 작업")
    check("real local status change invalidates pending response without inference", page.evaluate("window.__calls.length") == 2)

    page.evaluate("window.__mode='ok'")
    refresh.click()
    expect(pet).to_have_attribute("data-phase", "ready")
    page.evaluate("window.__snapshot.configError='broken';window.__change()")
    expect(pet).to_have_attribute("data-phase", "stale")
    check("config read error marks cached recommendations stale", True)
    page.evaluate("delete window.__snapshot.configError")
    refresh.click()
    expect(pet).to_have_attribute("data-phase", "ready")
    page.evaluate("window.__readMode='throw';window.__change()")
    expect(pet).to_have_attribute("data-phase", "stale")
    check("source read rejection invalidates without an unhandled promise", True)
    page.evaluate("window.__readMode='ok'")
    refresh.click()
    expect(pet).to_have_attribute("data-phase", "ready")
    page.evaluate("window.__memos()")
    expect(pet).to_have_attribute("data-phase", "stale")
    check("real todo edit still invalidates", True)
    refresh.click()
    expect(pet).to_have_attribute("data-phase", "ready")

    reads = page.evaluate("window.__reads")
    calls = page.evaluate("window.__calls.length")
    page.evaluate("window.__readMode='defer';for(let i=0;i<20;i++)window.__change()")
    page.wait_for_function("window.__readPending.length===1")
    check("burst label notifications share one active read", page.evaluate("window.__reads") == reads + 1)
    page.evaluate("for(let i=0;i<20;i++)window.__change();window.__readPending.shift()(structuredClone(window.__snapshot))")
    page.wait_for_function("window.__readPending.length===1")
    page.evaluate("window.__readPending.shift()(structuredClone(window.__snapshot))")
    expect(pet).to_have_attribute("data-phase", "ready")
    check("changes during read cause exactly one trailing read and no inference", page.evaluate("window.__reads") == reads + 2 and page.evaluate("window.__calls.length") == calls)

    # Old source reads cannot cancel a newer user request or establish its baseline.
    page.evaluate("window.__change()")
    page.wait_for_function("window.__readPending.length===1")
    page.evaluate("() => {window.__cxmTaskPet.refresh();}")
    page.evaluate("window.__readPending.shift()({configError:'obsolete source error'})")
    page.wait_for_function("window.__readPending.length===1")
    page.evaluate("window.__readMode='ok';window.__readPending.shift()(structuredClone(window.__snapshot))")
    expect(pet).to_have_attribute("data-phase", "ready")
    check("old async source result cannot stale a newer request", page.evaluate("window.__calls.length") == calls + 1 and not page.evaluate("window.__cxmTaskPet.stale"))

    # Measure the actual expensive call; closed panels should not inspect editors.
    page.evaluate("""() => {
      window.__measures=0; const input=document.getElementById('composer');
      const rect=input.getBoundingClientRect.bind(input);
      input.getBoundingClientRect=()=>{window.__measures++;return rect();};
    }""")
    page.keyboard.press("Escape")
    page.evaluate("for(let i=0;i<20;i++)window.dispatchEvent(new Event('resize'))")
    page.evaluate("() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")
    check("closed panel performs no composer layout measurements", page.evaluate("window.__measures") == 0)
    launcher.click()
    page.evaluate("window.__measures=0;for(let i=0;i<20;i++)window.dispatchEvent(new Event('resize'))")
    page.evaluate("() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")
    check("open panel coalesces resize measurements into one frame", page.evaluate("window.__measures") == 1)
    page.set_viewport_size({"width": 320, "height": 240})
    page.evaluate("() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")
    tiny_panel, tiny_input = panel.bounding_box(), page.locator("#composer").bounding_box()
    check("very low viewport keeps panel above typing area", tiny_panel and tiny_panel["y"] >= 0 and tiny_panel["y"] + tiny_panel["height"] < tiny_input["y"])
    page.set_viewport_size({"width": 1024, "height": 900})
    page.evaluate("window.__readMode='defer';window.__change()")
    page.wait_for_function("window.__readPending.length===1")
    page.evaluate("window.dispatchEvent(new Event('resize'));window.__cxmTaskPet.destroy();window.__readPending.shift()({configError:'late error'})")
    page.evaluate("() => new Promise(r=>requestAnimationFrame(r))")
    expect(pet).to_have_count(0)
    check("destroy cancels layout and makes pending source reads inert", page.evaluate("window.__labelSubs.size===0 && window.__memoSubs.size===0 && !window.__cxmTaskPet"))

    def reset_pet_page(setup=""):
        page.goto("https://codex.test/index.html")
        page.evaluate(MOCKS)
        if setup:
            page.evaluate(setup)
        page.add_script_tag(content=THREADS)
        page.add_script_tag(content=SCRIPT)
        launcher.click()
        expect(page.locator(".cxm-pet-card h3")).to_have_text("이어 할 작업")

    # The app router is in memory; catalog threads need not have a visible row.
    reset_pet_page("document.getElementById('row').remove();window.__installRouter('sync','props')")
    page.locator(".cxm-pet-open").first.click()
    expect(panel).to_be_hidden()
    check("missing row opens through router found 90 React parents above app root", page.evaluate("window.__routerCalls") == [f"/local/{UUID}"])
    check("router navigation preserves the app document", page.url == "https://codex.test/index.html" and page.evaluate("window.__navigated") is None)

    reset_pet_page("document.getElementById('row').hidden=true;window.__installRouter('defer','context','row')")
    page.locator(".cxm-pet-open").first.click()
    page.wait_for_function("window.__navPending.length===1")
    expect(panel).to_be_visible()
    expect(page.locator(".cxm-pet-open").first).to_be_disabled()
    check("hidden row discovers nested context router and waits for actual route change", page.evaluate("window.__routerCalls") == [f"/local/{UUID}"] and page.evaluate("window.__navigated") is None)
    page.evaluate("window.__navPending.shift()()")
    expect(panel).to_be_hidden()
    check("confirmed delayed route closes panel", page.evaluate("window.__router.state.location.pathname") == f"/local/{UUID}")

    reset_pet_page("document.getElementById('row').dataset.appActionSidebarThreadHostId='remote-host';window.__installRouter()")
    page.locator(".cxm-pet-open").first.click()
    expect(panel).to_be_hidden()
    check("same-UUID remote row is bypassed for validated local router path", page.evaluate("window.__navigated") is None and page.evaluate("window.__routerCalls") == [f"/local/{UUID}"])

    for navigation_mode in ["reject", "noop"]:
        reset_pet_page(f"document.getElementById('row').remove();window.__installRouter('{navigation_mode}')")
        page.locator(".cxm-pet-open").first.click()
        expect(page.locator(".cxm-pet-live")).to_contain_text("열리지", timeout=5000)
        expect(panel).to_be_visible()
        expect(page.locator(".cxm-pet-open").first).to_be_enabled()
        check("router " + navigation_mode + " preserves panel with retryable error", page.evaluate("window.__router.state.location.pathname") == f"/local/{CURRENT_UUID}")

    reset_pet_page("document.getElementById('row').onclick=()=>{window.__navigated='noop-row';}")
    page.locator(".cxm-pet-open").first.click()
    expect(page.locator(".cxm-pet-live")).to_contain_text("열리지", timeout=5000)
    expect(panel).to_be_visible()
    check("sidebar click without selected-thread change is not reported as success", page.evaluate("window.__navigated") == "noop-row")

    # Automatic composer focus must not swallow the next explicit pet action.
    reset_pet_page()
    page.locator("#composer").focus()
    expect(panel).to_be_visible()
    page.evaluate("window.__mode='defer'")
    refresh.focus()
    expect(refresh).to_be_focused()
    refresh.click()
    expect(refresh).to_be_disabled()
    page.locator("#composer").focus()
    expect(panel).to_be_visible()
    expect(pet).to_have_attribute("data-phase", "loading")
    page.wait_for_function("window.__pending.length===1")
    page.evaluate("window.__pending.shift()(window.__result('포커스 이동 후 결과'))")
    expect(page.locator(".cxm-pet-card h3")).to_have_text("포커스 이동 후 결과")
    expect(refresh).to_be_enabled()
    expect(panel).to_be_visible()
    check("focused refresh remains open through disabled-button composer autofocus", page.evaluate("window.__calls.length") == 2)
    page.locator("#composer").focus()
    page.locator(".cxm-pet-open").first.click()
    expect(panel).to_be_hidden()
    check("open conversation still works after automatic composer focus", page.evaluate("window.__navigated") == "row")

    reset_pet_page()
    page.locator("#composer").click()
    expect(panel).to_be_hidden()
    check("deliberate outside pointer still dismisses panel", True)
    launcher.click()
    page.locator("#composer").focus()
    expect(panel).to_be_visible()
    page.keyboard.type("explicit input")
    expect(panel).to_be_hidden()
    expect(page.locator("#composer")).to_have_value("explicit input")
    check("outside input dismisses panel without losing typed text", True)
    launcher.click()
    page.evaluate("() => {const next=document.createElement('button');next.id='after-pet';next.textContent='다음 외부 버튼';document.body.append(next);}")
    page.get_by_role("button", name="잠시 숨기기 · 30분").focus()
    page.keyboard.press("Tab")
    expect(page.locator("#after-pet")).to_be_focused()
    expect(panel).to_be_hidden()
    check("Tab leaving panel dismisses it and preserves keyboard focus", True)
    launcher.click()
    page.keyboard.press("Escape")
    expect(panel).to_be_hidden()
    expect(launcher).to_be_focused()
    check("Escape still closes and restores launcher focus", True)

    # Keep the real deadline value, accelerating only that timer for this case.
    reset_pet_page()
    page.evaluate("""() => {
      window.__deadlineDelays=[]; const original=window.setTimeout.bind(window);
      window.setTimeout=(fn, delay, ...args)=>{
        if(delay===120000) {window.__deadlineDelays.push(delay);return original(fn,150,...args);}
        return original(fn,delay,...args);
      };
      window.__mode='defer';
    }""")
    refresh.click()
    page.wait_for_function("window.__pending.length===1")
    expect(page.locator(".cxm-pet-live")).to_contain_text("응답이 늦어지고", timeout=2000)
    expect(page.locator(".cxm-pet-live")).to_contain_text("다시 시도")
    expect(refresh).to_be_enabled()
    expect(pet).to_have_attribute("data-phase", "error")
    expect(panel).to_be_visible()
    check("120-second recommendation timeout restores a visible retry", page.evaluate("window.__deadlineDelays") == [120000])
    page.evaluate("window.__pending.shift()(window.__result('시간 초과된 늦은 결과'))")
    page.evaluate("() => new Promise(r=>requestAnimationFrame(r))")
    expect(page.locator(".cxm-pet-live")).to_contain_text("응답이 늦어지고")
    expect(page.locator(".cxm-pet-card")).to_have_count(0)
    expect(pet).to_have_attribute("data-phase", "error")
    check("late response cannot replace timeout state before retry", True)
    page.evaluate("window.__mode='ok'")
    refresh.click()
    expect(page.locator(".cxm-pet-card h3")).to_have_text("이어 할 작업")
    expect(pet).to_have_attribute("data-phase", "ready")
    check("retry after timeout produces a fresh successful result", page.evaluate("window.__calls.length") == 3)

    # Upgrade an already injected frozen API without reloading or losing old RPCs.
    page.goto("https://codex.test/index.html")
    page.evaluate("""() => {
      window.__oldRead = async () => ({preserved: true});
      window.__oldChanged = () => () => {};
      window.__forwarded = []; window.__sent = []; window.__resets = 0;
      window.codexLabels = Object.freeze({read: window.__oldRead, onChanged: window.__oldChanged});
      window.__cxlBridge = {
        resolve: (...args) => window.__forwarded.push(args),
        reset: () => window.__resets++, emit: () => {}
      };
      window.__codexMemoBridge = message => window.__sent.push(JSON.parse(message));
    }""")
    shim = (ROOT / "labels/shim.js").read_text(encoding="utf-8")
    page.add_script_tag(content=shim)
    page.evaluate("() => { window.__upgradedApi=window.codexLabels;window.__upgradedResolve=window.__cxlBridge.resolve; }")
    page.add_script_tag(content=shim)
    check("hot upgrade preserves old methods and remains idempotent", page.evaluate("window.codexLabels.read===window.__oldRead && window.codexLabels.onChanged===window.__oldChanged && window.codexLabels===window.__upgradedApi && window.__cxlBridge.resolve===window.__upgradedResolve"))
    page.evaluate("""() => {
      window.__petPromise=window.codexLabels.taskPetSuggest({currentThreadId:'test',dismissedIds:[]});
      const request=window.__sent.at(-1);
      window.__cxlBridge.resolve(request.id,true,{status:'empty',items:[]});
      window.__cxlBridge.resolve(41,true,'old response');
    }""")
    check("hot upgrade request resolves through own namespace", page.evaluate("window.__petPromise") == {"status": "empty", "items": []}
          and page.evaluate("window.__sent.at(-1).id.startsWith('cxl-upgrade:') && window.__sent.at(-1).method==='taskPetSuggest'"))
    check("old response ids still forwarded", page.evaluate("window.__forwarded") == [[41, True, "old response"]])
    page.evaluate("""() => {
      window.__resetPromise=window.codexLabels.taskPetSuggest({}).then(()=>false,e=>e.message);
      window.__cxlBridge.reset();
    }""")
    check("reset rejects pending pet request and calls original reset", "다시 연결" in page.evaluate("window.__resetPromise") and page.evaluate("window.__resets") == 1)

    # v9: fast list first, model advice fills in afterwards without moving the cards.
    page.goto("https://codex.test/index.html")
    page.set_viewport_size({"width": 1024, "height": 900})
    page.evaluate(MOCKS)
    page.add_script_tag(content=THREADS)
    page.add_script_tag(content=SCRIPT)
    page.evaluate("""() => { window.__mode='defer'; }""")
    launcher.click()
    page.wait_for_function("window.__pending.length===1")
    page.evaluate("""() => { const r=window.__result('빠른 목록'); r.advicePending=true; window.__pending.shift()(r); }""")
    expect(page.locator(".cxm-pet-card h3")).to_have_text("빠른 목록")
    page.wait_for_function("window.__pending.length===1")
    check("advice is requested as a second call without the fast flag",
          page.evaluate("window.__calls.length") == 2 and "advice" not in page.evaluate("window.__calls[1]"))
    expect(page.locator(".cxm-pet-action[data-pending]")).to_have_count(1)
    expect(page.locator(".cxm-pet-time")).to_contain_text("설명 다듬는 중")
    page.evaluate("""() => { const r=window.__result('빠른 목록'); r.items[0].action='모델이 쓴 설명'; r.items[0].adviceModel='gpt-6-luna';
      r.items[0].adviceEffort='high'; window.__pending.shift()(r); }""")
    expect(page.locator(".cxm-pet-action")).to_contain_text("모델이 쓴 설명")
    expect(page.locator(".cxm-pet-action[data-pending]")).to_have_count(0)
    check("advice replaces the default action in place", "설명 다듬는" not in page.locator(".cxm-pet-time").inner_text())
    # A failed advice step keeps the cards already shown.
    refresh.click()
    page.wait_for_function("window.__pending.length===1")
    page.evaluate("""() => { const r=window.__result('설명 실패 전 목록'); r.advicePending=true; window.__pending.shift()(r); }""")
    page.wait_for_function("window.__pending.length===1")
    page.evaluate("window.__pending.shift()({status:'unavailable',items:[]})")
    expect(page.locator(".cxm-pet-live")).to_contain_text("모델 설명을 받지 못해")
    check("failed advice keeps the fast cards", page.locator(".cxm-pet-card h3").inner_text() == "설명 실패 전 목록")

    # Badge count and mood follow the visible items.
    page.evaluate("""() => { window.__mode='custom'; window.__custom=window.__result();
      window.__custom.items=[{...window.__item('질문 대기','thread:a'), state:'ask', badge:'답을 기다려요'}, window.__item('둘째','thread:b')]; }""")
    refresh.click()
    expect(page.locator(".cxm-pet-card")).to_have_count(2)
    expect(pet).to_have_attribute("data-mood", "alert")
    check("urgent items colour the badge", page.locator(".cxm-pet-count").get_attribute("data-kind") == "urgent"
          and page.locator(".cxm-pet-count").inner_text() == "2")
    check("the previous list marks newly appeared cards", page.locator(".cxm-pet-card[data-new]").count() == 2)
    page.evaluate("window.__mode='empty'"); refresh.click()
    expect(pet).to_have_attribute("data-mood", "sleep")
    check("nothing to do hides the badge", page.locator(".cxm-pet-count").is_hidden())
    page.evaluate("window.__mode='source_error'"); refresh.click()
    expect(pet).to_have_attribute("data-mood", "worry")
    page.evaluate("window.__mode='ok'"); refresh.click()
    expect(pet).to_have_attribute("data-mood", "normal")
    check("moods: sleep for empty, worry for errors, normal for ordinary work", True)

    # Number keys open a card; they are ignored while typing. Ctrl+Alt+P toggles the panel.
    page.locator(".cxm-pet-open").first.focus()
    page.evaluate("window.__navigated=null")
    page.keyboard.press("1")
    check("number key opens the matching card", page.evaluate("window.__navigated") == "row")
    expect(panel).to_be_hidden()
    page.evaluate(f"window.__selectThread('{CURRENT_UUID}')")
    page.locator("#composer").focus()
    page.keyboard.press("Control+Alt+P")
    expect(panel).to_be_visible()
    page.evaluate("window.__navigated=null")
    page.evaluate("document.getElementById('composer').dispatchEvent(new KeyboardEvent('keydown',{key:'1',bubbles:true}))")
    check("number key inside an editor does not open a card", page.evaluate("window.__navigated") is None)
    page.keyboard.press("Control+Alt+P")
    expect(panel).to_be_hidden()
    check("Ctrl+Alt+P toggles the pet", True)

    # The gear asks the tray helper to open pet settings.
    page.evaluate("window.__sentOps=[];window.__codexMemoBridge=m=>window.__sentOps.push(JSON.parse(m).op);window.__cxmTaskPet.version=0")
    page.add_script_tag(content=SCRIPT)
    launcher.click()
    page.get_by_role("button", name="펫 설정 열기").click()
    check("gear sends pet_settings to the helper", page.evaluate("window.__sentOps") == ["pet_settings"])
    page.keyboard.press("Escape")

    # Background: a closed pet prefetches once (no advice), then rechecks after a change.
    page.goto("https://codex.test/index.html")
    page.evaluate(MOCKS)
    page.evaluate("window.__cxmTaskPetAuto={prefetch:30,debounce:30,minGap:0}")
    page.add_script_tag(content=THREADS)
    page.add_script_tag(content=SCRIPT)
    page.wait_for_function("window.__calls.length===1")
    expect(page.locator(".cxm-pet-count")).to_have_text("1")
    check("closed pet prefetches a fast list only", page.evaluate("window.__calls[0].advice") is False and panel.is_hidden())
    expect(pet).not_to_have_attribute("data-fg", "")
    page.evaluate("window.__memos()")
    page.wait_for_function("window.__calls.length===2")
    check("a change while closed triggers one quiet recheck", page.evaluate("window.__calls.length") == 2)
    launcher.click()
    expect(page.locator(".cxm-pet-card h3")).to_have_text("이어 할 작업")
    check("opening after a fresh prefetch shows cards without another call", page.evaluate("window.__calls.length") == 2)
    page.keyboard.press("Escape")
    # The last list survives a page reload in the same tab.
    page.evaluate("window.__cxmTaskPetAuto=false;window.__cxmTaskPet.version=0")
    page.add_script_tag(content=SCRIPT)
    expect(page.locator(".cxm-pet-count")).to_have_text("1")
    check("reinjected pet shows the remembered list at once", page.locator(".cxm-pet-count").get_attribute("data-kind") == "stale")

    # Skips are remembered on this PC with the card's evidence version, and sent to the engine.
    page.goto("https://codex.test/index.html")
    page.evaluate(MOCKS)
    page.evaluate("""() => { window.__mode='custom'; window.__custom=window.__result('넘길 카드'); window.__custom.items[0].version='v1'; }""")
    page.add_script_tag(content=THREADS)
    page.add_script_tag(content=SCRIPT)
    launcher.click()
    expect(page.locator(".cxm-pet-card h3")).to_have_text("넘길 카드")
    page.get_by_role("button", name="이번엔 넘기기").click()
    expect(page.locator(".cxm-pet-card")).to_have_count(0)
    page.keyboard.press("Escape")
    page.evaluate("window.__cxmTaskPet.version=0; window.__custom.skipped=[window.__custom.items[0].id]; window.__custom.items=[]")
    page.add_script_tag(content=SCRIPT)
    launcher.click()
    page.wait_for_function("window.__calls.length===2")
    check("skip survives reinjection and is sent with its version",
          page.evaluate("window.__calls[1].dismissed") == {f"thread:{UUID}": "v1"} and page.evaluate("window.__calls[1].dismissedIds") == [])
    expect(page.get_by_role("button", name="넘긴 후보 1개 다시 보기")).to_be_visible()
    page.evaluate("""() => { window.__custom=window.__result('새 답변이 온 카드'); window.__custom.items[0].version='v2'; }""")
    refresh.click()
    expect(page.locator(".cxm-pet-card h3")).to_have_text("새 답변이 온 카드")
    check("changed evidence brings the card back", True)

    check("no page errors", not errors)
    browser.close()
print("\nTask pet UI checks passed.")
