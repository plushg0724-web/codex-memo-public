'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createVocabularyStore} = require('../labels/vendor/vocabulary.cjs');
const {paragraphs, selectedParagraphs} = require('../labels/vocabulary-content.js');
const {revisionDraft, generateFollowup} = require('../dist/node/vocabulary-analysis.cjs');
const {encode, decode} = require('../labels/backup-format.cjs');
const original = {id:'00000000-0000-4000-8000-000000000001',term:'cache',meaning:'First meaning.\n\nSecond paragraph.',
  explanation:'Keep this explanation.',context:'A cache stores previous results.',source:{title:'Example',path:'/'},
  model:'gpt-6-luna',effort:'low',savedAt:1000,favorite:true,status:'review',
  followups:[{id:'question-1',question:'When does it expire?',answer:'Answer one.\n\nAnswer two.',createdAt:2000,model:'gpt-6-luna',effort:'low'}],
  previewParagraphs:['First meaning.','Answer two.']};

test('paragraph selections preserve canonical order and followup paragraphs without duplicates', () => {
  const value = {...original, previewParagraphs:['Answer two.','First meaning.','Answer two.','removed']};
  assert.equal(paragraphs(value).filter(p=>p.kind==='followup').length,2);
  assert.deepEqual(selectedParagraphs(value).map(p=>p.text),['First meaning.','Answer two.']);
});

test('saved edits preserve question history, and changing a pinned paragraph clears only that pin', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cxm-vocab-revision-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const store=createVocabularyStore(directory);
  const saved=store.save(original,store.read().revision,{mode:'add'});
  const edited=store.edit(original.id,{meaning:'A changed meaning.'},saved.revision);
  assert.deepEqual(edited.entries[0].previewParagraphs,['Answer two.']);
  assert.deepEqual(edited.entries[0].followups,original.followups);
  assert.deepEqual(createVocabularyStore(directory).read().entries[0].previewParagraphs,['Answer two.']);
  assert.throws(()=>store.edit(original.id,{meaning:'A stale update.'},saved.revision),/다른 창/);
});

test('reanalyzing preserves identity, metadata, and saved questions while replacing the summary', () => {
  const value=revisionDraft(original,{...original,id:'new-draft-id',meaning:'Updated meaning.',savedAt:9999,followups:[]},'revision-before','reanalyze');
  assert.equal(value.id,original.id);assert.equal(value.savedAt,1000);assert.equal(value.favorite,true);
  assert.equal(value.baseRevision,'revision-before');assert.equal(value.targetId,original.id);
  assert.deepEqual(value.followups,original.followups);assert.deepEqual(value.previewParagraphs,['Answer two.']);
});

test('followup generation uses existing question history and returns an appendable answer', async () => {
  let received;
  const server={async run(request,options){received=request;options.onStop(()=>{});return JSON.stringify({answer:'New answer.\n\nMore detail.'});},close(){}};
  const value=await generateFollowup(server,original,'What changes?',{model:'gpt-6-luna',effort:'low',fast:false,guide:'Be concise.',known:[]},()=>{});
  assert.match(received.prompt,/When does it expire/);assert.match(received.prompt,/What changes/);
  assert.equal(value.question,'What changes?');assert.equal(value.answer,'New answer.\n\nMore detail.');
  assert.equal(original.followups.length,1);
});

test('account backup round trip includes question history and selected preview paragraphs', () => {
  const labels=JSON.parse(fs.readFileSync(path.join(__dirname,'../labels/default-labels.json'),'utf8'));
  const context={id:'00000000-0000-4000-8000-000000000088',context:'new sentence',analysis:'new analysis',source:{title:'test',path:'/thread'},createdAt:1,visible:false};
  const expanded={...original,showContextAnalysis:false,contextAnalyses:[context]};
  const data={labels,assignments:{schemaVersion:1,assignments:{}},vocabulary:{version:2,entries:[expanded]},memos:[]};
  const document=encode(data,{version:'1.11.0',deviceId:'fixture'});
  const restored=decode({content:{markdown:document.markdown}});
  assert.deepEqual(restored.data.vocabulary.entries[0].followups,original.followups);
  assert.deepEqual(restored.data.vocabulary.entries[0].previewParagraphs,original.previewParagraphs);
  assert.deepEqual(restored.data.vocabulary.entries[0].contextAnalyses,[context]);
  assert.equal(restored.data.vocabulary.entries[0].showContextAnalysis,false);
});

test('individual paragraph replacement changes only the chosen field or answer record', () => {
  const {replaceParagraph}=require('../labels/vocabulary-content.js');
  const entry={...original,definitions:['one','two'],definitionIndex:1,explanation:'first\n\nsecond',
    contextAnalyses:[{id:'ctx',context:'another sentence',analysis:'another analysis',visible:true}]};
  assert.deepEqual(replaceParagraph(entry,{kind:'meaning',text:'First meaning.'},''),{meaning:'Second paragraph.'});
  assert.deepEqual(replaceParagraph(entry,{kind:'explanation',text:'first'},'new'),{explanation:'new\n\nsecond'});
  assert.deepEqual(replaceParagraph(entry,{kind:'definition',text:'one'},''),{definitions:['two'],definitionIndex:0});
  const patch=replaceParagraph(entry,{kind:'followup',recordId:original.followups[0].id,text:'Answer one.'},'Updated answer.');
  assert.equal(patch.followups[0].answer,'Updated answer.\n\nAnswer two.');
  assert.equal(original.followups[0].answer,'Answer one.\n\nAnswer two.');
  assert.deepEqual(replaceParagraph(entry,{kind:'context',recordId:'ctx',text:'another analysis'},''),{contextAnalyses:[]});
});
