// @ts-check
// 라벨 추천 백엔드(labels/label-suggest.cjs): 조절 가능한 기준, 직접 고를 때의 라벨별 확률, 다시 판단
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createLabelSuggester} = require('../labels/label-suggest.cjs');

const ID = '00000000-0000-4000-8000-000000000001';
function fixture(threshold) {
  let judged = 0;
  const server = {run: async work => work(async method => (method === 'thread/list'
    ? {data: [{id: ID, name: '대화', updatedAt: 5}]}
    : {thread: {name: '대화', turns: [{items: [{type: 'userMessage', text: '버튼 고쳐줘'}, {type: 'agentMessage', text: '고쳤습니다'}]}]}}))};
  const mica = {available: async () => true,
    choose: async () => { judged++; return {choice: 'dev', probabilities: {dev: 0.7, knowhow: 0.2, __none__: 0.1}}; }};
  const snapshot = () => ({config: {labels: [{id: 'dev', name: '개발', enabled: true}, {id: 'knowhow', name: '노하우', enabled: true},
    {id: 'completed', name: '완료', enabled: true}]}, assignments: {}});
  return {s: createLabelSuggester({server, mica, snapshot, threshold}), judged: () => judged};
}

test('기준을 낮추면 기억한 판단으로 바로 추천한다', async () => {
  let min = 0.8;
  const f = fixture(() => min);
  assert.deepEqual(await f.s.suggest([ID]), {[ID]: {labelId: 'dev', confidence: 0.7, confident: false}});   // 화면엔 '? 70%'
  min = 0.6;
  assert.deepEqual(await f.s.suggest([ID]), {[ID]: {labelId: 'dev', confidence: 0.7, confident: true}});
  assert.equal(f.judged(), 1);
});

test('직접 고를 때는 기준과 상관없이 라벨별 확률 ("해당 없음" 제외)', async () => {
  const f = fixture(() => 0.99);
  assert.deepEqual(await f.s.scores(ID), {dev: 0.7, knowhow: 0.2});
  await f.s.suggest([ID]);
  assert.equal(f.judged(), 1);   // 같은 판단을 함께 쓴다
});

test('clear() 하면 다시 판단한다', async () => {
  const f = fixture(() => 0.5);
  await f.s.suggest([ID]);
  f.s.clear();
  await f.s.suggest([ID]);
  assert.equal(f.judged(), 2);
});

test('App Server 로 읽을 수 없는 클라우드 대화는 화면이 준 제목으로 판단', async () => {
  const states = [];
  const server = {run: async work => work(async method => {
    if (method === 'thread/list') return {data: []};
    throw Error('thread not loaded');
  })};
  const mica = {available: async () => true,
    choose: async (state) => { states.push(state); return {choice: 'dev', probabilities: {dev: 0.9, __none__: 0.1}}; }};
  const s = createLabelSuggester({server, mica, snapshot: () => ({config: {labels: [{id: 'dev', name: '개발', enabled: true}]}, assignments: {}}),
    threshold: () => 0.6});
  assert.deepEqual(await s.suggest([ID]), {});                                  // 제목도 모르면 판단 안 함 (기억도 안 함)
  assert.deepEqual(await s.suggest([ID], {[ID]: '통합 업무 DB 구현'}), {[ID]: {labelId: 'dev', confidence: 0.9, confident: true}});
  assert.equal(states.at(-1), '대화 제목: 통합 업무 DB 구현');
});

test('화면이 읽어 준 클라우드 대화 요약이 있으면 제목 대신 요약으로 판단', async () => {
  const states = [];
  const server = {run: async work => work(async method => {
    if (method === 'thread/list') return {data: []};
    throw Error('thread not loaded');
  })};
  const mica = {available: async () => true,
    choose: async (state) => { states.push(state); return {choice: 'dev', probabilities: {dev: 0.8, __none__: 0.2}}; }};
  const s = createLabelSuggester({server, mica, snapshot: () => ({config: {labels: [{id: 'dev', name: '개발', enabled: true}]}, assignments: {}})});
  const digest = {title: '통합 업무 DB 구현', updatedAt: 7, firstUser: 'DB 스키마 만들어줘', lastUser: '마저 해줘', lastAgent: '테이블을 만들었습니다', finished: true};
  assert.equal((await s.suggest([ID], {[ID]: digest}))[ID].labelId, 'dev');
  assert.match(states.at(-1), /첫 요청: DB 스키마 만들어줘/);
  assert.match(states.at(-1), /마지막 답변: 테이블을 만들었습니다/);
});

test('category examples use only categoryAssignments and custom status kinds never enter criteria or scores',async () => {
  const example = '00000000-0000-4000-8000-000000000002';
  const wrongExample = '00000000-0000-4000-8000-000000000003';
  const calls = [];
  const server = {run: async work => work(async method => method === 'thread/list'
    ? {data:[{id:ID,name:'대상',updatedAt:5},{id:example,name:'실제 분류 예시'},{id:wrongExample,name:'상태 map 오염'}]}
    : {thread:{name:'대상',turns:[]}})};
  const snapshot = () => ({config:{labels:[{id:'dev',kind:'category',name:'개발',enabled:true},
    {id:'custom_status',kind:'status',name:'사용자 지정 상태',enabled:true},{id:'completed',name:'완료',enabled:true}]},
    assignments:{[`thread:local:thread:${wrongExample}`]:'dev'},categoryAssignments:{[`thread:local:thread:${example}`]:'dev'}});
  const mica = {available:async () => true,choose:async (_state,instructions,criteria) => {
    calls.push({instructions,criteria});
    return {choice:'dev',probabilities:{dev:0.7,custom_status:0.2,completed:0.05,__none__:0.05}};
  }};
  const s = createLabelSuggester({server,mica,snapshot});
  assert.deepEqual(await s.scores(ID),{dev:0.7});
  assert.match(calls[0].criteria.dev,/실제 분류 예시/);
  assert.doesNotMatch(calls[0].criteria.dev,/상태 map 오염/);
  assert.deepEqual(Object.keys(calls[0].criteria),['dev','__none__']);
  assert.match(calls[0].instructions,/완료·보류되었다는 이유만으로 해당 없음으로 바꾸지 마세요/);
  assert.match(calls[0].instructions,/원래 주된 작업 목적/);
});

test('legacy mocks still supply category examples while an explicit empty category map wins',async () => {
  const example = '00000000-0000-4000-8000-000000000002';
  const criteriaCalls = [];
  const state = {config:{labels:[{id:'dev',name:'개발',enabled:true}]},assignments:{[`thread:local:thread:${example}`]:'dev'}};
  const server = {run:async work => work(async method => method === 'thread/list'
    ? {data:[{id:ID,name:'대상',updatedAt:5},{id:example,name:'이전 분류 예시'}]}
    : {thread:{name:'대상',turns:[]}})};
  const mica = {available:async () => true,choose:async (_state,_instructions,criteria) => {
    criteriaCalls.push(criteria);return {choice:'dev',probabilities:{dev:0.9,__none__:0.1}};
  }};
  const s = createLabelSuggester({server,mica,snapshot:() => state});
  await s.scores(ID);
  assert.match(criteriaCalls[0].dev,/이전 분류 예시/);
  Object.assign(state,{categoryAssignments:{}});
  await s.scores(ID);
  assert.equal(criteriaCalls.length,2);
  assert.doesNotMatch(criteriaCalls[1].dev,/이전 분류 예시/);
});

test('category examples and label descriptions invalidate cached judgments without a thread edit',async () => {
  const example = '00000000-0000-4000-8000-000000000002';
  const criteriaCalls = [];
  const labels = [{id:'dev',kind:'category',name:'개발',description:'개발 작업',enabled:true},
    {id:'docs',kind:'category',name:'문서',enabled:true}];
  const state = {config:{labels},assignments:{},categoryAssignments:{}};
  const server = {run:async work => work(async method => method === 'thread/list'
    ? {data:[{id:ID,name:'대상',updatedAt:5},{id:example,name:'서버 작업'}]}
    : {thread:{name:'대상',turns:[]}})};
  const mica = {available:async () => true,choose:async (_state,_instructions,criteria) => {
    criteriaCalls.push(criteria);return {choice:'dev',probabilities:{dev:0.9,__none__:0.1}};
  }};
  const s = createLabelSuggester({server,mica,snapshot:() => state});
  await s.scores(ID);
  await s.scores(ID);
  assert.equal(criteriaCalls.length,1);
  state.categoryAssignments[`thread:local:thread:${example}`] = 'dev';
  await s.scores(ID);
  assert.equal(criteriaCalls.length,2);
  assert.match(criteriaCalls[1].dev,/서버 작업/);
  state.categoryAssignments[`thread:local:thread:${example}`] = 'docs';
  await s.scores(ID);
  assert.equal(criteriaCalls.length,3);
  assert.doesNotMatch(criteriaCalls[2].dev,/서버 작업/);
  assert.match(criteriaCalls[2].docs,/서버 작업/);
  labels[0].description = '새 개발 기준';
  await s.scores(ID);
  assert.equal(criteriaCalls.length,4);
  assert.match(criteriaCalls[3].dev,/새 개발 기준/);
  state.assignments[`thread:local:thread:${example}`] = 'completed';
  await s.scores(ID);
  assert.equal(criteriaCalls.length,4);
});
