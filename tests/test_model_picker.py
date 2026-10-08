"""Mocked settings lifecycle checks; no Codex process or provider is contacted."""

import unittest
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = (ROOT / "labels/model-picker.js").read_text(encoding="utf-8")
VERSION = int(re.search(r"const VERSION = (\d+);", SCRIPT).group(1))
NEXT_SCRIPT = SCRIPT.replace(f"const VERSION = {VERSION};", f"const VERSION = {VERSION + 1};", 1)
MOCKS = r"""
window.__watchers = new Set(); window.__requests = []; window.__hold = false;
window.__choice = {model:'model-a',effort:'high',fast:false};
window.__guide = {guide:'Saved guide',defaultGuide:'Saved guide',custom:false,limit:4000};
window.__thresholds = {label:.8,status:.8,memo:.8,sense:.8};
window.__refreshes = 0;
window.addEventListener('cxm:auto-refresh', () => window.__refreshes++);
window.__timers = new Map();
const nativeTimeout = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
window.setTimeout = (callback, ms, ...args) => {
  const id = nativeTimeout(callback, ms, ...args);
  if (ms === 30000) window.__timers.set(id, callback);
  return id;
};
window.clearTimeout = id => { window.__timers.delete(id); nativeClear(id); };
window.__cxm = {watch: hooks => { window.__watchers.add(hooks); return () => window.__watchers.delete(hooks); }};
window.codexLabels = {vocabularyRead: async () => ({entries:[]})};
window.__result = (method, args = []) => {
  if (method === 'vocabularySetModel') window.__choice = {...window.__choice,model:args[0],effort:args[1]};
  if (method === 'vocabularySetFast') window.__choice = {...window.__choice,fast:args[0]};
  if (method === 'vocabularySetGuide') {
    const guide = args[0] == null ? window.__guide.defaultGuide : args[0].replace(/\r\n?/g,'\n').trim();
    window.__guide = {...window.__guide,guide,custom:guide !== window.__guide.defaultGuide};
  }
  if (method === 'thresholdsSet') window.__thresholds = {...window.__thresholds,...args[0]};
  return {
    vocabularyModels: [{id:'model-a',name:'Model A',efforts:['high'],defaultEffort:'high',fast:true}],
    vocabularyModel: {...window.__choice}, vocabularySetModel: {...window.__choice}, vocabularySetFast: {...window.__choice},
    vocabularyGuide: {...window.__guide}, vocabularySetGuide: {...window.__guide},
    autoSettings: {mode:'mica',available:true,thresholds:{...window.__thresholds},defaults:{label:.8,status:.8,memo:.8,sense:.8}},
    thresholdsSet: {...window.__thresholds}, autoRefresh: true,
  }[method];
};
window.__codexMemoBridge = raw => {
  const request = JSON.parse(raw); window.__requests.push(request);
  if (!window.__hold) queueMicrotask(() => window[request.cb]?.resolve(request.id,true,window.__result(request.method,request.args)));
};
window.__openSettings = (automation = false) => {
  const dialog = document.createElement('dialog'); dialog.id = 'cdx-label-settings';
  const box = document.createElement('section'); box.className = 'cxm-settings-model';
  dialog.append(box);
  if (automation) { const auto = document.createElement('section'); auto.className = 'cxm-settings-auto'; dialog.append(auto); }
  document.body.append(dialog); dialog.show();
  window.__watchers.forEach(hooks => hooks.added([dialog]));
};
"""


class ModelPickerTests(unittest.TestCase):
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
        self.page.set_content("<!doctype html><html><body></body></html>")
        self.page.add_script_tag(content=MOCKS)

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def open_settings(self, automation=False):
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("window.__openSettings", automation)
        self.page.wait_for_function("document.getElementById('cxm-settings-guide-text')?.value === 'Saved guide'")
        self.page.wait_for_function("!document.getElementById('cxm-settings-model-select').disabled")
        if automation:
            self.page.wait_for_function("!document.getElementById('cxm-settings-threshold-label').disabled")

    def override_result(self, method, expression):
        self.page.evaluate("""([target, expression]) => {
          const original = window.__result;
          const replacement = new Function('args', expression);
          window.__result = (method, args) => method === target ? replacement(args) : original(method,args);
        }""", [method, expression])

    def resolve_last(self, ok=True, value=None):
        self.page.evaluate("""([ok, value]) => {
          const request = window.__requests.at(-1);
          window[request.cb].resolve(request.id,ok,value);
        }""", [ok, value])

    def wait_for_error(self, section=".cxm-settings-model"):
        note = self.page.locator(f"{section} > .cxm-settings-note[data-error=true]")
        note.wait_for()
        return note.inner_text()

    def change_threshold(self, value):
        self.page.evaluate("""value => {
          const input = document.getElementById('cxm-settings-threshold-label');
          input.value = String(value);
          input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('change'));
        }""", value)

    def test_closed_dialog_reload_replaces_watcher_and_styles_once(self):
        self.page.add_script_tag(content=SCRIPT)
        self.page.add_script_tag(content=NEXT_SCRIPT)
        self.page.add_script_tag(content=NEXT_SCRIPT)
        self.assertEqual(self.page.evaluate("window.__watchers.size"), 1)
        self.assertEqual(self.page.evaluate("document.adoptedStyleSheets.length"), 1)
        self.page.evaluate("window.__openSettings()")
        self.page.wait_for_function("document.getElementById('cxm-settings-guide-text')?.value === 'Saved guide'")
        self.assertEqual(self.page.locator("#cxm-settings-guide-text").count(), 1)
        self.assertEqual(self.page.evaluate("window.__requests.length"), 3)

    def test_open_dialog_defers_reload_without_losing_guide_draft(self):
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("window.__openSettings()")
        guide = self.page.locator("#cxm-settings-guide-text")
        guide.fill("Unsaved guide draft")
        self.page.add_script_tag(content=NEXT_SCRIPT)
        self.assertEqual(guide.input_value(), "Unsaved guide draft")
        self.assertEqual(self.page.evaluate("window.__cxmModelPicker"), VERSION)
        self.assertEqual(self.page.evaluate("window.__watchers.size"), 1)
        self.assertEqual(self.page.evaluate("window.__requests.length"), 3)
        self.page.evaluate("document.getElementById('cdx-label-settings').remove()")
        self.page.add_script_tag(content=NEXT_SCRIPT)
        self.assertEqual(self.page.evaluate("window.__cxmModelPicker"), VERSION + 1)
        self.assertEqual(self.page.evaluate("document.adoptedStyleSheets.length"), 1)

    def test_deferred_reload_installs_once_after_the_open_dialog_closes(self):
        self.open_settings()
        guide = self.page.locator("#cxm-settings-guide-text")
        guide.fill("Unsaved guide draft")
        self.page.add_script_tag(content=NEXT_SCRIPT)
        self.page.add_script_tag(content=NEXT_SCRIPT)
        self.page.evaluate("document.body.append(document.createElement('p'))")
        self.assertEqual(self.page.evaluate("window.__cxmModelPicker"), VERSION)
        self.assertEqual(guide.input_value(), "Unsaved guide draft")
        self.page.evaluate("document.getElementById('cdx-label-settings').remove()")
        self.page.wait_for_function(f"window.__cxmModelPicker === {VERSION + 1}")
        self.assertFalse(self.page.evaluate("'__cxmModelPickerPending' in window"))
        self.assertEqual(self.page.evaluate("window.__watchers.size"), 1)
        self.assertEqual(self.page.evaluate("document.adoptedStyleSheets.length"), 1)
        self.page.evaluate("window.__openSettings()")
        self.page.wait_for_function("document.getElementById('cxm-settings-guide-text')?.value === 'Saved guide'")
        self.assertEqual(self.page.locator("#cxm-settings-guide-text").count(), 1)
        self.assertEqual(self.page.evaluate("window.__requests.length"), 6)

    def test_reinjecting_installed_version_cancels_a_pending_upgrade(self):
        self.open_settings()
        guide = self.page.locator("#cxm-settings-guide-text")
        guide.fill("Keep this draft during cancellation")
        self.page.add_script_tag(content=NEXT_SCRIPT)
        self.assertTrue(self.page.evaluate("Boolean(window.__cxmModelPickerPending)"))
        self.page.add_script_tag(content=SCRIPT)
        self.assertFalse(self.page.evaluate("Boolean(window.__cxmModelPickerPending)"))
        self.assertEqual(guide.input_value(), "Keep this draft during cancellation")
        self.page.evaluate("document.getElementById('cdx-label-settings').remove()")
        self.assertEqual(self.page.evaluate("window.__cxmModelPicker"), VERSION)
        self.assertEqual(self.page.evaluate("window.__watchers.size"), 1)

    def test_latest_pending_copy_replaces_an_earlier_requested_version(self):
        self.open_settings()
        later = SCRIPT.replace(f"const VERSION = {VERSION};", f"const VERSION = {VERSION + 2};", 1)
        self.page.add_script_tag(content=later)
        self.page.add_script_tag(content=NEXT_SCRIPT)
        self.assertEqual(self.page.evaluate("window.__cxmModelPickerPending.version"), VERSION + 1)
        self.page.evaluate("document.getElementById('cdx-label-settings').remove()")
        self.page.wait_for_function(f"window.__cxmModelPicker === {VERSION + 1}")
        self.assertFalse(self.page.evaluate("Boolean(window.__cxmModelPickerPending)"))
        self.assertEqual(self.page.evaluate("window.__watchers.size"), 1)

    def test_old_bridge_response_cannot_resolve_new_request(self):
        self.page.evaluate("window.__hold = true")
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("window.__openSettings()")
        old_ids = self.page.evaluate("window.__requests.map(request => request.id)")
        self.page.evaluate("document.getElementById('cdx-label-settings').remove()")
        self.page.add_script_tag(content=NEXT_SCRIPT)
        self.page.evaluate("window.__openSettings()")
        new_ids = self.page.evaluate("window.__requests.slice(3).map(request => request.id)")
        self.assertTrue(set(old_ids).isdisjoint(new_ids))
        self.page.evaluate("""() => {
          for (const request of window.__requests.slice(0,3))
            window[request.cb].resolve(request.id,true,window.__result(request.method));
        }""")
        self.assertTrue(self.page.locator("#cxm-settings-guide-text").is_disabled())
        self.page.evaluate("""() => {
          for (const request of window.__requests.slice(3))
            window[request.cb].resolve(request.id,true,window.__result(request.method));
        }""")
        self.page.wait_for_function("document.getElementById('cxm-settings-guide-text')?.value === 'Saved guide'")
        self.assertFalse(self.page.locator("#cxm-settings-guide-text").is_disabled())

    def test_legacy_installation_waits_for_new_window(self):
        self.page.evaluate("window.__cxmModelPicker = 4")
        self.page.add_script_tag(content=SCRIPT)
        self.assertEqual(self.page.evaluate("window.__cxmModelPicker"), 4)
        self.assertEqual(self.page.evaluate("window.__watchers.size"), 0)
        self.assertEqual(self.page.evaluate("document.adoptedStyleSheets.length"), 0)

    def test_web_effort_labels_save_and_reopen_with_the_selected_choice(self):
        self.page.evaluate("""() => {
          const original = window.__result;
          window.__webChoice = {model:'chatgpt-web',effort:'medium',fast:false};
          window.__result = method => {
            if (method === 'vocabularyModels') return [{id:'chatgpt-web',name:'ChatGPT 웹챗',efforts:['none','medium','high','xhigh'],defaultEffort:'medium',fast:false}];
            if (method === 'vocabularyModel') return {...window.__webChoice};
            if (method === 'vocabularySetModel') {
              const [model,effort] = window.__requests.at(-1).args;
              return (window.__webChoice = {...window.__webChoice,model,effort});
            }
            return original(method);
          };
        }""")
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("window.__openSettings()")
        self.page.wait_for_function("document.getElementById('cxm-settings-effort-select')?.options.length === 4")
        effort = self.page.get_by_label("추론 강도", exact=True)
        self.assertEqual(effort.locator("option").all_text_contents(), ["즉시 · Instant", "보통 · Medium", "높음 · High", "매우 높음 · Extra High"])
        effort.select_option("xhigh")
        self.page.wait_for_function("window.__webChoice.effort === 'xhigh' && !document.getElementById('cxm-settings-effort-select').disabled")
        self.assertEqual(self.page.evaluate("window.__requests.find(request => request.method === 'vocabularySetModel').args"), ["chatgpt-web", "xhigh"])
        self.page.evaluate("document.getElementById('cdx-label-settings').remove(); window.__openSettings()")
        self.page.wait_for_function("document.getElementById('cxm-settings-effort-select')?.value === 'xhigh'")
        self.assertTrue(self.page.locator("#cxm-settings-fast").is_disabled())

    def test_web_model_keeps_fast_disabled_without_catalog_flag(self):
        self.page.evaluate("window.__choice = {model:'chatgpt-web',effort:'medium',fast:false}")
        self.override_result("vocabularyModels", "return [{id:'chatgpt-web',name:'ChatGPT 웹챗',efforts:['none','medium','high','xhigh'],defaultEffort:'medium'}]")
        self.open_settings()
        self.assertTrue(self.page.locator("#cxm-settings-fast").is_disabled())
        self.assertIn("지원하지 않습니다", self.page.locator(".cxm-setting-toggle small").inner_text())

    def test_failed_fast_save_rolls_back_then_retry_reads_actual_setting(self):
        self.open_settings()
        self.page.evaluate("window.__hold = true")
        fast = self.page.locator("#cxm-settings-fast")
        fast.check()
        self.assertTrue(fast.is_disabled())
        self.resolve_last(False, "Disk write failed")
        self.assertIn("Disk write failed", self.wait_for_error())
        self.assertFalse(fast.is_checked())
        self.page.evaluate("window.__hold = false; window.__choice.fast = true")
        self.page.locator(".cxm-settings-model > .cxm-settings-retry").click()
        self.page.wait_for_function("document.getElementById('cxm-settings-fast').checked")
        self.assertFalse(fast.is_disabled())

    def test_partial_save_response_cannot_be_reported_as_success(self):
        self.open_settings()
        self.override_result("vocabularySetFast", "return {fast:true}")
        self.page.locator("#cxm-settings-fast").click()
        self.wait_for_error()
        self.assertFalse(self.page.locator("#cxm-settings-fast").is_checked())
        self.assertEqual(self.page.locator("#cxm-settings-model-select").input_value(), "model-a")

    def test_save_response_must_preserve_unchanged_model_fields(self):
        self.open_settings()
        self.override_result("vocabularySetFast", "return {model:'wrong-model',effort:'high',fast:true}")
        self.page.locator("#cxm-settings-fast").click()
        self.wait_for_error()
        self.assertEqual(self.page.locator("#cxm-settings-model-select").input_value(), "model-a")

    def test_model_switch_uses_supported_default_and_disables_fast(self):
        self.override_result("vocabularyModels", "return [{id:'model-a',name:'A',efforts:['high'],fast:true},{id:'model-b',name:'B',efforts:['low','medium'],defaultEffort:'medium',fast:false}]")
        self.open_settings()
        self.page.locator("#cxm-settings-model-select").select_option("model-b")
        self.page.wait_for_function("window.__choice.model === 'model-b' && !document.getElementById('cxm-settings-model-select').disabled")
        self.assertEqual(self.page.locator("#cxm-settings-effort-select").input_value(), "medium")
        self.assertTrue(self.page.locator("#cxm-settings-fast").is_disabled())

    def test_unknown_current_model_is_visible_and_can_be_replaced(self):
        self.page.evaluate("window.__choice.model = 'old-model'")
        self.open_settings()
        self.assertEqual(self.page.locator("#cxm-settings-model-select").input_value(), "old-model")
        self.assertTrue(self.page.locator("#cxm-settings-effort-select").is_disabled())
        self.assertTrue(self.page.locator("#cxm-settings-fast").is_disabled())
        self.page.locator("#cxm-settings-model-select").select_option("model-a")
        self.page.wait_for_function("window.__choice.model === 'model-a' && !document.getElementById('cxm-settings-effort-select').disabled")

    def test_unsupported_current_effort_is_preserved_until_user_changes_it(self):
        self.page.evaluate("window.__choice.effort = 'ultra'")
        self.open_settings()
        selected = self.page.locator("#cxm-settings-effort-select option:checked")
        self.assertIn("현재 지원 안 됨", selected.inner_text())
        self.assertIsNotNone(selected.get_attribute("disabled"))
        self.page.locator("#cxm-settings-effort-select").select_option("high")
        self.page.wait_for_function("window.__choice.effort === 'high' && !document.getElementById('cxm-settings-effort-select').disabled")

    def test_invalid_model_catalog_is_rejected(self):
        invalid = ["[]", "[{id:'a',name:'A',efforts:[]}]", "[{id:'a',name:'A',efforts:['bogus']}]",
                   "[{id:'a',name:'A',efforts:['high'],fast:'yes'}]",
                   "[{id:'a',name:'A',efforts:['high'],defaultEffort:'low'}]",
                   "[{id:'a',name:'A',efforts:['high']},{id:'a',name:'A',efforts:['high']}]",
                   "[{id:'a',name:5,efforts:['high']}]", "[{id:'a',name:'A',efforts:['high','high']}]"]
        original = self.page.evaluate("window.__result.toString()")
        for value in invalid:
            with self.subTest(value=value):
                self.page.evaluate("source => window.__result = eval('(' + source + ')')", original)
                self.override_result("vocabularyModels", "return " + value)
                self.page.add_script_tag(content=SCRIPT)
                self.page.evaluate("window.__openSettings()")
                self.wait_for_error()
                self.assertTrue(self.page.locator("#cxm-settings-model-select").is_disabled())
                self.assertFalse(self.page.locator(".cxm-settings-model > .cxm-settings-retry").is_disabled())
                self.page.evaluate("document.getElementById('cdx-label-settings').remove()")

    def test_guide_save_normalizes_text_and_reset_verifies_defaults(self):
        self.open_settings()
        guide = self.page.locator("#cxm-settings-guide-text")
        guide.fill("  Custom guide\nSecond line  ")
        self.page.get_by_role("button", name="지침 저장", exact=True).click()
        self.page.wait_for_function("window.__guide.custom && !document.getElementById('cxm-settings-guide-text').disabled")
        self.assertEqual(guide.input_value(), "Custom guide\nSecond line")
        self.assertTrue(self.page.get_by_role("button", name="지침 저장", exact=True).is_disabled())
        self.page.get_by_role("button", name="기본 지침으로 복원", exact=True).click()
        self.page.wait_for_function("!window.__guide.custom && !document.getElementById('cxm-settings-guide-text').disabled")
        self.assertEqual(guide.input_value(), "Saved guide")

    def test_guide_retry_preserves_draft_after_failed_save_and_failed_reload(self):
        self.open_settings()
        guide = self.page.locator("#cxm-settings-guide-text")
        guide.fill("Keep this unsaved draft")
        self.page.evaluate("window.__hold = true")
        self.page.get_by_role("button", name="지침 저장", exact=True).click()
        self.resolve_last(False, "Write failed")
        self.wait_for_error(".cxm-settings-guide")
        self.page.get_by_role("button", name="지침 다시 불러오기", exact=True).click()
        self.resolve_last(False, "Read failed")
        self.page.wait_for_function("!document.getElementById('cxm-settings-guide-text').disabled")
        self.assertEqual(guide.input_value(), "Keep this unsaved draft")
        self.page.evaluate("window.__hold = false; window.__guide.guide = 'Saved elsewhere'")
        self.page.get_by_role("button", name="지침 다시 불러오기", exact=True).click()
        self.page.wait_for_function("document.querySelector('.cxm-settings-guide > .cxm-settings-note[role=status]')?.textContent.includes('편집 중')")
        self.assertEqual(guide.input_value(), "Keep this unsaved draft")
        self.assertFalse(self.page.get_by_role("button", name="지침 저장", exact=True).is_disabled())

    def test_invalid_guide_limit_is_rejected_and_retry_recovers(self):
        self.override_result("vocabularyGuide", "return {...window.__guide,limit:-1}")
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("window.__openSettings()")
        self.wait_for_error(".cxm-settings-guide")
        self.assertTrue(self.page.locator("#cxm-settings-guide-text").is_disabled())
        self.override_result("vocabularyGuide", "return {...window.__guide}")
        self.page.get_by_role("button", name="지침 다시 불러오기", exact=True).click()
        self.page.wait_for_function("!document.getElementById('cxm-settings-guide-text').disabled")

    def test_guide_reset_rejects_custom_response_and_keeps_draft(self):
        self.open_settings()
        guide = self.page.locator("#cxm-settings-guide-text")
        guide.fill("Unsaved reset draft")
        self.override_result("vocabularySetGuide", "return {...window.__guide,guide:'Wrong custom guide',custom:true}")
        self.page.get_by_role("button", name="기본 지침으로 복원", exact=True).click()
        self.wait_for_error(".cxm-settings-guide")
        self.assertEqual(guide.input_value(), "Unsaved reset draft")

    def test_save_locks_all_sections_until_the_reply_arrives(self):
        self.open_settings(automation=True)
        self.page.locator("#cxm-settings-guide-text").fill("Pending guide")
        self.page.evaluate("window.__hold = true")
        self.page.get_by_role("button", name="지침 저장", exact=True).click()
        for selector in ["#cxm-settings-model-select", "#cxm-settings-fast", "#cxm-settings-guide-text", "#cxm-settings-threshold-label"]:
            self.assertTrue(self.page.locator(selector).is_disabled())
        self.assertEqual(self.page.locator('[data-settings-busy="true"]').count(), 1)
        before = self.page.evaluate("window.__requests.length")
        self.page.evaluate("document.getElementById('cxm-settings-fast').dispatchEvent(new Event('change'))")
        self.assertEqual(self.page.evaluate("window.__requests.length"), before)
        self.resolve_last(True, {"guide":"Pending guide","defaultGuide":"Saved guide","custom":True,"limit":4000})
        self.page.wait_for_function("!document.getElementById('cxm-settings-model-select').disabled")
        self.assertFalse(self.page.locator("#cxm-settings-threshold-label").is_disabled())
        self.assertEqual(self.page.locator('[data-settings-busy="true"]').count(), 0)

    def test_failed_label_save_unlock_keeps_invalid_model_controls_disabled(self):
        self.override_result("vocabularyModel", "return {model:'model-a',effort:'wrong',fast:false}")
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("window.__openSettings()")
        self.wait_for_error()
        self.page.evaluate("""() => {
          const dialog = document.getElementById('cdx-label-settings');
          dialog.setAttribute('aria-busy','true');
          dialog.querySelectorAll('input,select,textarea,button').forEach(node => node.disabled = false);
          dialog.removeAttribute('aria-busy');
          dialog.dispatchEvent(new Event('codex-labels:settings-unlocked'));
        }""")
        self.assertTrue(self.page.locator("#cxm-settings-model-select").is_disabled())

    def test_threshold_save_and_reset_update_outputs_and_notify_once_each(self):
        self.open_settings(automation=True)
        self.change_threshold(91)
        self.page.wait_for_function("window.__thresholds.label === .91 && !document.getElementById('cxm-settings-threshold-label').disabled")
        self.assertEqual(self.page.locator(".cxm-auto-row output").first.inner_text(), "91%")
        self.assertEqual(self.page.locator("#cxm-settings-threshold-label").get_attribute("aria-valuetext"), "91%")
        self.assertEqual(self.page.evaluate("window.__refreshes"), 1)
        self.page.get_by_role("button", name="기본값으로 복원", exact=True).click()
        self.page.wait_for_function("window.__thresholds.label === .8 && !document.getElementById('cxm-settings-threshold-label').disabled")
        self.assertEqual(self.page.evaluate("window.__refreshes"), 2)

    def test_threshold_save_rejects_invalid_or_mismatched_response(self):
        self.open_settings(automation=True)
        for response in ["{...window.__thresholds,label:.1}", "{...window.__thresholds,label:.8}", "{label:.91}"]:
            with self.subTest(response=response):
                self.override_result("thresholdsSet", "return " + response)
                slider = self.page.locator("#cxm-settings-threshold-label")
                self.change_threshold(91)
                self.wait_for_error(".cxm-settings-auto")
                self.assertEqual(slider.input_value(), "80")
                self.assertEqual(self.page.evaluate("window.__refreshes"), 0)

    def test_rejudge_requires_confirmed_true_before_refreshing(self):
        self.open_settings(automation=True)
        self.override_result("autoRefresh", "return {ok:true}")
        self.page.get_by_role("button", name="다시 판단", exact=True).click()
        self.wait_for_error(".cxm-settings-auto")
        self.assertEqual(self.page.evaluate("window.__refreshes"), 0)
        self.override_result("autoRefresh", "return true")
        self.page.get_by_role("button", name="다시 판단", exact=True).click()
        self.page.wait_for_function("window.__refreshes === 1")

    def test_invalid_automation_settings_leave_retry_enabled(self):
        self.override_result("autoSettings", "return {mode:'mica',available:'yes',thresholds:window.__thresholds,defaults:window.__thresholds}")
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("window.__openSettings(true)")
        self.wait_for_error(".cxm-settings-auto")
        self.assertTrue(self.page.locator("#cxm-settings-threshold-label").is_disabled())
        self.assertFalse(self.page.locator(".cxm-settings-auto button").last.is_disabled())

    def test_close_clears_pending_timers_and_late_replies_cannot_update_new_dialog(self):
        self.page.evaluate("window.__hold = true")
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("window.__openSettings(true)")
        self.assertEqual(self.page.evaluate("window.__timers.size"), 4)
        self.page.evaluate("document.getElementById('cdx-label-settings').remove()")
        self.page.wait_for_function("window.__timers.size === 0")
        self.page.evaluate("window.__openSettings(true)")
        self.page.evaluate("""() => {
          for (const request of window.__requests.slice(0,4))
            window[request.cb].resolve(request.id,true,window.__result(request.method,request.args));
        }""")
        self.assertTrue(self.page.locator("#cxm-settings-guide-text").is_disabled())
        self.page.evaluate("""() => {
          for (const request of window.__requests.slice(4))
            window[request.cb].resolve(request.id,true,window.__result(request.method,request.args));
        }""")
        self.page.wait_for_function("!document.getElementById('cxm-settings-guide-text').disabled")
        self.assertEqual(self.page.evaluate("window.__timers.size"), 0)

    def test_failed_parallel_model_load_cancels_sibling_request_timer(self):
        self.page.evaluate("window.__hold = true")
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("window.__openSettings()")
        self.page.evaluate("""() => {
          const request = window.__requests.find(request => request.method === 'vocabularyModels');
          window[request.cb].resolve(request.id,false,'Catalog unavailable');
        }""")
        self.wait_for_error()
        self.assertEqual(self.page.evaluate("window.__timers.size"), 1)
        self.assertFalse(self.page.locator(".cxm-settings-model > .cxm-settings-retry").is_disabled())

    def test_bridge_timeout_releases_save_lock_and_preserves_input(self):
        self.open_settings()
        guide = self.page.locator("#cxm-settings-guide-text")
        guide.fill("Timeout draft")
        self.page.evaluate("window.__hold = true")
        self.page.get_by_role("button", name="지침 저장", exact=True).click()
        self.page.evaluate("[...window.__timers.values()].forEach(callback => callback())")
        self.wait_for_error(".cxm-settings-guide")
        self.assertEqual(guide.input_value(), "Timeout draft")
        self.assertFalse(guide.is_disabled())
        self.assertEqual(self.page.locator('[data-settings-busy="true"]').count(), 0)
        self.assertEqual(self.page.evaluate("window.__timers.size"), 0)

    def test_missing_bridge_reports_error_without_leaking_timers(self):
        self.page.evaluate("delete window.__codexMemoBridge")
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("window.__openSettings()")
        self.assertIn("연결되지", self.wait_for_error())
        self.assertEqual(self.page.evaluate("window.__timers.size"), 0)

    def test_destroy_cleans_styles_watcher_and_pending_requests(self):
        self.page.evaluate("window.__hold = true")
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("window.__openSettings(); document.getElementById('cdx-label-settings').remove(); window.__cxmModelPickerRuntime.destroy()")
        self.assertEqual(self.page.evaluate("window.__timers.size"), 0)
        self.assertEqual(self.page.evaluate("window.__watchers.size"), 0)
        self.assertEqual(self.page.evaluate("document.adoptedStyleSheets.length"), 0)
        self.assertFalse(self.page.evaluate("Boolean(window.__cxmPicker || window.__cxmModelPickerRuntime)"))

    def test_streamed_elements_do_not_trigger_document_wide_queries(self):
        self.page.add_script_tag(content=SCRIPT)
        count = self.page.evaluate("""() => {
          let queries = 0;
          const original = document.querySelectorAll.bind(document);
          document.querySelectorAll = (...args) => { queries++; return original(...args); };
          try {
            for (let index = 0; index < 200; index++) {
              const node = document.createElement('p'); document.body.append(node);
              window.__watchers.forEach(hooks => hooks.added([node]));
            }
            return queries;
          } finally { document.querySelectorAll = original; }
        }""")
        self.assertEqual(count, 0)
        self.assertEqual(self.page.evaluate("window.__requests.length"), 0)

    def test_nodes_added_inside_open_dialog_do_not_requery_the_dialog(self):
        self.open_settings()
        count = self.page.evaluate("""async () => {
          const dialog = document.getElementById('cdx-label-settings');
          let queries = 0;
          dialog.querySelectorAll = (...args) => { queries++; return Element.prototype.querySelectorAll.apply(dialog, args); };
          try {
            for (let index = 0; index < 20; index++) {
              const node = document.createElement('span'); dialog.append(node);
              window.__watchers.forEach(hooks => hooks.added([node]));
              await new Promise(resolve => setTimeout(resolve));
            }
            return queries;
          } finally { delete dialog.querySelectorAll; }
        }""")
        self.assertEqual(count, 0)
        self.page.evaluate("""() => {
          const auto = document.createElement('section'); auto.className = 'cxm-settings-auto';
          document.getElementById('cdx-label-settings').append(auto);
        }""")
        self.page.wait_for_function("document.getElementById('cxm-settings-threshold-label')?.disabled === false")
        self.assertEqual(self.page.evaluate("window.__requests.length"), 4)

    def test_fallback_observer_mounts_and_retires_without_common_js(self):
        self.page.evaluate("delete window.__cxm")
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("window.__openSettings(true)")
        self.page.wait_for_function("!document.getElementById('cxm-settings-threshold-label')?.disabled")
        self.assertEqual(self.page.evaluate("window.__requests.length"), 4)
        self.page.evaluate("window.__hold = true; document.getElementById('cdx-label-settings').remove(); window.__openSettings(true)")
        self.page.wait_for_function("window.__timers.size === 4")
        self.page.evaluate("document.getElementById('cdx-label-settings').remove()")
        self.page.wait_for_function("window.__timers.size === 0")

    def test_repeated_dialog_open_close_mounts_each_section_once(self):
        self.page.add_script_tag(content=SCRIPT)
        for index in range(10):
            self.page.evaluate("window.__openSettings(true)")
            self.page.wait_for_function("!document.getElementById('cxm-settings-guide-text')?.disabled")
            self.assertEqual(self.page.evaluate("window.__requests.length"), 4 * (index + 1))
            self.assertEqual(self.page.locator("#cxm-settings-guide-text").count(), 1)
            self.page.evaluate("document.getElementById('cdx-label-settings').remove()")
        self.assertEqual(self.page.evaluate("window.__watchers.size"), 1)
        self.assertEqual(self.page.evaluate("document.adoptedStyleSheets.length"), 1)

    def test_unchanged_choices_do_not_send_save_requests(self):
        self.open_settings(automation=True)
        self.page.locator("#cxm-settings-model-select").dispatch_event("change")
        self.page.locator("#cxm-settings-effort-select").dispatch_event("change")
        self.change_threshold(80)
        self.assertEqual(self.page.evaluate("window.__requests.length"), 4)
        self.assertEqual(self.page.evaluate("window.__refreshes"), 0)

    def test_retired_section_cannot_cancel_requests_after_same_dom_is_remounted(self):
        self.page.evaluate("window.__hold = true")
        self.page.add_script_tag(content=SCRIPT)
        self.page.evaluate("""() => {
          window.__openSettings();
          const dialog = document.getElementById('cdx-label-settings');
          dialog.remove();
          window.__watchers.forEach(hooks => hooks.added([]));
          document.body.append(dialog);
          window.__watchers.forEach(hooks => hooks.added([dialog]));
        }""")
        self.assertEqual(self.page.evaluate("window.__requests.length"), 6)
        self.assertEqual(self.page.evaluate("window.__timers.size"), 3)
        self.page.evaluate("""() => {
          for (const request of window.__requests.slice(3))
            window[request.cb].resolve(request.id,true,window.__result(request.method,request.args));
        }""")
        self.page.wait_for_function("document.getElementById('cxm-settings-guide-text')?.value === 'Saved guide'")
        self.assertFalse(self.page.locator("#cxm-settings-model-select").is_disabled())

    def test_failed_model_reload_retains_last_verified_choice(self):
        self.open_settings()
        self.page.evaluate("window.__hold = true")
        self.page.locator("#cxm-settings-fast").check()
        self.resolve_last(False, "Save unconfirmed")
        self.wait_for_error()
        self.page.locator(".cxm-settings-model > .cxm-settings-retry").click()
        self.resolve_last(False, "Load failed")
        self.wait_for_error()
        self.assertEqual(self.page.locator("#cxm-settings-model-select").input_value(), "model-a")
        self.assertFalse(self.page.locator("#cxm-settings-model-select").is_disabled())
        self.assertFalse(self.page.locator("#cxm-settings-fast").is_checked())

    def test_removing_a_busy_section_unlocks_remaining_settings(self):
        self.open_settings(automation=True)
        self.page.evaluate("window.__hold = true")
        self.page.locator("#cxm-settings-fast").check()
        self.assertTrue(self.page.locator("#cxm-settings-threshold-label").is_disabled())
        self.page.evaluate("document.querySelector('.cxm-settings-model').remove()")
        self.page.wait_for_function("!document.getElementById('cxm-settings-threshold-label').disabled")
        self.assertEqual(self.page.evaluate("window.__timers.size"), 0)


if __name__ == "__main__":
    unittest.main()
