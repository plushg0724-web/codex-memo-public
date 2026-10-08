'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createVocabularyService} = require('../dist/node/vocabulary-service.cjs');
const entry = id => ({id, term:'Cache', meaning:id, context:'saved context', model:'fixture', effort:'low', savedAt:1});
const deferred = () => {let resolve; const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(overrides={}) {
  let snapshot={revision:'r1',version:2,entries:[entry('a'),entry('b')]};
  const saved=[], cancelled=[];
  const service=createVocabularyService({
    store:{read:()=>snapshot,save(draft,revision,options){assert.equal(revision,snapshot.revision);saved.push({draft,options});return snapshot;}},
    summarizer:{summarize:async()=>entry('draft'),cancel:sender=>cancelled.push(sender),dispose(){}},
    server:{run:async()=>JSON.stringify({answer:'More detail.'}),close(){}},
    mica:{rankSenses:async()=>({probabilities:{a:0.1,b:0.9}})},
    options:known=>({model:'fixture',effort:'low',fast:false,guide:'',known}),...overrides
  });
  return {service,saved,cancelled,setSnapshot:value=>{snapshot=value;}};
}

test('a cancelled late result cannot replace a newer draft for the same window', async()=>{
  const first=deferred(), second=deferred();let calls=0;
  const {service,saved}=fixture({summarizer:{summarize:()=>++calls===1?first.promise:second.promise,cancel(){},dispose(){}}});
  const old=service.summarize('window',{term:'one'});
  const rejected=assert.rejects(old,/취소/);
  service.cancel('window');
  const current=service.summarize('window',{term:'two'});
  second.resolve(entry('new'));await current;
  first.resolve(entry('old'));await rejected;
  service.save('window','new','r1');
  assert.equal(saved[0].draft.id,'new');
});

test('concurrent generation is rejected without interrupting the first request', async()=>{
  const pending=deferred();let calls=0;
  const {service}=fixture({summarizer:{summarize(){calls++;return pending.promise;},cancel(){},dispose(){}}});
  const first=service.summarize('window',{term:'Cache'});
  await assert.rejects(service.reanalyze('window','a','r1'),/이미/);
  pending.resolve(entry('draft'));await first;
  service.save('window','draft','r1');assert.equal(calls,1);
});

test('reanalyzed drafts require their original entry and revision and keep identity', async()=>{
  const {service,saved}=fixture();
  const draft=await service.reanalyze('window','a','r1');
  assert.equal(draft.id,'a');assert.equal(draft.savedAt,1);
  assert.throws(()=>service.save('window','a','r1',{mode:'add'}),/원본/);
  assert.throws(()=>service.save('window','a','r2',{mode:'replace',targetId:'a'}),/원본/);
  service.save('window','a','r1',{mode:'replace',targetId:'a'});
  assert.equal(saved[0].draft.action,'reanalyze');
});

test('followup uses the same save lifecycle and reset discards unsaved results', async()=>{
  const {service}=fixture();
  const draft=await service.followup('window','a','Explain expiry','r1');
  assert.equal(draft.followups[0].answer,'More detail.');
  service.reset();
  assert.throws(()=>service.save('window','a','r1',{mode:'replace',targetId:'a'}),/다시/);
});

test('reanalyzing adds missing preset explanations while preserving saved answers and identity', async()=>{
  const {PRESETS} = require('../labels/vocabulary-content.js');
  const kept = [{id:'old',question:PRESETS[0].question,answer:'saved answer',createdAt:1}];
  const fresh = PRESETS.map((p,i)=>({id:'new-'+i,question:p.question,answer:'generated '+i,createdAt:2}));
  const {service,setSnapshot} = fixture({summarizer:{summarize:async()=>({...entry('draft'),followups:fresh}),cancel(){},dispose(){}}});
  const original = {...entry('a'),favorite:true,status:'known',followups:kept};
  setSnapshot({revision:'r1',version:2,entries:[original]});
  const draft = await service.reanalyze('window','a','r1');
  assert.deepEqual(draft.followups.map(f=>f.answer),['saved answer','generated 1','generated 2']);
  assert.equal(draft.id,'a');assert.equal(draft.context,original.context);
  assert.equal(draft.favorite,true);assert.equal(draft.status,'known');
  service.reset();
  const full = Array.from({length:20},(_,i)=>({id:'kept-'+i,question:'question '+i,answer:'answer '+i,createdAt:1}));
  setSnapshot({revision:'r2',version:2,entries:[{...original,followups:full}]});
  const capped = await service.reanalyze('window','a','r2');
  assert.deepEqual(capped.followups,full);
});

test('concurrent rank requests share one call and callers cannot mutate the cached order', async()=>{
  const pending=deferred();let calls=0;
  const {service}=fixture({mica:{rankSenses(){calls++;return pending.promise;}}});
  const first=service.rank('cache','context'), second=service.rank('ＣＡＣＨＥ','context');
  await Promise.resolve();assert.equal(calls,1);
  pending.resolve({probabilities:{a:0.1,b:0.9}});
  const [a,b]=await Promise.all([first,second]);
  assert.deepEqual(a,['b','a']);a.reverse();
  assert.deepEqual(b,['b','a']);assert.deepEqual(await service.rank('Cache','context'),['b','a']);
  assert.equal(calls,1);
});

test('paragraph reanalysis works with full question history and changes only its target',async()=>{
  const {service,setSnapshot,saved}=fixture();
  const original={...entry('a'),partOfSpeech:'noun',followups:Array.from({length:20},(_,i)=>({id:'f'+i,question:'q'+i,answer:'answer '+i,createdAt:1}))};
  setSnapshot({revision:'r1',version:2,entries:[original]});
  const draft=await service.paragraph('window','a',{kind:'meaning',text:'a'},'r1');
  assert.equal(draft.meaning,'More detail.');assert.equal(draft.partOfSpeech,'noun');
  assert.deepEqual(draft.followups,original.followups);
  service.save('window','a','r1',{mode:'replace',targetId:'a'});
  assert.equal(saved[0].draft.meaning,'More detail.');
  assert.throws(()=>service.paragraph('window','a',{kind:'meaning',text:'wrong target'},'r1'),/문단/);
});

test('a changed vocabulary revision invalidates the index and in-flight rank cache', async()=>{
  const old=deferred();let calls=0;
  const {service,setSnapshot}=fixture({mica:{rankSenses(){return ++calls===1?old.promise:Promise.resolve({probabilities:{a:1,c:2}});}}});
  const first=service.rank('cache','context');await Promise.resolve();
  setSnapshot({version:2,revision:'r2',entries:[entry('a'),entry('c')]});
  assert.deepEqual(await service.rank('cache','context'),['c','a']);
  old.resolve({probabilities:{a:1,b:2}});await first;
  assert.deepEqual(await service.rank('cache','context'),['c','a']);assert.equal(calls,2);
});

test('failed rank requests can be retried', async()=>{
  let calls=0;
  const {service}=fixture({mica:{rankSenses(){if(++calls===1)throw Error('temporary');return {probabilities:{a:1,b:2}};}}});
  await assert.rejects(service.rank('cache','context'),/temporary/);
  assert.deepEqual(await service.rank('cache','context'),['b','a']);assert.equal(calls,2);
});
