'use strict';
// Exercise the real JSON-line backend with isolated files and no Codex/model access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const {spawn} = require('node:child_process');

test('failed settings writes preserve active model and thresholds; success preserves unrelated settings', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-memo-settings-'));
  fs.copyFileSync(path.join(__dirname, '../labels/default-labels.json'), path.join(dir, 'labels.json'));
  const original = {vocabularyModel:{model:'gpt-6-luna',effort:'high'},
    thresholds:{label:0.4,status:0.8,memo:0.4,sense:0.7}, unrelated:{keep:'value'}};
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(original));
  // Inject the filesystem failure at commit time, independent of temporary filenames.
  const hook = path.join(dir, 'fail-writes.cjs');
  fs.writeFileSync(hook, `const fs = require('node:fs'); const rename = fs.renameSync;
fs.renameSync = function(source, target) {
  if (String(target) === ${JSON.stringify(file)} && fs.existsSync(${JSON.stringify(file + '.tmp')})) throw Object.assign(Error('simulated write failure'), {code:'EACCES'});
  return rename.apply(this, arguments);
};`);
  const child = spawn(process.execPath, ['--require', hook, path.join(__dirname, '../labels/backend.cjs')], {
    env:{...process.env, CODEX_LABELS_DIR:dir, CODEX_MEMO_DATA:dir, CODEX_EXE:'', CODEX_MEMO_NO_STORE_CODEX:'1', LOCALAPPDATA:dir,
      CODEX_MEMO_MICA_URL:'http://127.0.0.1:1', CODEX_MEMO_JEV_URL:'http://127.0.0.1:1', JEV_API_KEY:''},
    stdio:['pipe','pipe','pipe'], windowsHide:true,
  });
  let seq=0; const pending=new Map();
  const lines=readline.createInterface({input:child.stdout});
  lines.on('line',line=>{const r=JSON.parse(line); const p=pending.get(r.id); if(p){pending.delete(r.id);p(r);}});
  const call = (method,...args) => new Promise((resolve,reject)=>{
    const id=++seq; const timer=setTimeout(()=>{pending.delete(id);reject(Error('backend response timeout'));},5000);
    pending.set(id,r=>{clearTimeout(timer);resolve(r);});
    child.stdin.write(JSON.stringify({id,sender:'test',method,args})+'\n');
  });
  t.after(async()=>{lines.close(); child.stdin.end(); if(child.exitCode===null) await new Promise(resolve=>child.once('exit',resolve)); fs.rmSync(dir,{recursive:true,force:true});});
  // FAST is on by default for older settings that never stored it.
  assert.deepEqual((await call('vocabularyModel')).value, {...original.vocabularyModel, fast:true});
  // The sentinel makes the injected commit failure active.
  fs.mkdirSync(file+'.tmp');
  assert.equal((await call('vocabularySetModel','test-model','low')).ok, false);
  assert.equal((await call('vocabularySetFast',false)).ok, false);
  assert.equal((await call('vocabularySetGuide','바꾼 지침')).ok, false);
  assert.deepEqual((await call('vocabularyModel')).value, {...original.vocabularyModel, fast:true});
  assert.equal((await call('vocabularyGuide')).value.custom, false);
  assert.equal((await call('thresholdsSet',{label:0.91})).ok, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')), original);
  fs.rmdirSync(file+'.tmp');
  assert.deepEqual((await call('thresholdsSet',{})).value, original.thresholds);
  assert.equal((await call('vocabularySetModel','test-model','low')).ok, true);
  assert.deepEqual((await call('vocabularyModel')).value,{model:'test-model',effort:'low',fast:true});
  assert.deepEqual((await call('vocabularySetFast',false)).value,{model:'test-model',effort:'low',fast:false});
  assert.equal((await call('vocabularySetFast','yes')).ok, false);
  const guide = (await call('vocabularySetGuide','  예문은 영어로\r\n쓰세요.  ')).value;
  assert.equal(guide.guide, '예문은 영어로\n쓰세요.'); assert.equal(guide.custom, true);
  assert.equal((await call('vocabularySetGuide','x'.repeat(guide.limit+1))).ok, false);
  const reset = (await call('vocabularySetGuide',null)).value;
  assert.equal(reset.custom, false); assert.equal(reset.guide, reset.defaultGuide);
  assert.equal('vocabularyGuide' in JSON.parse(fs.readFileSync(file,'utf8')), false);
  assert.equal((await call('thresholdsSet',{memo:0.65})).ok, true);
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.deepEqual(saved.unrelated, original.unrelated);
  assert.deepEqual(saved.thresholds, {...original.thresholds,memo:0.65});
});
