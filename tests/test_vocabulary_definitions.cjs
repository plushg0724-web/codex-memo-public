'use strict';
// 사전적 의미(definitions)와 지금 문맥 번호(definitionIndex): 모델 답 다듬기, 저장·수정 뒤 유지, 예전 단어 형식 그대로
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createSummarizer, createVocabularyStore, buildPrompt, SCHEMA} = require('../labels/vendor/vocabulary.cjs');

const base = {meaning: '새 기능을 모두에게 정식 제공하다', usage: '새 사이드바 필터의 전체 공개', example: '', partOfSpeech: '동사구',
  explanation: '', tags: ['개발'], matchedId: ''};
const summarizerWith = answer => createSummarizer({executable: process.execPath, server: {run: async () => JSON.stringify(answer), close() {}}});

test('프롬프트와 출력 형식이 사전적 의미·문맥 번호를 요구한다', () => {
  const prompt = buildPrompt({term: 'roll out', context: 'We roll out next week'}, [], '');
  assert.match(prompt, /definitions 는 이 표현의 사전적 의미/);
  assert.match(prompt, /definitionIndex 는/);
  assert.match(prompt, /definitions, definitionIndex, meaning/);
  assert.ok(SCHEMA.required.includes('definitions') && SCHEMA.required.includes('definitionIndex'));
});

test('모델 답 다듬기: 빈 줄·긴 줄·5개 이상·범위 밖 번호', async () => {
  const long = 'x'.repeat(300);
  const draft = await summarizerWith({...base, definitions: ['  출시하다 ', '', long, '펴다', '일어나다', '다섯째'], definitionIndex: 7})
    .summarize('a', {term: 'roll out', context: 'roll out'});
  assert.deepEqual(draft.definitions, ['출시하다', 'x'.repeat(200), '펴다', '일어나다']);
  assert.equal(draft.definitionIndex, -1, '없는 번호는 사전에 없는 쓰임(-1)');
  const ok = await summarizerWith({...base, definitions: ['출시하다', '펴다'], definitionIndex: 0}).summarize('a', {term: 'roll out', context: ''});
  assert.equal(ok.definitionIndex, 0);
  const none = await summarizerWith({...base, definitions: [], definitionIndex: 0}).summarize('a', {term: 'roll out', context: ''});
  assert.equal('definitions' in none, false, '사전 뜻이 없으면 칸을 만들지 않는다');
});

test('저장·수정 뒤에도 유지되고, 사전 뜻 없는 예전 단어는 형식이 그대로', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxm-defs-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const store = createVocabularyStore(dir);
  const draft = await summarizerWith({...base, definitions: ['출시하다', '펴다'], definitionIndex: 0}).summarize('a', {term: 'roll out', context: 'ctx'});
  let snap = store.save({...draft, savedAt: Date.now()}, store.read().revision, {mode: 'add'});
  const old = await summarizerWith({...base, meaning: '예전 뜻', definitions: []}).summarize('a', {term: 'ship', context: 'ctx'});
  snap = store.save({...old, savedAt: Date.now()}, snap.revision, {mode: 'add'});
  const saved = snap.entries.find(e => e.term === 'roll out');
  assert.deepEqual([saved.definitions, saved.definitionIndex], [['출시하다', '펴다'], 0]);
  snap = store.edit(saved.id, {meaning: '고친 뜻'}, snap.revision);
  assert.deepEqual(snap.entries.find(e => e.id === saved.id).definitions, ['출시하다', '펴다'], '다른 칸을 고쳐도 유지');
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'vocabulary.json'), 'utf8'));
  const shipRow = file.entries.find(e => e.term === 'ship');
  assert.equal('definitions' in shipRow || 'definitionIndex' in shipRow, false);
  // 예전 단어에 나중에 채우기 (같은 뜻으로 판단됐을 때 화면이 보내는 수정)
  snap = store.edit(shipRow.id, {definitions: ['배송하다', '출시하다'], definitionIndex: 1}, snap.revision);
  assert.equal(snap.entries.find(e => e.id === shipRow.id).definitionIndex, 1);
  assert.throws(() => store.edit(shipRow.id, {definitions: ['a', 'b', 'c', 'd', 'e']}, snap.revision), /최대 4개/);
});

test('첫 요약의 자세한·쉬운 설명·예시는 기본 질문의 추가 답변으로 들어온다', async () => {
  const {PRESETS} = require('../labels/vocabulary-content.js');
  assert.ok(['detailed', 'easy', 'examples'].every(f => SCHEMA.required.includes(f)));
  assert.match(buildPrompt({term: 'x', context: ''}, [], '사용자 지침'), /추가 설명 지침:\ndetailed 는/, '작성 지침을 바꿔도 고정 문구는 남는다');
  const draft = await summarizerWith({...base, definitions: [], definitionIndex: -1, detailed: ' 자세히\r\n\r\n둘째 ', easy: '', examples: '예1\n\n예2'})
    .summarize('a', {term: 'roll out', context: ''});
  assert.deepEqual(draft.followups.map(f => [f.question, f.answer]), [[PRESETS[0].question, '자세히\n\n둘째'], [PRESETS[2].question, '예1\n\n예2']], '빈 설명은 건너뛴다');
  const old = await summarizerWith({...base, definitions: [], definitionIndex: -1}).summarize('a', {term: 'ship', context: ''});
  assert.equal('followups' in old, false, '설명이 없으면 칸을 만들지 않는다');
});

test('맥락분석 표시와 다른 문장 분석은 저장·수정·교체 후에도 보존된다', async () => {
  const {randomUUID} = require('node:crypto');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'context-analysis-'));
  try {
    const store=createVocabularyStore(directory);
    const draft=await summarizerWith({...base,definitions:[],definitionIndex:-1}).summarize('a',{term:'route',context:'original sentence'});
    let snap=store.save(draft,store.read().revision,{mode:'add'});
    const analysis={id:randomUUID(),context:'another sentence',analysis:'new analysis',source:{title:'test',path:'/thread'},createdAt:1,visible:true};
    snap=store.edit(draft.id,{showContextAnalysis:false,contextAnalyses:[analysis]},snap.revision);
    const stored=store.read().entries[0];
    assert.equal(stored.meaning,base.meaning);assert.equal(stored.showContextAnalysis,false);
    assert.deepEqual(stored.contextAnalyses,[analysis]);
    assert.throws(()=>store.edit(draft.id,{contextAnalyses:[{...analysis,source:{path:'https://external.test'}}]},snap.revision),/경로/);
    assert.throws(()=>store.edit(draft.id,{contextAnalyses:Array.from({length:51},()=>analysis)},snap.revision),/50/);
    assert.throws(()=>store.edit(draft.id,{status:'known'},'0'.repeat(64)),/다른 창/);
    snap=store.save({...draft,meaning:'revised base'},snap.revision,{mode:'replace',targetId:draft.id});
    assert.deepEqual(snap.entries[0].contextAnalyses,[analysis]);assert.equal(snap.entries[0].showContextAnalysis,false);
    snap=store.edit(draft.id,{contextAnalyses:[{...analysis,visible:false}]},snap.revision);
    assert.equal(snap.entries[0].contextAnalyses[0].analysis,'new analysis');
    assert.equal(snap.entries[0].contextAnalyses[0].visible,false);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
