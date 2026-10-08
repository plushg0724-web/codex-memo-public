// @ts-check
'use strict';
// 단어장 요약 전용 CODEX_HOME. 원래 CODEX_HOME 의 AGENTS.md(사용자 작업 규칙)·config.toml(MCP 서버 등)이
// 요약 대화에 들어가지 않게, 빈 폴더에 같은 계정의 로그인 파일(auth.json)만 둔다.
//
// 로그인 토큰은 갱신될 때 바뀔 수 있어 복사본이 따로 갱신하면 원래 로그인이 끊길 수 있다. 그래서
// - 쓰기 전(prepare): 항상 원본 auth.json 을 새로 복사한다 (원본이 기준)
// - 다 쓴 뒤(release): 복사본이 갱신됐고 원본은 그사이 그대로면, 갱신된 내용을 원본에 되돌려 쓴다
const fs = require('node:fs');
const path = require('node:path');

const AUTH = 'auth.json';
// 요약에 필요한 설정은 실행할 때 -c 로 넘긴다. 이 파일은 비어 있다는 표시만 한다.
const CONFIG = '# Codex 메모 단어장 요약 전용 폴더입니다. 로그인 파일은 원래 CODEX_HOME 에서 자동으로 복사됩니다.\n';

const readOrNull = (/** @type {string} */ file) => { try { return fs.readFileSync(file); } catch { return null; } };
/** 같은 폴더에 임시 파일로 쓴 뒤 바꿔 넣는다 (중간에 끊겨도 반쯤 쓴 파일이 남지 않게) */
function writeAtomic(/** @type {string} */ file, /** @type {Buffer} */ data) {
  const temp = `${file}.cxm-${process.pid}.tmp`;
  fs.writeFileSync(temp, data, {mode: 0o600});
  fs.renameSync(temp, file);
}

/**
 * @param {{source: string, dir: string}} options source: 원래 CODEX_HOME, dir: 요약 전용 폴더
 */
function createSummaryHome({source, dir}) {
  /** @type {Buffer | null} 마지막으로 복사해 둔 auth.json */
  let placed = null;
  let users = 0;
  return {
    dir,
    /** 쓰기 전에 부른다. 요약 전용 CODEX_HOME 경로를 돌려준다 */
    prepare() {
      const auth = readOrNull(path.join(source, AUTH));
      if (!auth) throw Error('Codex 로그인 파일을 찾지 못했습니다. Codex 에 로그인했는지 확인하세요.');
      fs.mkdirSync(dir, {recursive: true});
      const config = path.join(dir, 'config.toml');
      if (readOrNull(config)?.toString() !== CONFIG) fs.writeFileSync(config, CONFIG);
      // 혹시 생긴 작업 규칙 파일은 지운다 (이 폴더는 요약 전용)
      fs.rmSync(path.join(dir, 'AGENTS.md'), {force: true});
      const target = path.join(dir, AUTH);
      // 쓰는 중인 다른 실행이 있으면 그쪽이 갱신했을 수 있으니, 원본이 바뀐 경우에만 덮는다
      if (!users || (placed && !auth.equals(placed))) {
        if (!readOrNull(target)?.equals(auth)) writeAtomic(target, auth);
        placed = auth;
      }
      users++;
      return dir;
    },
    /** 다 쓴 뒤에 부른다. 복사본에서 갱신된 로그인만 원본에 되돌린다 */
    release() {
      users = Math.max(0, users - 1);
      if (users || !placed) return;
      const current = readOrNull(path.join(dir, AUTH));
      const original = readOrNull(path.join(source, AUTH));
      if (current && original && !current.equals(placed) && original.equals(placed)) {
        try { JSON.parse(current.toString('utf8')); writeAtomic(path.join(source, AUTH), current); placed = current; }
        catch { /* 반쯤 쓴 파일이면 되돌리지 않는다 */ }
      }
    },
  };
}

module.exports = {createSummaryHome};
