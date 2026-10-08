import {spawn} from 'node:child_process';
import type {SummaryServer} from './backend-types.cjs';

export const WEBCHAT_MODEL = {id: 'chatgpt-web', name: 'ChatGPT 웹챗', efforts: ['none', 'medium', 'high', 'xhigh'] as const, defaultEffort: 'medium' as const, fast: false};
export interface WebchatConfig {endpoint: string; playwrightModule: string}

/** The vocabulary app is the MCP client; ChatGPT Web supplies the answer. No API/Codex fallback. */
export function createWebchatSummaryServer({worker, config}: {worker: string; config(): WebchatConfig}): SummaryServer {
  let active: (() => void) | null = null;

  function run(request: Parameters<SummaryServer['run']>[0], {timeoutMs = 120000, onStop}: Parameters<SummaryServer['run']>[1] = {}): Promise<string> {
    if (active) return Promise.reject(Error('웹챗에서 다른 단어를 분석하고 있습니다. 잠시 기다려 주세요.'));
    if (!WEBCHAT_MODEL.efforts.some(effort => effort === request.effort)) return Promise.reject(Error('웹챗 추론 강도를 확인하세요.'));
    let settings: WebchatConfig;
    try { settings = config(); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker], {windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: {...process.env, CODEX_MEMO_WEBCHAT_CONFIG: JSON.stringify(settings)}});
      let done = false, buffer = '', phase = 1, killTimer: NodeJS.Timeout | undefined;
      const send = (value: object) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n'); };
      const finish = (error?: Error, answer?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        active = null;
        child.stdin.end();
        killTimer = setTimeout(() => child.kill(), 1500);
        killTimer.unref();
        if (error) reject(error); else resolve(answer!);
      };
      const stop = () => {
        send({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 2, reason: 'User cancelled vocabulary analysis'}});
        finish(Error('웹챗 요약을 취소했습니다.'));
      };
      active = stop;
      const timer = setTimeout(() => {
        send({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 2, reason: 'Request timed out'}});
        finish(Error('웹챗 요약 시간이 초과되었습니다. 다시 시도하세요.'));
      }, timeoutMs);
      onStop?.(stop);
      child.stdin.on('error', () => finish(Error('웹챗 MCP 연결이 끊어졌습니다.')));
      child.on('error', () => finish(Error('웹챗 MCP 연결을 시작하지 못했습니다.')));
      child.on('close', () => { clearTimeout(killTimer); finish(Error('웹챗 MCP 연결이 종료되었습니다.')); });
      // stderr is deliberately drained without retaining prompts, cookies or browser diagnostics.
      child.stderr.resume();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (done) return;
        buffer += chunk;
        if (buffer.length > 128000) return finish(Error('웹챗 MCP 응답이 너무 큽니다.'));
        let newline: number;
        while (!done && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let reply: {id?: number; error?: {message?: string}; result?: {isError?: boolean; content?: Array<{type?: string; text?: string}>}};
          try { reply = JSON.parse(line); } catch { return finish(Error('웹챗 MCP 응답 형식을 확인하지 못했습니다.')); }
          if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return finish(Error('웹챗 MCP 응답 형식을 확인하지 못했습니다.'));
          if (reply.id !== phase) continue;
          if (reply.error) return finish(Error('웹챗 MCP 요청이 거절되었습니다.'));
          if (phase === 1) {
            phase = 2;
            send({jsonrpc: '2.0', method: 'notifications/initialized'});
            send({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'webchat_summarize', arguments: {prompt: request.prompt, schema: request.schema, effort: request.effort}}});
          } else {
            const text = reply.result?.content?.find(item => item.type === 'text')?.text;
            if (reply.result?.isError) return finish(Error(text?.startsWith('웹챗') ? text : '웹챗 요약에 실패했습니다.'));
            if (!text || text.length > 24000) return finish(Error('웹챗 요약 결과의 길이를 확인하지 못했습니다.'));
            try { const value: unknown = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); }
            catch { return finish(Error('웹챗 요약 결과가 JSON 객체 형식이 아닙니다. 다시 시도하세요.')); }
            finish(undefined, text);
          }
        }
      });
      if (!done) send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'codex-memo-vocabulary', version: '1'}}});
    });
  }
  return {run, close() { active?.(); }};
}

/** Only vocabulary requests selected as chatgpt-web are sent to this MCP. */
export function vocabularySummaryServer(codex: SummaryServer, webchat: SummaryServer): SummaryServer {
  return {run: (request, options) => (request.model === WEBCHAT_MODEL.id ? webchat : codex).run(request, options),
    close() { webchat.close(); codex.close(); }};
}
