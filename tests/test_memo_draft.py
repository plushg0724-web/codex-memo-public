"""Standalone memo popup draft guards, using a mocked bridge in headless Chrome."""

import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = (ROOT / "inject.js").read_text(encoding="utf-8")
NEXT_SCRIPT = SCRIPT.replace("const VERSION = 12;", "const VERSION = 13;")
HTML = """<!doctype html><html><body style="font:18px sans-serif">
<div data-app-action-sidebar-thread-selected="true" data-app-action-sidebar-thread-id="local:one"
 data-app-action-sidebar-thread-title="Test thread"></div>
<div role="presentation" class="pointer-events-auto" style="position:fixed;right:10px;top:10px">
 <button>Add to chat</button>
</div>
<main style="margin-top:65px"><div data-selected-text-overlay-target>
 <p id="first">First anchor.</p><p id="second">Second anchor.</p>
</div></main>
<button id="outside" style="position:fixed;left:10px;top:500px">Outside action</button>
</body></html>"""
MOCKS = """
window.__messages = []; window.__outsideClicks = 0; window.__failBridge = false;
window.__codexMemoBridge = raw => {
  if (window.__failBridge) throw Error('Mock bridge unavailable');
  window.__messages.push(JSON.parse(raw));
};
document.getElementById('outside').addEventListener('click', () => window.__outsideClicks++);
"""
MEMO = {"id": "saved", "created": "2026-10-06", "conv": "one", "quote": "First anchor.",
        "exact": "First anchor.", "prefix": "", "suffix": "", "note": "Saved memo"}


class MemoDraftTests(unittest.TestCase):
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
        self.errors, self.dialogs = [], []
        self.accept_dialogs = False
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", self.on_dialog)
        self.page.set_content(HTML)
        self.page.add_script_tag(content=MOCKS)
        self.page.add_script_tag(content=SCRIPT)
        self.note = self.page.locator("#cxm-root textarea")
        self.popup = self.page.locator("#cxm-root .cxm-pop")

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def on_dialog(self, dialog):
        self.dialogs.append(dialog.message)
        dialog.accept() if self.accept_dialogs else dialog.dismiss()

    def select_text(self, element_id):
        self.page.evaluate("""id => {
          const range = document.createRange(); range.selectNodeContents(document.getElementById(id));
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        }""", element_id)
        self.page.locator(".cxm-toolbar-action").wait_for()

    def open_new(self):
        self.select_text("first")
        self.page.locator(".cxm-toolbar-action").click()
        self.popup.wait_for()

    def open_saved(self):
        self.page.evaluate("memo => { window.__codexMemo.setMemos([memo]); window.__codexMemo.bench(1); }", MEMO)
        self.page.locator("#first").click(position={"x": 10, "y": 10})
        self.popup.wait_for()

    def changes(self):
        return self.page.evaluate("window.__messages.filter(message => ['add','update','delete'].includes(message.op))")

    def assert_draft(self, value):
        self.assertTrue(self.popup.is_visible())
        self.assertEqual(self.note.input_value(), value)
        self.assertTrue(self.note.evaluate("node => document.activeElement === node"))

    def test_outside_click_cancel_preserves_draft_caret_and_focus(self):
        self.open_new()
        self.note.fill("Unsaved memo draft")
        self.note.evaluate("node => node.setSelectionRange(2, 7)")
        self.page.locator("#outside").click()
        self.assert_draft("Unsaved memo draft")
        self.assertEqual(self.note.evaluate("node => [node.selectionStart,node.selectionEnd]"), [2, 7])
        self.assertEqual(self.page.evaluate("window.__outsideClicks"), 0)
        self.assertEqual(len(self.dialogs), 1)
        self.assertEqual(self.changes(), [])

    def test_escape_cancel_then_confirmed_discard(self):
        self.open_new()
        self.note.fill("Draft to discard")
        self.note.press("Escape")
        self.assert_draft("Draft to discard")
        self.accept_dialogs = True
        self.note.press("Escape")
        self.assertFalse(self.popup.is_visible())
        self.assertEqual(len(self.dialogs), 2)
        self.assertEqual(self.changes(), [])

    def test_reopen_cancel_keeps_original_anchor_for_save(self):
        self.open_new()
        self.note.fill("Keep first anchor")
        self.select_text("second")
        # Programmatic toolbar activation also has to respect the draft guard;
        # this path intentionally has no preceding outside mousedown.
        self.page.locator(".cxm-toolbar-action").evaluate("button => button.click()")
        self.assert_draft("Keep first anchor")
        self.assertEqual(self.page.locator(".cxm-quote").inner_text(), "First anchor.")
        self.note.press("Control+Enter")
        self.assertFalse(self.popup.is_visible())
        self.assertEqual(len(self.dialogs), 1)
        change, = self.changes()
        self.assertEqual((change["op"], change["quote"], change["exact"], change["note"]),
                         ("add", "First anchor.", "First anchor.", "Keep first anchor"))

    def test_reinjection_cancel_keeps_live_editor_then_accept_replaces_it(self):
        self.open_new()
        self.note.fill("Draft across reload")
        self.page.add_script_tag(content=NEXT_SCRIPT)
        self.assert_draft("Draft across reload")
        self.assertEqual(self.page.evaluate("window.__codexMemo.version"), 12)
        self.assertEqual(self.page.locator("#cxm-root").count(), 1)
        self.accept_dialogs = True
        self.page.add_script_tag(content=NEXT_SCRIPT)
        self.assertEqual(self.page.evaluate("window.__codexMemo.version"), 13)
        self.assertEqual(self.page.locator("#cxm-root").count(), 1)
        self.assertFalse(self.popup.is_visible())
        self.assertEqual(len(self.dialogs), 2)

    def test_unchanged_saved_memo_closes_without_prompt(self):
        self.open_saved()
        self.assertEqual(self.note.input_value(), "Saved memo")
        self.page.locator("#outside").click()
        self.assertFalse(self.popup.is_visible())
        self.assertEqual(self.dialogs, [])
        self.assertEqual(self.page.evaluate("window.__outsideClicks"), 1)
        self.assertEqual(self.changes(), [])

    def test_changed_saved_memo_saves_without_discard_prompt(self):
        self.open_saved()
        self.note.fill("Updated memo")
        self.page.locator(".cxm-save").click()
        self.assertFalse(self.popup.is_visible())
        self.assertEqual(self.dialogs, [])
        self.assertEqual(self.changes(), [{"op": "update", "id": "saved", "note": "Updated memo"}])

    def test_delete_keeps_existing_two_click_confirmation(self):
        self.open_saved()
        self.note.fill("Uncommitted edit")
        self.page.locator(".cxm-del").click()
        self.assertTrue(self.popup.is_visible())
        self.assertEqual(self.changes(), [])
        self.page.locator(".cxm-del").click()
        self.assertFalse(self.popup.is_visible())
        self.assertEqual(self.dialogs, [])
        self.assertEqual(self.changes(), [{"op": "delete", "id": "saved"}])

    def test_failed_bridge_keeps_draft_until_retry(self):
        self.open_new()
        self.note.fill("Retry this memo")
        self.page.evaluate("window.__failBridge = true")
        self.note.press("Control+Enter")
        self.assert_draft("Retry this memo")
        self.assertEqual(self.changes(), [])
        self.page.evaluate("window.__failBridge = false")
        self.note.press("Control+Enter")
        self.assertFalse(self.popup.is_visible())
        self.assertEqual(len(self.changes()), 1)
        self.assertEqual(self.dialogs, [])

    def test_legacy_open_editor_defers_upgrade(self):
        self.open_new()
        self.note.fill("Legacy draft")
        self.page.evaluate("window.__codexMemo.version = 10")
        self.page.add_script_tag(content=SCRIPT)
        self.assert_draft("Legacy draft")
        self.assertEqual(self.page.evaluate("window.__codexMemo.version"), 10)
        self.assertEqual(self.dialogs, [])


if __name__ == "__main__":
    unittest.main()
