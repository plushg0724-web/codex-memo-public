'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {createSummarizer} = require('../labels/vendor/vocabulary.cjs');

const answer = JSON.stringify({meaning: '캐시', usage: '', example: '', partOfSpeech: '', explanation: '', tags: [], matchedId: ''});
const input = {term: 'cache', context: 'Read from the cache.'};
const options = {model: 'gpt-6-luna', effort: 'high'};

test('server summary succeeds when the helper startup executable no longer exists', async () => {
  const summarizer = createSummarizer({executable: 'removed-old-package/codex.exe', server: {run: async () => answer}});
  assert.equal((await summarizer.summarize('window', input, options)).meaning, '캐시');
});

test('exec fallback discovers a replacement at call time after server failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vocabulary-executable-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const old = path.join(root, 'old.exe'), next = path.join(root, 'next.exe');
  fs.writeFileSync(old, 'fixture'); fs.writeFileSync(next, 'fixture');
  let selected = old;
  const spawned = [];
  const summarizer = createSummarizer({executable: () => selected,
    server: {run: async () => {selected = next; throw Object.assign(Error('transport'), {fallback: true});}},
    spawnProcess(exe, args) {
      spawned.push(exe);
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], answer);
      const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin.end = () => setImmediate(() => child.emit('close', 0)); child.kill = () => {};
      return child;
    }});
  fs.unlinkSync(old);
  assert.equal((await summarizer.summarize('window', input, options)).meaning, '캐시');
  assert.deepEqual(spawned, [next]);
});

test('missing executable still reports the installation error for local exec', async () => {
  const summarizer = createSummarizer({executable: () => null});
  await assert.rejects(summarizer.summarize('window', input, options), /Codex 실행 파일을 찾지 못했습니다/);
});
