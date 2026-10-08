'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createPetModel, normalize} = require('../labels/pet-model.cjs');
const {createTaskPet} = require('../labels/task-pet.cjs');
const item = {id: 'thread:a', threadId: 'a', title: '배포 확인', state: 'check', action: '확인해 주세요.', quote: '재시작 후 확인해야 합니다.', quoteKind: 'agent', labelName: '', updatedAt: 1};
test('default Luna high request uses bounded evidence, no FAST; generation stays on provided IDs', async () => {
  let request;
  const model = createPetModel({server: {run: async r => {request = r; return JSON.stringify({items: [{id: item.id, action: '재시작 후 결과를 확인해 주세요.'}]});}}, settings: () => ({}), saveSettings: () => {}});
  const result = await model.advise([item]);
  assert.equal(request.model, 'gpt-6-luna'); assert.equal(request.effort, 'high'); assert.equal(request.fast, false);
  assert.equal(result[0].adviceModel, 'gpt-6-luna'); assert.equal(result[0].quote, item.quote);
  assert.match(request.prompt, /확신도 숫자를 만들지/);
});
test('invalid settings and failed commits preserve previous settings; disabled advice does not call model', async () => {
  let saved = {unrelated: {keep: true}};
  const model = createPetModel({server: {run: () => {throw Error('must not run');}}, settings: () => saved, saveSettings: patch => {saved = {...saved, ...patch};}});
  for (const bad of [{threshold: NaN}, {count: 0}, {enabled: 'yes'}, {guide: ''}, {model: 'bad\nmodel'}, {effort: 'invented'}]) assert.throws(() => model.save(bad));
  model.save({enabled: false, threshold: 0.9, count: 5});
  assert.deepEqual(await model.advise([item]), [item]); assert.equal(saved.unrelated.keep, true);
  const failed = createPetModel({server: {}, settings: () => saved, saveSettings: () => {throw Error('disk');}});
  assert.throws(() => failed.save({count: 2}), /disk/); assert.equal(failed.read().count, 5);
});
test('model cannot inject candidate IDs, reorder candidates or return empty actions', async () => {
  for (const response of [{items: []}, {items: [{id: 'injected', action: 'x'}]}, {items: [{id: item.id, action: ''}]}]) {
    const model = createPetModel({server: {run: async () => JSON.stringify(response)}, settings: () => ({}), saveSettings: () => {}});
    await assert.rejects(model.advise([item]));
  }
});
function fixture(advise) {
  const id='00000001-0000-4000-8000-000000000001';
  let status = 'in_progress';
  const config=normalize();
  const pet=createTaskPet({mica:{ask:async()=>({end:{choice:'check',probabilities:{ask:0.02,check:0.94,blocked:0.02,done:0.02}}})},
    settings:()=>config, advise: async items => advise(items, () => {status='completed';}),
    getSnapshot:()=>({config:{labels:[{id:'in_progress',enabled:true,name:'진행'}]},assignments:{[`thread:local:thread:${id}`]:status}}),
    getThreads:async()=>[{id,hostId:'local',name:'test',updatedAt:Date.now()/1000}],getMemos:async()=>[],
    getLastTurns:async()=>({[id]:{status:'completed',completedAt:1,agentText:'직접 확인해야 합니다.',userText:'확인해줘'}})});
  return pet;
}
test('completion during model inference removes obsolete recommendation', async () => {
  const result=await fixture(async(items,complete)=>{complete();return items;}).suggest();
  assert.equal(result.items.length,0);
});
test('model failure returns evidence with explicit fallback notice', async () => {
  // stable timestamps matter to the final source comparison
  const now = Date.now; Date.now = () => 1800000000000;
  try {
    const result=await fixture(async()=>{throw Error('no access');}).suggest();
    assert.equal(result.items.length,1); assert.match(result.notice,/설명을 받지 못해/);
  } finally { Date.now = now; }
});
