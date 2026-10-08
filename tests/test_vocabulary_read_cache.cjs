'use strict';
// 단어장 읽기: 파일이 그대로면 읽고 검사한 결과를 다시 쓰고, 저장하거나 밖에서 바꾸면 새로 읽는다
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createVocabularyStore} = require('../labels/vendor/vocabulary.cjs');

test('같은 파일이면 결과를 다시 쓰고, 저장·외부 변경 후에는 새로 읽는다', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxm-vocab-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const store = createVocabularyStore(dir);
  const first = store.read();
  assert.equal(store.read(), first, '바뀌지 않았으면 같은 결과');
  const now = Date.now();
  const entry = {id: '00000000-0000-4000-8000-000000000001', term: 'ship', context: '', source: {}, meaning: '출시하다',
    model: 'm1', effort: 'low', savedAt: now};
  const saved = store.save(entry, first.revision, {mode: 'add'});
  const after = store.read();
  assert.notEqual(after, first);
  assert.equal(after.entries.length, 1);
  assert.equal(after.revision, saved.revision);
  // 다른 프로그램(예: 원래 Codex Labels)이 파일을 바꾼 경우
  const file = path.join(dir, 'vocabulary.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.entries[0].meaning = '배송하다';
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n\n');
  assert.equal(store.read().entries[0].meaning, '배송하다');
});
