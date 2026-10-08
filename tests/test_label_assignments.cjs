'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createStore} = require('../labels/vendor/store.cjs');
const {canonical,withAliases,assignWithAliases,assignManyWithAliases} = require('../labels/assignment-aliases.cjs');
const defaults = require('../labels/default-labels.json');

const UUID = '00000000-0000-4000-8000-000000000001';
const LOCAL = `thread:local:thread:${UUID}`;
const REMOTE = `thread:remote-ssh-discovered:runner:thread:${UUID}`;
const DURABLE = `thread:durable:thread:${UUID}`;
const OTHER = 'project:unrelated';
const makeLabel = (id,kind = 'category',extra = {}) => ({...defaults.labels[0],id,kind,name:id,...extra});
function fixture(t,state,extraLabels = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'codex-label-assignments-'));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const config = structuredClone(defaults);
  // Exercise a real pre-kind config: old IDs, colors and settings stay intact.
  config.labels.forEach(label => { delete label.kind; });
  config.labels.push(makeLabel('dev'),makeLabel('docs'),makeLabel('disabled','category',{enabled:false}),...extraLabels);
  config.customSetting = {preserved:true};
  const configPath = path.join(directory,'labels.json');
  const assignmentsPath = path.join(directory,'assignments.json');
  fs.writeFileSync(configPath,JSON.stringify(config));
  if (state) fs.writeFileSync(assignmentsPath,JSON.stringify(state));
  return {directory,configPath,assignmentsPath,store:createStore(directory)};
}

test('legacy mixed assignments normalize without writing or dropping disabled/unknown IDs',t => {
  const legacy = {schemaVersion:1,assignments:{[LOCAL]:'in_progress','thread:old:thread:dev':'dev',
    'project:disabled':'disabled','project:unknown':'retired_category'},customData:{untouched:42}};
  const f = fixture(t,legacy);
  const before = fs.readFileSync(f.assignmentsPath);
  const configBefore = fs.readFileSync(f.configPath);
  const snapshot = f.store.snapshot();
  assert.deepEqual(snapshot.assignments,{[LOCAL]:'in_progress'});
  assert.deepEqual(snapshot.categoryAssignments,{'thread:old:thread:dev':'dev','project:disabled':'disabled','project:unknown':'retired_category'});
  assert.equal(snapshot.config.labels.find(l => l.id === 'in_progress').kind,'status');
  assert.equal(snapshot.config.labels.find(l => l.id === 'dev').kind,'category');
  assert.deepEqual(fs.readFileSync(f.assignmentsPath),before);
  assert.deepEqual(fs.readFileSync(f.configPath),configBefore);
  assert.deepEqual(fs.readdirSync(f.directory).sort(),['assignments.json','labels.json']);
});

test('explicit category map wins legacy category conflict and coexists with status',t => {
  const f = fixture(t,{schemaVersion:1,assignments:{[LOCAL]:'dev',[OTHER]:'completed'},
    categoryAssignments:{[LOCAL]:'docs',[OTHER]:'dev'}});
  assert.deepEqual(f.store.snapshot().assignments,{[OTHER]:'completed'});
  assert.deepEqual(f.store.snapshot().categoryAssignments,{[LOCAL]:'docs',[OTHER]:'dev'});
});

test('both independent assignments survive writes, reload and unrelated legacy data',t => {
  const f = fixture(t,{schemaVersion:1,assignments:{'project:disabled':'disabled','project:unknown':'retired_category'},customData:{untouched:42}});
  f.store.assign(LOCAL,'dev');
  const snapshot = f.store.assign(LOCAL,'completed');
  assert.equal(snapshot.assignments[LOCAL],'completed');
  assert.equal(snapshot.categoryAssignments[LOCAL],'dev');
  const saved = JSON.parse(fs.readFileSync(f.assignmentsPath,'utf8'));
  assert.equal(saved.schemaVersion,1);
  assert.deepEqual(saved.customData,{untouched:42});
  assert.equal(saved.categoryAssignments['project:disabled'],'disabled');
  assert.equal(saved.categoryAssignments['project:unknown'],'retired_category');
  assert.deepEqual(createStore(f.directory).snapshot(),snapshot);
});

test('clearing status defaults to status and clearing category preserves status',t => {
  const f = fixture(t);
  f.store.assign(LOCAL,'dev','category');
  f.store.assign(LOCAL,'completed','status');
  let snapshot = f.store.assign(LOCAL,null);
  assert.deepEqual(snapshot.assignments,{});
  assert.deepEqual(snapshot.categoryAssignments,{[LOCAL]:'dev'});
  f.store.assign(LOCAL,'in_progress');
  snapshot = f.store.assign(LOCAL,null,'category');
  assert.deepEqual(snapshot.assignments,{[LOCAL]:'in_progress'});
  assert.deepEqual(snapshot.categoryAssignments,{});
  assert.deepEqual(createStore(f.directory).snapshot(),snapshot);
});

test('custom explicit status IDs survive restart and infer their kind',t => {
  const f = fixture(t,undefined,[makeLabel('awaiting_input','status')]);
  f.store.assign(LOCAL,'dev');
  f.store.assign(LOCAL,'awaiting_input');
  const reloaded = createStore(f.directory).snapshot();
  assert.equal(reloaded.assignments[LOCAL],'awaiting_input');
  assert.equal(reloaded.categoryAssignments[LOCAL],'dev');
});

test('mixed kinds, unknown IDs and disabled labels reject before any assignment write',t => {
  const f = fixture(t,{schemaVersion:1,assignments:{[LOCAL]:'completed'},categoryAssignments:{[LOCAL]:'dev'}});
  const before = fs.readFileSync(f.assignmentsPath);
  for (const [id,kind] of [['dev','status'],['completed','category'],['disabled','category'],['missing','category'],['dev','invalid'],[null,null]]) {
    assert.throws(() => f.store.assign(LOCAL,id,kind));
    assert.deepEqual(fs.readFileSync(f.assignmentsPath),before);
  }
});

test('config edits preserve existing kind and metadata and return both assignment maps',t => {
  const f = fixture(t,{schemaVersion:1,assignments:{[LOCAL]:'completed'},categoryAssignments:{[LOCAL]:'dev'}});
  const initial = f.store.snapshot();
  const assignmentBytes = fs.readFileSync(f.assignmentsPath);
  const draft = structuredClone(initial.config);
  draft.labels.find(l => l.id === 'dev').name = '개발 작업';
  draft.labels.push(makeLabel('research','category'));
  const saved = f.store.saveConfig(draft,initial.configRevision);
  assert.deepEqual(saved.assignments,initial.assignments);
  assert.deepEqual(saved.categoryAssignments,initial.categoryAssignments);
  assert.deepEqual(fs.readFileSync(f.assignmentsPath),assignmentBytes);
  assert.deepEqual(saved.config.customSetting,{preserved:true});
  assert.deepEqual(saved.config.behavior,defaults.behavior);
  assert.equal(saved.config.labels.find(l => l.id === 'requested').backgroundColor,defaults.labels[0].backgroundColor);
  assert.equal(saved.config.labels.find(l => l.id === 'research').kind,'category');
  assert.equal(JSON.parse(fs.readFileSync(f.configPath,'utf8')).labels[0].kind,undefined);
});

test('normal config save cannot change an existing kind or omit a new kind',t => {
  const f = fixture(t);
  const initial = f.store.snapshot();
  const before = fs.readFileSync(f.configPath);
  const changed = structuredClone(initial.config);
  changed.labels.find(l => l.id === 'dev').kind = 'status';
  assert.throws(() => f.store.saveConfig(changed,initial.configRevision),/종류는 변경/);
  const missingKind = structuredClone(initial.config);
  const added = makeLabel('new_label');
  delete added.kind;
  missingKind.labels.push(added);
  assert.throws(() => f.store.saveConfig(missingKind,initial.configRevision),/종류를 선택/);
  assert.deepEqual(fs.readFileSync(f.configPath),before);
});

test('local aliases resolve status and category independently, each local value wins',() => {
  const snapshot = {assignments:{[REMOTE]:'requested',[LOCAL]:'completed'},categoryAssignments:{[DURABLE]:'dev'}};
  assert.equal(canonical(REMOTE),LOCAL);
  const aliased = withAliases(snapshot);
  assert.equal(aliased.assignments[LOCAL],'completed');
  assert.equal(aliased.categoryAssignments[LOCAL],'dev');
  assert.equal(snapshot.categoryAssignments[LOCAL],undefined);
  const reversed = withAliases({assignments:{[DURABLE]:'requested'},categoryAssignments:{[LOCAL]:'docs',[REMOTE]:'dev'}});
  assert.equal(reversed.assignments[LOCAL],'requested');
  assert.equal(reversed.categoryAssignments[LOCAL],'docs');
  assert.equal(withAliases(null),null);
});

test('alias writes synchronize only selected dimension and alias clears cannot resurrect it',t => {
  const f = fixture(t,{schemaVersion:1,assignments:{[REMOTE]:'requested',[DURABLE]:'in_progress',[OTHER]:'on_hold'},
    categoryAssignments:{[REMOTE]:'dev',[DURABLE]:'docs',[OTHER]:'dev'}});
  const originalCategories = f.store.snapshot().categoryAssignments;
  let snapshot = assignWithAliases(f.store,REMOTE,'completed','status');
  assert.deepEqual(snapshot.assignments,{[REMOTE]:'completed',[DURABLE]:'completed',[OTHER]:'on_hold',[LOCAL]:'completed'});
  assert.deepEqual(snapshot.categoryAssignments,originalCategories);
  snapshot = assignWithAliases(f.store,LOCAL,null,'status');
  assert.deepEqual(withAliases(snapshot).assignments,{[OTHER]:'on_hold'});
  assert.deepEqual(snapshot.categoryAssignments,originalCategories);
  const preservedStatuses = snapshot.assignments;
  snapshot = assignWithAliases(f.store,DURABLE,'dev');
  assert.deepEqual(snapshot.categoryAssignments,{[REMOTE]:'dev',[DURABLE]:'dev',[OTHER]:'dev',[LOCAL]:'dev'});
  assert.deepEqual(snapshot.assignments,preservedStatuses);
  snapshot = assignWithAliases(f.store,REMOTE,null,'category');
  assert.deepEqual(withAliases(snapshot).categoryAssignments,{[OTHER]:'dev'});
  assert.deepEqual(snapshot.assignments,preservedStatuses);
  assert.deepEqual(createStore(f.directory).snapshot(),snapshot);
});

test('host and conversation IDs containing colons retain canonical matching',() => {
  const key = `thread:remote-ssh-discovered:runner:thread:local:${UUID}`;
  assert.equal(canonical(key),`thread:local:thread:local:${UUID}`);
  assert.equal(canonical(OTHER),null);
});

test('assignMany sets or clears one label kind for several conversations without touching the other kind',t => {
  const A = `thread:local:local:local:${UUID}`, B = 'thread:local:local:local:00000000-0000-4000-8000-000000000002';
  const f = fixture(t,{schemaVersion:1,assignments:{[A]:'requested'},categoryAssignments:{[A]:'dev'}});
  let s = assignManyWithAliases(f.store,[A,B,A],'in_progress','status');
  assert.equal(s.assignments[A],'in_progress');
  assert.equal(s.assignments[B],'in_progress');
  assert.equal(s.categoryAssignments[A],'dev');
  s = assignManyWithAliases(f.store,[A,B],'docs','category');
  assert.deepEqual([s.categoryAssignments[A],s.categoryAssignments[B]],['docs','docs']);
  s = assignManyWithAliases(f.store,[A],null,'status');
  assert.equal(s.assignments[A],undefined);
  assert.equal(s.assignments[B],'in_progress');
  assert.throws(() => assignManyWithAliases(f.store,[],'docs','category'),/고르세요/);
  assert.throws(() => assignManyWithAliases(f.store,[A],'docs','other'),/종류/);
});

test('invalid later batch keys never leave earlier changes on disk',t => {
  const f = fixture(t,{schemaVersion:1,assignments:{[LOCAL]:'requested'},categoryAssignments:{[LOCAL]:'dev'}});
  const before = fs.readFileSync(f.assignmentsPath);
  for (const keys of [[LOCAL,'invalid'],[LOCAL,'thread:bad\nkey']]) {
    assert.throws(() => assignManyWithAliases(f.store,keys,'completed','status'),/식별자/);
    assert.deepEqual(fs.readFileSync(f.assignmentsPath),before);
    assert.throws(() => f.store.assignMany(keys,'completed','status'),/식별자/);
    assert.deepEqual(fs.readFileSync(f.assignmentsPath),before);
  }
});

test('a batch and all existing aliases commit once; repeated assignment and missing clears do not write',t => {
  const f = fixture(t,{schemaVersion:1,assignments:{[REMOTE]:'requested',[DURABLE]:'requested'},
    categoryAssignments:{[REMOTE]:'dev'},customData:{preserved:true}});
  const rename = t.mock.method(fs,'renameSync');
  const assigned = assignManyWithAliases(f.store,[REMOTE,LOCAL,OTHER],'completed','status');
  assert.equal(rename.mock.callCount(),1);
  assert.deepEqual(assigned.assignments,{[REMOTE]:'completed',[DURABLE]:'completed',[LOCAL]:'completed',[OTHER]:'completed'});
  assert.deepEqual(assigned.categoryAssignments,{[REMOTE]:'dev'});
  assert.deepEqual(JSON.parse(fs.readFileSync(f.assignmentsPath)).customData,{preserved:true});
  assignManyWithAliases(f.store,[REMOTE,LOCAL,OTHER],'completed','status');
  f.store.assign('project:missing',null,'status');
  assert.equal(rename.mock.callCount(),1);
  const cleared = assignManyWithAliases(f.store,[REMOTE,OTHER],null,'status');
  assert.equal(rename.mock.callCount(),2);
  assert.deepEqual(cleared.assignments,{});
  assert.deepEqual(cleared.categoryAssignments,{[REMOTE]:'dev'});
});

test('failed batch replacement preserves original file, cleans staging, and supports retry',t => {
  const f = fixture(t,{schemaVersion:1,assignments:{[REMOTE]:'requested',[DURABLE]:'in_progress'}});
  const before = fs.readFileSync(f.assignmentsPath);
  const rename = t.mock.method(fs,'renameSync',() => { throw Error('simulated disk failure'); });
  assert.throws(() => assignManyWithAliases(f.store,[REMOTE,OTHER],'completed','status'),/disk failure/);
  assert.deepEqual(fs.readFileSync(f.assignmentsPath),before);
  assert.equal(fs.readdirSync(f.directory).some(name => name.includes('.tmp-')),false);
  rename.mock.restore();
  const result = assignManyWithAliases(f.store,[REMOTE,OTHER],'completed','status');
  assert.equal(result.assignments[LOCAL],'completed');
  assert.deepEqual(createStore(f.directory).snapshot(),result);
});

test('batch result is independent from the persisted store',t => {
  const f = fixture(t);
  const result = f.store.assignMany([LOCAL,OTHER],'completed','status');
  result.assignments[LOCAL] = 'requested';
  result.config.labels[0].name = 'not saved';
  const actual = f.store.snapshot();
  assert.equal(actual.assignments[LOCAL],'completed');
  assert.notEqual(actual.config.labels[0].name,'not saved');
});

test('clearing aliases uses the state loaded by the transaction, including a late external alias',t => {
  const f = fixture(t,{schemaVersion:1,assignments:{[LOCAL]:'completed'},categoryAssignments:{[LOCAL]:'dev'}});
  const assignMany = f.store.assignMany;
  f.store.assignMany = (...args) => {
    const current = JSON.parse(fs.readFileSync(f.assignmentsPath,'utf8'));
    current.assignments[REMOTE] = 'requested';
    fs.writeFileSync(f.assignmentsPath,JSON.stringify(current));
    return assignMany(...args);
  };
  const result = assignWithAliases(f.store,LOCAL,null,'status');
  assert.deepEqual(withAliases(result).assignments,{});
  assert.deepEqual(result.categoryAssignments,{[LOCAL]:'dev'});
  assert.deepEqual(createStore(f.directory).snapshot(),result);
});
