// @ts-check
'use strict';
// 단어장 요약을 Codex App Server 연결 하나로 처리한다. 요약마다 codex exec 를 띄우면 프로세스 시작·설정 읽기·
// MCP 서버 시작에 2초쯤 들어서, 연결을 잠시(기본 10분) 살려 두고 요약마다 새 임시(ephemeral) 대화를 연다.
// 대화에는 도구가 없다: MCP 서버는 모두 끄고, 셸·앱·플러그인·웹 검색도 끈 채 읽기 전용·승인 없음으로 연다.
const os = require('node:os');
const {openServer, createPool} = require('./appserver.cjs');

// codex exec 쪽(--ignore-user-config + 같은 -c 값)과 맞춘 설정. MCP 서버는 config/read 로 이름을 받아 대화마다 끈다.
const CONFIG = ['features.apps=false', 'features.plugins=false', 'features.memories=false', 'features.multi_agent=false',
  'features.shell_tool=false', 'features.unified_exec=false', 'project_doc_max_bytes=0', 'web_search="disabled"',
  'model_provider="openai"', 'forced_login_method="chatgpt"', 'cli_auth_credentials_store="file"',
  'approval_policy="never"', 'sandbox_mode="read-only"'];

/** 연결이 안 되거나 끊긴 경우(appserver.cjs 의 시작 실패·종료·응답 시간 초과, 실행 파일 없음) */
const TRANSPORT = /Codex 연결 도구|응답 시간이 초과됐습니다|Codex 실행 파일/;
/** 요약 쪽이 codex exec 로 다시 시도하도록 표시한다 */
const transport = (/** @type {unknown} */ error) => Object.assign(error instanceof Error ? error : Error(String(error)), {fallback: true});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {{exe: () => string | null, env?: NodeJS.ProcessEnv, home?: {prepare(): string, release(): void},
 *   idleMs?: number, requestMs?: number, open?: typeof openServer}} options
 *   home: 요약 전용 CODEX_HOME (labels/summary-home.cjs), open: 테스트에서 가짜 App Server 를 넣을 때
 */
function createSummaryServer({exe, env, home, idleMs = 10 * 60 * 1000, requestMs = 30000, open = openServer}) {
  const pool = createPool(exe, async (ex, signal) => {
    // 연결을 여는 동안 요약 전용 폴더를 쓰고, 연결을 닫으면 돌려준다
    const codexHome = home?.prepare();
    let server;
    try {
      server = await open(ex, requestMs, {config: CONFIG, env: codexHome ? {...env, CODEX_HOME: codexHome} : env, signal});
      const read = await server.request('config/read', {});
      const config = isRecord(read) && isRecord(read.config) ? read.config : {};
      const mcpServers = isRecord(config.mcp_servers) ? config.mcp_servers : {};
      // 요약 전용 폴더에는 MCP 서버가 없지만, 원래 폴더를 쓸 때를 위해 대화마다 끈다
      const off = Object.fromEntries(Object.keys(mcpServers).map(name => [`mcp_servers.${name}.enabled`, false]));
      const close = server.close;
      return {...server, off, close: () => { close(); home?.release(); }};
    } catch (error) { server?.close(); home?.release(); throw error; }
  }, idleMs);

  /**
   * 한 턴을 실행해 마지막 답 글을 돌려준다.
   * @param {{model: string, effort: string, fast: boolean, prompt: string, schema: object}} request
   * @param {{timeoutMs?: number, onStop?: (stop: () => void) => void}} [options] onStop: 취소 함수를 받는다
   * @returns {Promise<string>}
   */
  function run({model, effort, fast, prompt, schema}, {timeoutMs = 120000, onStop} = {}) {
    // 연결 시작·앞선 작업을 기다리는 동안의 취소도 기억해 모델 턴을 시작하지 않는다.
    let stopped = '', stopActive = () => {};
    onStop?.(() => { stopped = '요약을 취소했습니다.'; stopActive(); });
    return pool.run(async session => {
      if (stopped) return {error: Error(stopped)};
      let threadId = '', turnId = '', unlisten = () => {}, timer;
      const finished = new Promise((resolve, reject) => {
        let text = '';
        const stop = (/** @type {string} */ reason) => {
          stopped = reason;
          if (threadId && turnId) session.request('turn/interrupt', {threadId, turnId}).catch(() => {});
          reject(Error(reason));
        };
        stopActive = () => stop(stopped);
        timer = setTimeout(() => stop('요약 시간이 초과되었습니다. 다시 시도하세요.'), timeoutMs);
        unlisten = session.listen(m => {
          if (m.method === 'server/exited') return reject(Error('Codex 연결 도구가 종료됐습니다.'));
          const params = isRecord(m.params) ? m.params : {};
          if (!threadId || params.threadId !== threadId) return;
          const item = isRecord(params.item) ? params.item : {};
          if (m.method === 'item/completed' && item.type === 'agentMessage') text = String(item.text || '');
          else if (m.method === 'turn/completed') {
            const turn = isRecord(params.turn) ? params.turn : {};
            const error = isRecord(turn.error) ? turn.error : {};
            if (turn.status === 'completed' && text) resolve(text);
            else reject(Error([error.message, JSON.stringify(error.codexErrorInfo || '')].filter(Boolean).join(' ') || '뜻 요약에 실패했습니다.'));
          }
        });
      });
      finished.catch(() => {});
      try {
        const thread = await session.request('thread/start', {cwd: os.tmpdir(), ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', model, config: session.off});
        threadId = isRecord(thread) && isRecord(thread.thread) && typeof thread.thread.id === 'string' ? thread.thread.id : '';
        if (!threadId) throw Error('요약 대화를 열지 못했습니다.');
        if (stopped) throw Error(stopped);
        const started = await session.request('turn/start', {threadId, model, effort, summary: 'none', outputSchema: schema,
          serviceTierForTurn: fast ? 'priority' : 'default', input: [{type: 'text', text: prompt, text_elements: []}]});
        turnId = isRecord(started) && isRecord(started.turn) && typeof started.turn.id === 'string' ? started.turn.id : '';
        if (stopped && turnId) session.request('turn/interrupt', {threadId, turnId}).catch(() => {});
        return {text: await finished};
      } catch (error) {
        // 연결이 끊긴 경우만 던져서 연결을 버린다. 취소·시간 초과·모델 오류는 연결을 살려 둔 채 돌려준다.
        if (TRANSPORT.test(String(error?.message)) && !stopped) throw error;
        return {error: stopped ? Error(stopped) : error};
      } finally {
        clearTimeout(timer); unlisten(); stopActive = () => {};
        if (threadId) session.request('thread/unsubscribe', {threadId}).catch(() => {});
      }
    }).then(result => {
      if (result.error) throw result.error;
      return result.text;
    }, error => {
      if (stopped) throw Error(stopped);
      // 연결을 열거나 요청을 보내는 단계에서 연결이 안 되면 exec 로 넘긴다
      throw TRANSPORT.test(String(error?.message)) ? transport(error) : error;
    });
  }
  return {run, close: pool.close};
}

module.exports = {createSummaryServer, CONFIG};
