const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createSettingsStore} = require('../dist/node/settings-store.cjs');
const {createDisplaySettings} = require('../dist/node/display-settings.cjs');

test('pet defaults off; both switches persist across a new store without losing other settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-display-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'settings.json'), store = createSettingsStore(file);
  store.update({subscriptionFeeKrw: 159000, petModel: {enabled: true}});
  let events = 0;
  const display = createDisplaySettings(store, () => events++);
  assert.deepEqual(display.read(), {petEnabled: false, showUsageAmount: true});
  display.set({petEnabled: true});
  display.set({showUsageAmount: false});
  assert.deepEqual(createDisplaySettings(createSettingsStore(file), () => {}).read(), {petEnabled: true, showUsageAmount: false});
  assert.equal(store.read().subscriptionFeeKrw, 159000);
  assert.deepEqual(store.read().petModel, {enabled: true});
  assert.equal(events, 2);
});

test('failed preference save does not announce or apply a change', () => {
  let events = 0;
  const display = createDisplaySettings({read: () => ({}), update: () => {throw Error('disk full');}}, () => events++);
  assert.throws(() => display.set({petEnabled: true}), /disk full/);
  assert.deepEqual(display.read(), {petEnabled: false, showUsageAmount: true});
  assert.equal(events, 0);
});

const {createDispatcher} = require('../dist/node/protocol.cjs');
test('wire settings accept booleans only and ignore unrelated fields', async () => {
  const {dispatch} = createDispatcher({displaySettingsSet: (_sender, patch) => patch});
  for (const value of ['false', 0, null, {}])
    await assert.rejects(dispatch('displaySettingsSet', 'test', [{petEnabled:value}]));
  assert.deepEqual(await dispatch('displaySettingsSet', 'test', [{petEnabled:true, showUsageAmount:false, unrelated:123}]), {petEnabled:true,showUsageAmount:false});
});
