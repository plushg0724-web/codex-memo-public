"""실제 Chrome에서 색인 캐시·본문 변경·대화 전환·스크립트 정리를 검사한다."""

import sys
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = (ROOT / "inject.js").read_text(encoding="utf-8")
HTML = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="thread" data-app-action-sidebar-thread-selected="true"
 data-app-action-sidebar-thread-id="local:one" data-app-action-sidebar-thread-title="테스트"></div>
<aside id="sidebar"></aside><main><div id="body" data-selected-text-overlay-target>
<p id="first">첫 문장의 라우팅 설정입니다.</p><p id="second">둘째 문장의 라우팅 설정입니다.</p>
</div></main></body></html>"""
INSTRUMENT = """
window.__walks = 0;
const walk = document.createTreeWalker.bind(document);
document.createTreeWalker = (...args) => { window.__walks++; return walk(...args); };
window.__codexMemoBridge = () => {};
window.__timers = new Set();
const later = window.setTimeout.bind(window), cancel = window.clearTimeout.bind(window);
window.setTimeout = (fn, ms, ...args) => {
  const id = later(() => { window.__timers.delete(id); fn(...args); }, ms);
  window.__timers.add(id); return id;
};
window.clearTimeout = id => { window.__timers.delete(id); cancel(id); };
"""
MEMO = {"id": "memo", "created": "2026-10-02 12:00", "conv": "one", "quote": "라우팅",
        "note": "메모", "exact": "라우팅", "prefix": "둘째 문장의 ", "suffix": " 설정입니다."}


class HighlightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(channel="chrome", headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.addCleanup(self.page.close)
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.set_content(HTML)
        self.page.add_script_tag(content=INSTRUMENT)
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("m => { window.__codexMemo.setMemos([m]); window.__codexMemo.bench(1); }", MEMO)

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def test_index_matches_char_by_char_reference(self):
        # 빠른 길(공백을 줄일 필요 없는 노드는 통째로)이 글자 하나씩 줄이던 방식과 같은 색인을 만드는지
        self.page.evaluate("""() => {
          const body = document.getElementById('body');
          body.innerHTML = '<p>  앞 공백과\\n줄바꿈\\t탭</p><p>nbsp\\u00a0와  두 칸</p><p>보통 문장 하나</p>'
            + '<p> 앞에 한 칸</p><p>끝에 한 칸 </p><p> </p><p>마지막</p><p></p>';
        }""")
        got, want = self.page.evaluate("""() => {
          const got = window.__codexMemo.indexDump();
          const nodes = [], walker = document.createTreeWalker(document.getElementById('body'), NodeFilter.SHOW_TEXT);
          let n; while ((n = walker.nextNode())) nodes.push(n);
          const sp = c => c === ' ' || c === '\\n' || c === '\\t' || c === '\\r' || c === '\\u00a0';
          const chars = [], nn = [], oo = []; let prev = true;
          nodes.forEach((node, ni) => { for (let i = 0; i < node.data.length; i++) { let c = node.data[i];
            if (sp(c)) { if (prev) continue; c = ' '; prev = true; } else prev = false; chars.push(c); nn.push(ni); oo.push(i); } });
          return [got, {text: chars.join(''), n: nn, o: oo, nodes: nodes.length}];
        }""")
        self.assertEqual(got, want)

    def test_cached_highlights_keep_duplicate_quote_context(self):
        before = self.page.evaluate("window.__walks")
        self.page.evaluate("window.__codexMemo.bench(20)")
        self.assertEqual(self.page.evaluate("window.__walks"), before)
        self.assertEqual(self.page.evaluate("[...CSS.highlights.get('codex-memo')][0].startContainer.parentElement.id"), "second")
        self.page.evaluate("m => { m.note = '새 메모'; window.__codexMemo.setMemos([m]); window.__codexMemo.bench(1); }", dict(MEMO))
        self.assertEqual(self.page.evaluate("window.__walks"), before)

    def test_sync_streaming_change_invalidates_index_immediately(self):
        # MutationObserver 콜백을 기다리지 않고 같은 JS 작업 안에서 다시 계산한다.
        self.page.evaluate("""() => {
          document.getElementById('first').firstChild.data = '새 첫 문장';
          document.getElementById('second').firstChild.data = '새 둘째 문장';
          window.__codexMemo.bench(1);
        }""")
        self.assertEqual(self.page.evaluate("window.__codexMemo.marks"), 0)
        self.page.evaluate("""() => {
          document.getElementById('second').textContent = '둘째 문장의 라우팅 설정입니다.';
          window.__codexMemo.bench(1);
        }""")
        self.assertEqual(self.page.evaluate("window.__codexMemo.marks"), 1)

    def test_replaced_body_does_not_reuse_detached_text_nodes(self):
        self.page.evaluate("""() => {
          document.getElementById('body').outerHTML = '<div data-selected-text-overlay-target><p id="new">둘째 문장의 라우팅 설정입니다.</p></div>';
          window.__codexMemo.bench(1);
        }""")
        self.assertEqual(self.page.evaluate("[...CSS.highlights.get('codex-memo')][0].startContainer.parentElement.id"), "new")

    def test_sidebar_changes_do_not_rebuild_body_index(self):
        before = self.page.evaluate("window.__walks")
        self.page.evaluate("document.getElementById('sidebar').textContent = '다른 대화 목록 변경'")
        self.page.wait_for_timeout(650)
        self.page.evaluate("window.__codexMemo.bench(1)")
        self.assertEqual(self.page.evaluate("window.__walks"), before)

    def test_attribute_only_thread_switch_updates_highlights(self):
        self.page.evaluate("document.getElementById('thread').setAttribute('data-app-action-sidebar-thread-id', 'local:two')")
        self.page.wait_for_function("window.__codexMemo.marks === 0")
        self.page.evaluate("document.getElementById('thread').setAttribute('data-app-action-sidebar-thread-id', 'local:one')")
        self.page.wait_for_function("window.__codexMemo.marks === 1")

    def test_fallback_excludes_vocabulary_dialog(self):
        self.page.evaluate("""() => {
          document.getElementById('body').removeAttribute('data-selected-text-overlay-target');
          document.getElementById('body').textContent = '본문';
          const dialog = document.createElement('div'); dialog.id = 'cdx-vocabulary';
          dialog.textContent = '둘째 문장의 라우팅 설정입니다.'; document.body.append(dialog);
          window.__codexMemo.bench(1);
        }""")
        self.assertEqual(self.page.evaluate("window.__codexMemo.marks"), 0)

    def test_destroy_clears_deferred_selection_and_highlight_work(self):
        self.page.evaluate("""() => {
          const r = document.createRange(); r.selectNodeContents(document.getElementById('first'));
          getSelection().removeAllRanges(); getSelection().addRange(r);
          document.getElementById('first').dispatchEvent(new MouseEvent('mouseup', {bubbles:true, button:0}));
          window.__codexMemo.destroy();
        }""")
        self.assertEqual(self.page.evaluate("window.__timers.size"), 0)
        self.assertEqual(self.page.locator("#cxm-root").count(), 0)
        self.assertFalse(self.page.evaluate("CSS.highlights.has('codex-memo')"))
        self.page.add_script_tag(content=SCRIPT)
        self.page.add_script_tag(content=SCRIPT)
        self.assertEqual(self.page.locator("#cxm-root").count(), 1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    unittest.main()
