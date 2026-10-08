'use strict';
// Compare frozen source trees using temporary data, never the installed app.
// node tests/benchmark_assignments.cjs <before-source-directory>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');

const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
function measure(root,count = 100,samples = 5) {
  const {createStore} = require(path.join(root,'labels/vendor/store.cjs'));
  const {assignManyWithAliases} = require(path.join(root,'labels/assignment-aliases.cjs'));
  const defaults = require(path.join(root,'labels/default-labels.json'));
  const times = [], writes = [];
  for (let sample = 0; sample < samples + 1; sample++) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'codex-assignment-benchmark-'));
    const keys = Array.from({length:count},(_,i) => `thread:local:thread:benchmark-${i}`);
    const assignments = Object.fromEntries(keys.flatMap((key,i) => [
      [key,'requested'],[`thread:remote:thread:benchmark-${i}`,'requested'],
    ]));
    const rename = fs.renameSync;
    let renames = 0;
    try {
      fs.writeFileSync(path.join(directory,'labels.json'),JSON.stringify(defaults));
      fs.writeFileSync(path.join(directory,'assignments.json'),JSON.stringify({schemaVersion:1,assignments}));
      const store = createStore(directory);
      store.snapshot();
      fs.renameSync = (...args) => { renames++; return rename(...args); };
      const start = performance.now();
      const result = assignManyWithAliases(store,keys,'completed','status');
      const elapsed = performance.now() - start;
      assert.equal(Object.keys(result.assignments).length,count * 2);
      assert.ok(Object.values(result.assignments).every(id => id === 'completed'));
      assert.deepEqual(createStore(directory).snapshot(),result);
      if (sample) { times.push(elapsed); writes.push(renames); }
    } finally {
      fs.renameSync = rename;
      fs.rmSync(directory,{recursive:true,force:true});
    }
  }
  return {threads:count,existing_aliases:count,samples,median_ms:Number(median(times).toFixed(3)),writes_per_batch:writes};
}
if (!process.argv[2]) throw Error('비교할 소스 폴더를 지정하세요.');
console.log(JSON.stringify({before:measure(path.resolve(process.argv[2])),after:measure(path.resolve(__dirname,'..'))},null,2));
