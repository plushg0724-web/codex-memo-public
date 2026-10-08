'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createCodexFinder} = require('../dist/node/codex-executable.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-executable-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = (name, modified = 100) => {
    const exe = path.join(root, name);
    fs.mkdirSync(path.dirname(exe), {recursive: true});
    fs.writeFileSync(exe, 'fixture');
    fs.utimesSync(exe, modified, modified);
    return exe;
  };
  return {root, file, env: {LOCALAPPDATA: root}};
}

test('valid caller-selected executable keeps priority without package lookup', t => {
  const f = fixture(t), exe = f.file('selected/codex.exe');
  const find = createCodexFinder({env: {...f.env, CODEX_EXE: exe}, packageRoots: () => {throw Error('unexpected lookup');}});
  assert.equal(find(), exe);
});

test('a live helper recovers after its Store package executable is removed', t => {
  const f = fixture(t), old = f.file('old/app/resources/codex.exe');
  const current = f.file('current/app/resources/codex.exe');
  let roots = [path.join(f.root, 'old')], lookups = 0;
  const find = createCodexFinder({env: {...f.env, CODEX_EXE: old}, packageRoots: () => {lookups++; return roots;}});
  assert.equal(find(), old);
  fs.unlinkSync(old); roots = [path.join(f.root, 'current')];
  assert.equal(find(), current);
  assert.equal(find(), current);
  assert.equal(lookups, 1, 'the valid replacement is cached');
});

test('hash releases use the newest executable and ignore backups and partial releases', t => {
  const f = fixture(t), bin = 'OpenAI/Codex/bin/';
  f.file(bin + 'codex.exe', 500);
  f.file(bin + '1111111111111111/codex.exe', 100);
  const newest = f.file(bin + '2222222222222222/codex.exe', 200);
  f.file(bin + '.backup-before-update/codex.exe', 900);
  fs.mkdirSync(path.join(f.root, bin, '3333333333333333'), {recursive: true});
  const find = createCodexFinder({env: f.env, packageRoots: () => []});
  assert.equal(find(), newest);
  fs.unlinkSync(newest);
  assert.equal(find(), path.join(f.root, bin, '1111111111111111/codex.exe'));
});

test('installed package CLI wins over stale local releases', t => {
  const f = fixture(t), exe = f.file('package/app/resources/codex.exe');
  f.file('OpenAI/Codex/bin/1111111111111111/codex.exe');
  const find = createCodexFinder({env: f.env, packageRoots: () => [path.join(f.root, 'package')]});
  assert.equal(find(), exe);
});

test('legacy flat layout remains supported and directories are rejected', t => {
  const f = fixture(t), legacy = f.file('OpenAI/Codex/bin/codex.exe');
  assert.equal(createCodexFinder({env: {...f.env, CODEX_EXE: f.root}, packageRoots: () => []})(), legacy);
});

test('missing installation and missing LOCALAPPDATA return null without a relative lookup', () => {
  assert.equal(createCodexFinder({env: {}, packageRoots: () => []})(), null);
  assert.equal(createCodexFinder({env: {LOCALAPPDATA: 'relative'}, packageRoots: () => []})(), null);
});

test('a package lookup that found nothing is not repeated on every call', () => {
  let lookups = 0, clock = 0;
  const find = createCodexFinder({env: {}, packageRoots: () => {lookups++; return [];}, now: () => clock});
  assert.equal(find(), null); assert.equal(find(), null);
  assert.equal(lookups, 1);
  clock += 30_000;
  assert.equal(find(), null);
  assert.equal(lookups, 2);
});

test('macOS unified app CLI is rediscovered after an app update', t => {
  const f = fixture(t);
  const old = f.file('Old ChatGPT.app/Contents/Resources/codex-cli/bin/codex');
  const next = f.file('New ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  let roots = [path.join(f.root, 'Old ChatGPT.app')];
  const find = createCodexFinder({env: {}, packageRoots: () => roots});
  assert.equal(find(), old);
  fs.unlinkSync(old); roots = [path.join(f.root, 'New ChatGPT.app')];
  assert.equal(find(), next);
});
