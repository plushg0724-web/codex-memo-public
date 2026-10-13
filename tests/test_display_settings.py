"""Saved display switches control real widget lifecycles without provider calls."""
import os
import json
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright
from test_model_picker import MOCKS

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ['display-settings.js', 'model-picker.js', 'task-pet.js', 'subscription-usage.js']
FIXTURE = r"""
window.__savedDisplay = {petEnabled:false, showUsageAmount:true};
window.__failSave = false; window.__petCalls = 0; window.__changes = new Set();
window.codexLabels.onChanged = fn => { window.__changes.add(fn); return () => window.__changes.delete(fn); };
window.codexLabels.taskPetSuggest = async () => { window.__petCalls++; return {status:'ok',items:[]}; };
window.__cxm.sidebarTools = () => document.querySelector('.sidebar-tools');
const original = window.__result;
window.__result = (method, args) => {
  if (method === 'displaySettingsSet') window.__savedDisplay = {...window.__savedDisplay,...args[0]};
  if (method.startsWith('displaySettings')) return {...window.__savedDisplay};
  if (method === 'subscriptionUsage') return {status:'ready',feeKrw:159000,dailyKrw:5300,observedAt:Date.now(),window:{
    usedKrw:11872,subscriptionPercent:7.47,windowDurationMins:10080,resetsAt:2000000000,usedPercent:32}};
  return original(method,args);
};
const bridge = window.__codexMemoBridge;
window.__codexMemoBridge = raw => {
  const m = JSON.parse(raw);
  if (window.__failSave && m.method === 'displaySettingsSet') {
    window.__requests.push(m); queueMicrotask(() => window[m.cb].resolve(m.id,false,'저장 실패')); return;
  }
  bridge(raw);
};
window.__openDisplay = () => {
  const dialog = document.createElement('dialog'); dialog.id = 'cdx-label-settings';
  const panel = document.createElement('section'); panel.setAttribute('role','tabpanel');
  panel.innerHTML = '<h3>단어장 요약</h3><div class="cxm-settings-model"></div>';
  dialog.append(panel); document.body.append(dialog); dialog.show();
};
"""


class DisplaySettingsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(channel=os.environ.get('PLAYWRIGHT_CHANNEL', 'chrome'), headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width': 1000, 'height': 900})
        self.addCleanup(self.page.close)
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.route('https://codex.test/**', lambda route: route.fulfill(
            body='<html><body style="background:#202020;color:#eee"><nav class="sidebar-navigation"><div class="sidebar-tools"></div></nav></body></html>', content_type='text/html'))
        self.page.goto('https://codex.test/index.html')
        self.page.clock.install()
        self.page.add_script_tag(content=MOCKS)
        self.page.add_script_tag(content=FIXTURE)
        self.inject()

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def inject(self):
        for name in SCRIPTS:
            self.page.add_script_tag(content=(ROOT / 'labels' / name).read_text())
        self.page.clock.run_for(25)

    def open_settings(self):
        self.page.evaluate('window.__openDisplay()')
        self.page.wait_for_function("document.getElementById('cxm-settings-petEnabled')?.disabled === false")

    def toggle(self, name, enabled):
        self.page.locator('#cxm-settings-' + name).set_checked(enabled)
        self.page.wait_for_function('(key) => !document.getElementById("cxm-settings-"+key).disabled', arg=name)

    def test_default_pet_off_and_setting_enables_then_disposes_it(self):
        self.page.clock.run_for(65000)
        self.assertEqual(self.page.locator('#cxm-task-pet').count(), 0)
        self.assertEqual(self.page.evaluate('window.__petCalls'), 0)
        self.open_settings()
        self.toggle('petEnabled', True)
        self.assertEqual(self.page.locator('#cxm-task-pet').count(), 1)
        self.inject()
        self.assertEqual(self.page.locator('#cxm-task-pet').count(), 1)
        self.toggle('petEnabled', False)
        self.page.clock.run_for(65000)
        self.assertEqual(self.page.locator('#cxm-task-pet').count(), 0)
        self.assertEqual(self.page.evaluate('window.__petCalls'), 0)

    def test_hidden_usage_stops_polling_survives_reconnect_and_can_be_restored(self):
        self.page.locator('.cxm-subscription').click()
        self.assertEqual(self.page.locator('#cxm-subscription-dialog[open]').count(), 1)
        self.page.evaluate("window.__savedDisplay.showUsageAmount=false; window.__changes.forEach(fn=>fn())")
        self.page.wait_for_selector('.cxm-subscription', state='detached')
        self.assertEqual(self.page.locator('#cxm-subscription-dialog').count(), 0)
        calls = self.page.evaluate("window.__requests.filter(x=>x.method==='subscriptionUsage').length")
        self.page.clock.run_for(65000)
        self.page.evaluate('window.__cxmDisplay.destroy()')
        self.inject()
        self.assertEqual(self.page.locator('.cxm-subscription').count(), 0)
        self.assertEqual(self.page.evaluate("window.__requests.filter(x=>x.method==='subscriptionUsage').length"), calls)
        self.open_settings()
        self.assertFalse(self.page.locator('#cxm-settings-showUsageAmount').is_checked())
        self.toggle('showUsageAmount', True)
        self.assertIn('11,872', self.page.locator('.cxm-subscription').inner_text())
        self.toggle('showUsageAmount', False)
        self.assertEqual(self.page.locator('.cxm-subscription').count(), 0)

    def test_save_failure_keeps_previous_setting_and_retry_works(self):
        self.open_settings()
        self.page.evaluate('window.__failSave=true')
        self.page.locator('#cxm-settings-petEnabled').click()
        self.page.wait_for_selector('.cxm-settings-display [role=alert]')
        self.assertFalse(self.page.locator('#cxm-settings-petEnabled').is_checked())
        self.assertEqual(self.page.locator('#cxm-task-pet').count(), 0)
        self.assertIn('저장 실패', self.page.locator('.cxm-settings-display [role=alert]').inner_text())
        self.page.evaluate('window.__failSave=false')
        self.toggle('petEnabled', True)
        self.page.evaluate("document.getElementById('cdx-label-settings').remove(); window.__cxmDisplay.destroy()")
        self.inject(); self.open_settings()
        self.assertTrue(self.page.locator('#cxm-settings-petEnabled').is_checked())
        self.assertEqual(self.page.locator('#cxm-task-pet').count(), 1)
        output = ROOT / 'output/playwright/display-settings'
        output.mkdir(parents=True, exist_ok=True)
        self.page.screenshot(path=str(output / 'settings.png'))

    def test_old_pet_is_retired_and_late_read_cannot_undo_newer_settings(self):
        self.page.evaluate('window.__cxmDisplay.apply({petEnabled:true,showUsageAmount:true}); window.__cxmDisplay.version=0; window.__hold=true')
        self.page.add_script_tag(content=(ROOT / 'labels/display-settings.js').read_text())
        self.assertEqual(self.page.locator('#cxm-task-pet').count(), 0)
        self.page.evaluate("""() => {
          const m=window.__requests.at(-1);
          window.__cxmDisplay.apply({petEnabled:false,showUsageAmount:false});
          window[m.cb].resolve(m.id,true,{petEnabled:true,showUsageAmount:true});
        }""")
        self.page.add_script_tag(content=(ROOT / 'labels/task-pet.js').read_text())
        self.page.add_script_tag(content=(ROOT / 'labels/subscription-usage.js').read_text())
        self.assertEqual(self.page.locator('#cxm-task-pet,.cxm-subscription').count(), 0)

    def test_real_settings_dialog_exposes_switches_in_vocabulary_tab(self):
        config = json.loads((ROOT / 'labels/default-labels.json').read_text())
        self.page.evaluate('''config => {
          window.codexLabels.read = async () => ({snapshotVersion:'1',configRevision:'1',config,assignments:{},categoryAssignments:{}});
        }''', config)
        self.page.add_style_tag(content='input[type=checkbox] {appearance:none; width:0; height:0; opacity:0}')
        self.page.add_script_tag(content=(ROOT / 'labels/vendor/renderer.js').read_text())
        self.page.evaluate("window.dispatchEvent(new CustomEvent('codex-labels:open-settings',{detail:{tab:'vocabulary'}}))")
        self.page.wait_for_function("document.getElementById('cxm-settings-petEnabled')?.disabled === false")
        self.assertTrue(self.page.locator('#cdx-settings-panel-vocabulary .cxm-settings-display').is_visible())
        self.assertEqual(self.page.locator('#cxm-settings-petEnabled').evaluate('e=>getComputedStyle(e).appearance'), 'checkbox')
        self.toggle('petEnabled', True)
        self.toggle('showUsageAmount', False)
        self.assertEqual(self.page.locator('.cxm-subscription').count(), 0)
        output = ROOT / 'output/playwright/display-settings'
        output.mkdir(parents=True, exist_ok=True)
        self.page.screenshot(path=str(output / 'real-settings.png'))


if __name__ == '__main__':
    unittest.main()
