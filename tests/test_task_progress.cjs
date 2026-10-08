'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const m = require('../labels/task-progress-model.js');
const document = (changes = {}) => ({formatVersion: 1,
  source: {kind: 'space', label: 'Explicit test snapshot', ref: 'fixture', url: 'https://example.test/source', updatedAt: '2026-10-08T13:00:00+09:00'},
  projects: [{id: 'erp', stage: '검토', checklist: {complete: true, items: [
    {id: 'a', text: '가져오기', done: true}, {id: 'b', text: '검토하기', done: false},
  ]}}], ...changes});

test('only an explicitly complete nonempty checklist produces a percentage', () => {
  const row = m.rows(m.normalize(document()))[1];
  assert.deepEqual(row.progress, {done: 1, total: 2, percent: 50});
  assert.equal(row.stage, '검토');
  for (const complete of [true, false]) {
    assert.equal(m.progress({complete, items: []}).percent, null);
  }
  assert.deepEqual(m.progress({complete: false, items: [{done: true}, {done: false}]}), {done: 1, total: 2, percent: null});
  assert.deepEqual(m.progress(null), {done: null, total: null, percent: null});
  assert.equal(m.progress({complete: true, items: [{done: false}]}).percent, 0);
  assert.equal(m.progress({complete: true, items: [{done: true}]}).percent, 100);
});

test('missing projects and sample descriptions never become progress', () => {
  assert.deepEqual(m.rows(null).map(row => [row.id, row.stage, row.progress.percent]),
    ['mmh', 'erp', 'sns', 'openproject'].map(id => [id, '미정', null]));
  const sample = m.sample();
  assert.equal(sample.source.kind, 'sample');
  assert.equal(sample.source.updatedAt, null);
  assert.match(sample.projects[1].summary, /가상 자료/);
  assert.ok(m.rows(sample).every(row => row.progress.percent === null));
  assert.ok(m.rows(m.normalize(document({projects: [{id: 'erp', stage: '완료', percent: 100, percentageDone: 90}]})))
    .every(row => row.progress.percent === null));
});

test('source provenance, timezone and per-project source survive normalization', () => {
  const input = document();
  input.projects[0].source = {kind: 'openproject', label: '업무 패키지', ref: '42', url: 'https://example.test/work/42'};
  const result = m.normalize(input);
  assert.equal(result.source.updatedAt, '2026-10-08T04:00:00.000Z');
  assert.equal(result.projects[0].source.kind, 'openproject');
  assert.equal(result.projects[0].source.updatedAt, null);
  input.projects[0].checklist.items[0].done = false;
  assert.equal(result.projects[0].checklist.items[0].done, true);
  assert.deepEqual(m.normalize(result), result);
});

test('unsafe links are omitted, content remains plain data', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/a', '//example.test', 'https://user:password@example.test'])
    assert.equal(m.safeUrl(url), null);
  const result = m.normalize(document({projects: [{id: 'erp', stage: '<img src=x onerror=alert(1)>'}]}));
  assert.equal(result.projects[0].stage, '<img src=x onerror=alert(1)>');
  assert.equal(m.safeUrl('https://example.test/path?q=1'), 'https://example.test/path?q=1');
});

test('invalid schema, duplicate ids and ambiguous checklist values fail visibly', () => {
  const badProjects = [
    [{id: 'elsewhere'}], [{id: 'erp'}, {id: 'erp'}],
    [{id: 'erp', checklist: {items: []}}],
    [{id: 'erp', checklist: {complete: true, items: [{id: 'a', text: 'x', done: 'false'}]}}],
    [{id: 'erp', checklist: {complete: true, items: [{id: 'a', text: 'x', done: true}, {id: ' a ', text: 'y', done: false}]}}],
    [{id: 'erp', blockers: 'blocked'}], [{id: 'erp', stage: 'x'.repeat(161)}],
  ];
  for (const projects of badProjects) assert.throws(() => m.normalize(document({projects})));
  for (const invalid of [null, [], {}, document({formatVersion: 2}), document({source: {kind: 'space'}})])
    assert.throws(() => m.normalize(invalid));
  assert.throws(() => m.normalize(document({source: {kind: 'space', label: 'x', updatedAt: '2026-10-08'}})));
  assert.throws(() => m.parse('{'), /JSON/);
  assert.throws(() => m.parse('가'.repeat(m.MAX_BYTES / 2)), /128 KiB/);
});

test('Space and OpenProject adapters read only on request and propagate failures', async () => {
  for (const kind of ['space', 'openproject']) {
    let reads = 0;
    const value = document(); value.source.kind = kind;
    const adapter = m.createAdapter(kind, () => { reads++; return JSON.stringify(value); });
    assert.equal(reads, 0);
    assert.equal((await adapter.read()).source.kind, kind);
    assert.equal(reads, 1);
  }
  await assert.rejects(m.createAdapter('space', () => document({source: {kind: 'openproject', label: 'x'}})).read(), /출처/);
  await assert.rejects(m.createAdapter('space', () => { throw Error('read unavailable'); }).read(), /read unavailable/);
});

test('browser injection does not replace an Electron host module export', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const hostExports = {host: true};
  const context = {window: {}, module: {exports: hostExports}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../labels/task-progress-model.js'), 'utf8'), context);
  assert.equal(context.module.exports, hostExports);
  assert.equal(typeof context.window.__cxmTaskProgressModel.normalize, 'function');
});
