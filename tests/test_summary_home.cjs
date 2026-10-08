'use strict';
// 요약 전용 CODEX_HOME: 로그인 파일만 복사, 작업 규칙 없음, 갱신된 로그인만 원본에 되돌림
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createSummaryHome} = require('../labels/summary-home.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cxm-home-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, 'main'), dir = path.join(root, 'summary');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'auth.json'), JSON.stringify({tokens: {refresh_token: 'r1'}}));
  fs.writeFileSync(path.join(source, 'AGENTS.md'), '작업 규칙');
  fs.writeFileSync(path.join(source, 'config.toml'), '[mcp_servers.x]\ncommand = "x"\n');
  const read = (base, name) => fs.readFileSync(path.join(base, name), 'utf8');
  return {source, dir, read, home: createSummaryHome({source, dir})};
}

test('로그인 파일만 복사하고 작업 규칙·MCP 설정은 없다', t => {
  const {source, dir, read, home} = setup(t);
  assert.equal(home.prepare(), dir);
  assert.equal(read(dir, 'auth.json'), read(source, 'auth.json'));
  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
  assert.doesNotMatch(read(dir, 'config.toml'), /mcp_servers/);
  home.release();
  assert.equal(read(source, 'auth.json'), JSON.stringify({tokens: {refresh_token: 'r1'}}));
});

test('복사본에서 갱신된 로그인은 원본에 되돌린다', t => {
  const {source, dir, read, home} = setup(t);
  home.prepare();
  const refreshed = JSON.stringify({tokens: {refresh_token: 'r2'}});
  fs.writeFileSync(path.join(dir, 'auth.json'), refreshed);
  home.release();
  assert.equal(read(source, 'auth.json'), refreshed);
  // 다음에 쓸 때도 그대로
  home.prepare(); assert.equal(read(dir, 'auth.json'), refreshed); home.release();
});

test('원본이 그사이 갱신됐으면 원본을 덮지 않고, 다음에 원본을 다시 복사한다', t => {
  const {source, dir, read, home} = setup(t);
  home.prepare();
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({tokens: {refresh_token: 'copy'}}));
  const mainNew = JSON.stringify({tokens: {refresh_token: 'main'}});
  fs.writeFileSync(path.join(source, 'auth.json'), mainNew);
  home.release();
  assert.equal(read(source, 'auth.json'), mainNew);
  home.prepare();
  assert.equal(read(dir, 'auth.json'), mainNew);
  home.release();
});

test('여럿이 쓰는 중에는 마지막이 끝날 때만 되돌리고, 깨진 파일은 되돌리지 않는다', t => {
  const {source, dir, read, home} = setup(t);
  const original = read(source, 'auth.json');
  home.prepare(); home.prepare();
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"tokens": ');
  home.release();
  assert.equal(read(source, 'auth.json'), original);
  home.release();
  assert.equal(read(source, 'auth.json'), original, '깨진 JSON 은 원본에 쓰지 않음');
});

test('로그인 파일이 없으면 알기 쉬운 오류', t => {
  const {source, home} = setup(t);
  fs.rmSync(path.join(source, 'auth.json'));
  assert.throws(() => home.prepare(), /로그인 파일/);
});
