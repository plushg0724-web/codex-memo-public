"""Pet progress UI with local JSON fixtures; no Codex account or live services.

Run: python tests/test_task_progress_ui.py (installed Chrome)
"""
import ast
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "output" / "pet-progress"
OUT.mkdir(parents=True, exist_ok=True)
# Exercise the actual CDP injection order without importing Windows native code.
tree = ast.parse((ROOT / "cdp_bridge.py").read_text(encoding="utf-8"))
scripts = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
               and any(isinstance(target, ast.Name) and target.id == "LABEL_SCRIPTS" for target in node.targets))
SCRIPTS = [name for name in scripts if name.startswith("task-")]
HTML = """<!doctype html><html class="light"><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f4f6f5;font-family:system-ui;color:#31463c">
<main style="padding:36px"><h1 style="font-size:20px">CodexMemo · 클라우드 UI 시험</h1>
<p>합성 화면과 JSON 예시 · 설치 앱 화면이 아닙니다.</p></main>
<textarea aria-label="메시지 입력" style="position:fixed;bottom:12px;left:16px;width:calc(100% - 36px);height:64px"></textarea>
</body></html>"""
FIXTURE = {"formatVersion": 1, "source": {"kind": "space", "label": "UI 검증용 가상 자료 · 실업무 아님",
    "ref": "fixture-only", "url": "https://example.test/original", "updatedAt": "2026-10-08T04:00:00Z"},
    "projects": [{"id": "erp", "stage": "가상 검토 단계", "summary": "테스트용 전체 체크리스트",
        "blockers": ["가상 검토 대기"], "nextAction": "가상 검토 결과 확인",
        "checklist": {"complete": True, "items": [{"id": "a", "text": "가상 가져오기", "done": True},
            {"id": "b", "text": "가상 검토", "done": False}]}}]}


def check(name, condition=True):
    assert condition, name
    print("✔", name)


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1000, "height": 1040})
    errors, requests = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("request", lambda request: requests.append(request.url))
    page.route("https://codex.test/**", lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=HTML))
    page.goto("https://codex.test/index.html")
    page.evaluate("""() => {
      window.__suggestions = 0; window.__cxmTaskPetAuto = false;
      window.codexLabels = {
        taskPetSuggest: async () => {window.__suggestions++; return {status:'empty', items:[]};},
        read: async () => ({config:{labels:[]}, assignments:{}}), onChanged: () => () => {}
      };
      window.__codexMemo = {list: () => [], subscribe: () => () => {}};
      window.__nativeFileText = File.prototype.text;
      window.__fileReads = 0; window.__pendingFiles = [];
      File.prototype.text = function () {
        window.__fileReads++;
        if (window.__deferFile) return new Promise((resolve, reject) => window.__pendingFiles.push({resolve,reject}));
        return window.__nativeFileText.call(this);
      };
    }""")
    for name in SCRIPTS:
        page.add_script_tag(content=(ROOT / "labels" / name).read_text(encoding="utf-8"))
    launcher = page.locator(".cxm-pet-launcher")
    panel = page.locator(".cxm-pet-panel")
    check("mount does not read sources", page.evaluate("window.__suggestions + window.__fileReads") == 0)
    launcher.click()
    page.wait_for_function("window.__suggestions === 1")
    page.get_by_role("button", name="업무 진척", exact=True).click()
    progress = page.locator(".cxm-progress")
    rows = page.locator(".cxm-progress-row")
    detail = page.locator(".cxm-progress-detail")
    sync = progress.locator(".cxm-progress-tools > .cxm-progress-btn")
    file = progress.locator("input[type=file]")
    expect(rows).to_have_count(4)
    expect(progress).to_have_attribute("data-phase", "empty")
    expect(progress).to_contain_text("마지막 동기화: 없음")
    expect(progress.get_by_role("progressbar")).to_have_count(0)
    check("empty state is unknown, not zero progress", page.locator(".cxm-progress-value").all_text_contents() == ["미정"] * 4)
    page.screenshot(path=str(OUT / "empty.png"))

    page.get_by_role("button", name="초기 예시 보기").click()
    expect(progress).to_have_attribute("data-phase", "ready")
    expect(progress).to_contain_text("초기 예시 · 현재 동기화 아님")
    expect(progress.get_by_role("progressbar")).to_have_count(0)
    page.get_by_role("button", name="다음 할 일", exact=True).click()
    expect(progress).to_be_hidden()
    page.get_by_role("button", name="업무 진척", exact=True).click()
    expect(progress).to_be_visible()
    check("switching pet views preserves data without another recommendation", page.evaluate("window.__suggestions") == 1)
    page.screenshot(path=str(OUT / "sample-overview.png"))
    project_b = page.locator('[data-project="erp"]')
    project_b.click()
    expect(detail).to_contain_text("기능을 설명하기 위한 가상 자료")
    expect(detail).to_contain_text("설명만으로 완료율을 계산하지 않습니다")
    expect(detail).to_contain_text("진척 미정")
    expect(detail).to_contain_text("원본 링크 미등록")
    page.screenshot(path=str(OUT / "sample-detail.png"))
    page.get_by_role("button", name="상세 닫기").click()
    expect(detail).to_be_hidden()
    expect(project_b).to_be_focused()
    page.locator('[data-project="mmh"]').click()
    page.get_by_role("checkbox", name="프로젝트 A 표시").uncheck()
    expect(rows).to_have_count(3)
    expect(detail).to_be_hidden()
    page.get_by_role("checkbox", name="프로젝트 A 표시").check()
    check("first project toggle affects display only", page.evaluate("JSON.parse(localStorage.getItem('cxm-pet-progress-snapshot-v1')).snapshot.projects.length") == 4)

    # Manual synchronization is a file chooser, with cancellation leaving data alone.
    with page.expect_file_chooser() as chooser:
        sync.click()
    chooser.value.set_files([])
    expect(progress).to_have_attribute("data-phase", "ready")
    check("cancelled picker leaves snapshot and read count intact", page.evaluate("window.__fileReads") == 0)
    payload = {"name": "space-export.json", "mimeType": "application/json", "buffer": json.dumps(FIXTURE).encode()}
    page.evaluate("window.__deferFile = true")
    file.set_input_files(payload)
    expect(progress).to_have_attribute("aria-busy", "true")
    expect(sync).to_be_disabled()
    expect(page.get_by_role("button", name="초기 예시 보기")).to_be_disabled()
    expect(project_b).to_contain_text("예시 검토 중")
    file.dispatch_event("change")
    check("duplicate synchronization while reading is ignored", page.evaluate("window.__fileReads") == 1)
    page.keyboard.press("Escape")
    expect(panel).to_be_hidden()
    page.evaluate("text => window.__pendingFiles.shift().resolve(text)", json.dumps(FIXTURE))
    launcher.click()
    expect(progress).to_be_visible()
    expect(progress).to_have_attribute("aria-busy", "false")
    expect(project_b).to_contain_text("1/2 · 50%")
    expect(project_b.get_by_role("progressbar")).to_have_attribute("aria-valuenow", "50")
    check("closing and reopening preserves completed manual read", page.evaluate("window.__suggestions") == 1)
    page.evaluate("window.__deferFile = false")
    project_b.click()
    for value in ["완료 ✓ · 가상 가져오기", "미완료 ○ · 가상 검토", "가상 검토 대기", "가상 검토 결과 확인", "JSON 가져온 시각"]:
        expect(detail).to_contain_text(value)
    expect(detail.get_by_role("link", name="원본 열기 ↗")).to_have_attribute("href", "https://example.test/original")
    expect(detail.get_by_role("link")).to_have_attribute("rel", "noopener noreferrer")
    page.screenshot(path=str(OUT / "checklist-detail.png"))
    page.evaluate("document.documentElement.className = 'dark'")
    page.screenshot(path=str(OUT / "checklist-dark.png"))
    page.evaluate("document.documentElement.className = 'light'")

    saved = page.evaluate("localStorage.getItem('cxm-pet-progress-snapshot-v1')")
    file.set_input_files({"name": "bad.json", "mimeType": "application/json", "buffer": b"{"})
    expect(progress).to_have_attribute("data-phase", "error")
    expect(progress).to_contain_text("JSON 문법")
    expect(project_b).to_contain_text("50%")
    check("failed import preserves data and last successful read time", page.evaluate("localStorage.getItem('cxm-pet-progress-snapshot-v1')") == saved)
    page.screenshot(path=str(OUT / "error.png"))
    file.set_input_files({"name": "large.json", "mimeType": "application/json", "buffer": b" " * (128 * 1024 + 1)})
    expect(progress).to_contain_text("128 KiB")

    # File read failure and timeout are retryable; late timeout results cannot overwrite.
    page.evaluate("window.__deferFile = true")
    file.set_input_files(payload)
    page.evaluate("window.__pendingFiles.shift().reject(Error('테스트 읽기 실패'))")
    expect(progress).to_have_attribute("data-phase", "error")
    expect(sync).to_be_enabled()
    page.clock.install()
    file.set_input_files(payload)
    page.clock.run_for(15001)
    expect(progress).to_contain_text("읽기 시간이 초과")
    page.evaluate("text => window.__pendingFiles.shift().resolve(text)", json.dumps({**FIXTURE, "projects": []}))
    expect(project_b).to_contain_text("50%")
    check("read failures, timeouts and late responses preserve the last snapshot")
    page.evaluate("window.__deferFile = false")
    file.set_input_files(payload)
    expect(progress).to_have_attribute("data-phase", "ready")
    page.clock.resume()

    # Reinjection restores local snapshot and preference without source/model reads.
    page.get_by_role("checkbox", name="프로젝트 A 표시").uncheck()
    page.evaluate("window.__cxmTaskPet.version=0")
    for name in SCRIPTS:
        page.add_script_tag(content=(ROOT / "labels" / name).read_text(encoding="utf-8"))
    launcher.click()
    page.get_by_role("button", name="업무 진척", exact=True).click()
    expect(rows).to_have_count(3)
    expect(project_b).to_contain_text("50%")
    expect(progress).to_contain_text("저장된 자료")
    page.get_by_role("checkbox", name="프로젝트 A 표시").check()
    page.set_viewport_size({"width": 360, "height": 640})
    box = panel.bounding_box()
    check("narrow panel remains in viewport", box["x"] >= 0 and box["x"] + box["width"] <= 360)
    check("progress rows do not overflow horizontally", progress.evaluate("el => el.scrollWidth <= el.clientWidth"))
    page.screenshot(path=str(OUT / "narrow.png"))
    page.set_viewport_size({"width": 1000, "height": 1040})

    # All imported text is inert; unsafe URLs are never made clickable.
    unsafe = json.loads(json.dumps(FIXTURE))
    unsafe["projects"][0]["stage"] = '<img src=x onerror="window.__xss=1">'
    unsafe["source"]["url"] = "javascript:alert(1)"
    unsafe["projects"][0]["checklist"]["complete"] = False
    file.set_input_files({"name": "unsafe.json", "mimeType": "application/json", "buffer": json.dumps(unsafe).encode()})
    expect(project_b).to_contain_text("<img")
    expect(project_b.get_by_role("progressbar")).to_have_count(0)
    project_b.click()
    expect(detail).to_contain_text("일부 체크리스트")
    expect(detail.get_by_role("link")).to_have_count(0)
    expect(progress.locator("img")).to_have_count(0)
    check("imported markup stays inert", page.evaluate("window.__xss || null") is None)

    file.set_input_files({"name": "empty.json", "mimeType": "application/json", "buffer": json.dumps({**FIXTURE, "projects": []}).encode()})
    expect(progress).to_have_attribute("data-phase", "empty")
    expect(progress).to_contain_text("업무 항목이 없습니다")
    expect(rows).to_have_count(4)

    # Storage failures are explicit and do not prevent a usable imported view.
    page.evaluate("() => { Storage.prototype.setItem = () => {throw Error('storage blocked')}; }")
    file.set_input_files(payload)
    expect(progress).to_contain_text("화면 저장이 제한")
    expect(project_b).to_contain_text("50%")
    page.evaluate("window.__deferFile = true")
    file.set_input_files(payload)
    page.evaluate("window.__cxmTaskPet.destroy()")
    expect(panel).to_have_count(0)
    page.evaluate("text => window.__pendingFiles.shift().resolve(text)", json.dumps(FIXTURE))
    check("destroy ignores delayed read and removes progress UI", page.locator(".cxm-progress").count() == 0)
    check("no network request beyond synthetic test page", requests == ["https://codex.test/index.html"])
    check("no browser exceptions", not errors)
    browser.close()
