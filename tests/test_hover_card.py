"""Mocked browser checks for hover occurrence identity and async cache lifecycle."""

import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = (ROOT / "labels/hover-card.js").read_text(encoding="utf-8")
HTML = """<!doctype html><html><body style="font:20px sans-serif">
<p><span id="first">alpha</span> first context</p>
<p><span id="second">alpha</span> second context</p>
</body></html>"""
MOCKS = """
window.__changes = new Set(); window.__reads = []; window.__ranks = [];
window.__deferRead = false;
window.__entries = [{id:'a',term:'alpha',meaning:'Meaning A'}, {id:'b',term:'alpha',meaning:'Meaning B'}];
window.codexLabels = {
  vocabularyRead: () => window.__deferRead ? new Promise(resolve => window.__reads.push(resolve)) : Promise.resolve({entries: window.__entries}),
  onVocabularyChanged: fn => { window.__changes.add(fn); return () => window.__changes.delete(fn); },
  vocabularySenseRank: (term, context) => new Promise(resolve => window.__ranks.push({context, resolve})),
};
const ranges = ['first','second'].map(id => {
  const node = document.getElementById(id).firstChild;
  return new StaticRange({startContainer:node,startOffset:0,endContainer:node,endOffset:node.length});
});
CSS.highlights.set('codex-vocabulary-saved', new Highlight(...ranges));
"""


class HoverCardTests(unittest.TestCase):
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
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.set_content(HTML)
        self.page.add_script_tag(content=MOCKS)

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def hover(self, target):
        self.page.locator(target).hover()

    def wait_ranks(self, count):
        self.page.wait_for_function("n => window.__ranks.length === n", arg=count)

    def first_meaning(self):
        return self.page.locator(".cxm-hover.cxm-on .cxm-h-text").first.inner_text()

    def test_change_during_read_fetches_fresh_snapshot(self):
        self.page.evaluate("window.__deferRead = true")
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("""() => {
          window.__changes.forEach(fn => fn());
          window.__reads[0]({entries:[{id:'a',term:'alpha',meaning:'stale meaning'}]});
        }""")
        self.page.wait_for_function("window.__reads.length === 2")
        self.page.evaluate("window.__reads[1]({entries:[{id:'a',term:'alpha',meaning:'fresh meaning'}]})")
        self.hover("#first")
        self.page.locator(".cxm-hover.cxm-on").wait_for()
        self.assertEqual(self.first_meaning(), "fresh meaning")
        self.assertEqual(self.page.evaluate("window.__reads.length"), 2)

    def test_same_term_at_another_occurrence_ranks_its_context(self):
        self.page.add_script_tag(content=SCRIPT)
        self.hover("#first")
        self.wait_ranks(1)
        self.hover("#second")
        self.wait_ranks(2)
        contexts = self.page.evaluate("window.__ranks.map(item => item.context)")
        self.assertIn("first context", contexts[0])
        self.assertIn("second context", contexts[1])
        self.page.evaluate("window.__ranks[1].resolve(['b','a'])")
        self.page.locator(".cxm-hover.cxm-on").wait_for()
        self.assertEqual(self.first_meaning(), "Meaning B")
        self.page.evaluate("window.__ranks[0].resolve(['a','b'])")
        self.page.wait_for_timeout(100)
        self.assertEqual(self.first_meaning(), "Meaning B")

    def test_leaving_and_reentering_does_not_accept_previous_result(self):
        self.page.add_script_tag(content=SCRIPT)
        self.hover("#first")
        self.wait_ranks(1)
        self.page.mouse.move(700, 500)
        self.page.wait_for_timeout(30)
        self.hover("#first")
        self.wait_ranks(2)
        self.page.evaluate("window.__ranks[1].resolve(['b','a'])")
        self.page.locator(".cxm-hover.cxm-on").wait_for()
        self.page.evaluate("window.__ranks[0].resolve(['a','b'])")
        self.page.wait_for_timeout(100)
        self.assertEqual(self.first_meaning(), "Meaning B")

    def test_destroy_ignores_pending_rank_and_unsubscribes(self):
        self.page.add_script_tag(content=SCRIPT)
        self.hover("#first")
        self.wait_ranks(1)
        self.page.evaluate("window.__cxmHover.destroy(); window.__ranks[0].resolve(['a','b'])")
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.locator(".cxm-hover").count(), 0)
        self.assertEqual(self.page.evaluate("window.__changes.size"), 0)


if __name__ == "__main__":
    unittest.main()
