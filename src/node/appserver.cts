// Codex 앱에 포함된 codex.exe 의 App Server 로 연결 도구를 부른다.
import {spawn} from 'node:child_process';
import * as readline from 'node:readline';
import * as os from 'node:os';
import type {
  AccountReadResult, Closable, ConnectionPool, ExecutableResolver,
  NotificationListener, PoolOptions, Request, ServerConnection,
  ServerNotification, ServerOptions, ThreadStartResult, ToolCall,
  ToolConnection, ToolPoolOptions,
} from './transport-types.cjs';

export type {
  AccountReadResult, Closable, ConnectionPool, ExecutableResolver,
  NotificationListener, PoolOptions, Request, ServerConnection,
  ServerNotification, ServerOptions, ThreadStartResult, ToolCall,
  ToolConnection, ToolPoolOptions,
} from './transport-types.cjs';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAccountReadResult(value: unknown): value is AccountReadResult {
  return isRecord(value) && (value.account === null ||
    (isRecord(value.account) && typeof value.account.type === 'string'));
}

function isThreadStartResult(value: unknown): value is ThreadStartResult {
  return isRecord(value) && isRecord(value.thread) &&
    typeof value.thread.id === 'string' && value.thread.id.length > 0;
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value) return value;
  if (isRecord(value) && typeof value.message === 'string' && value.message) return value.message;
  return fallback;
}

/** App Server 를 띄워 초기화한다. 다 쓰면 close() 로 끝낸다. */
export async function openServer(
  exe: string,
  timeoutMs = 60000,
  {config = [], env, cwd = os.tmpdir(), signal}: ServerOptions = {},
): Promise<ServerConnection> {
  if (signal?.aborted) throw Error('Codex 연결 도구가 종료됐습니다.');
  const args = ['app-server', ...config.flatMap(c => ['-c', c]), '--listen', 'stdio://'];
  const child = spawn(exe, args, {cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
  const listeners = new Set<NotificationListener>();
  const pending = new Map<number, PendingRequest>();
  let seq = 0, closed = false;
  const fail = (error: Error): void => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  // 알림 하나의 실패가 다른 구독자·응답 수신·프로세스 정리를 막지 않게 한다.
  const notify = (listener: NotificationListener, message: ServerNotification): void => {
    try { listener(message); } catch { /* 구독자별로 격리 */ }
  };
  const lines = readline.createInterface({input: child.stdout});
  const finish = (error: Error): void => {
    if (closed) return;
    closed = true;
    fail(error);
    signal?.removeEventListener('abort', close);
    lines.close();
    const exiting = [...listeners];
    listeners.clear();
    for (const listener of exiting) notify(listener, {method: 'server/exited'});
  };
  const close = (): void => {
    if (closed) return;
    try { finish(Error('Codex 연결 도구가 종료됐습니다.')); }
    finally { child.kill(); }
  };
  child.stdin.on('error', () => {
    try { finish(Error('Codex 연결 도구에 요청을 보내지 못했습니다.')); }
    finally { child.kill(); }
  });
  signal?.addEventListener('abort', close, {once: true});
  child.on('error', () => finish(Error('Codex 연결 도구를 시작하지 못했습니다.')));
  child.on('exit', () => finish(Error('Codex 연결 도구가 종료됐습니다.')));
  lines.on('line', (line: string) => {
    if (closed) return;
    let message: unknown;
    try { message = JSON.parse(line); } catch { return; }
    if (!isRecord(message)) return;
    const waiting = typeof message.id === 'number' ? pending.get(message.id) : undefined;
    if (waiting && typeof message.id === 'number') {
      pending.delete(message.id);
      if (message.error) waiting.reject(Error(errorMessage(message.error, '요청 실패')));
      else waiting.resolve(message.result);
    } else if (message.id != null && typeof message.method === 'string') {
      // 로그인·권한 승인 같은 서버 요청은 하지 않는다.
      child.stdin.write(JSON.stringify({id: message.id, error: {code: -32601, message: 'not supported'}}) + '\n');
    } else if (typeof message.method === 'string') {
      const notification: ServerNotification = {...message, method: message.method};
      for (const listener of [...listeners]) notify(listener, notification);
    }
  });
  const listen = (listener: NotificationListener): (() => void) => {
    if (closed) notify(listener, {method: 'server/exited'});
    else listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const request: Request = <T = unknown,>(method: string, params: object = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (closed) return reject(Error('Codex 연결 도구가 종료됐습니다.'));
      const id = ++seq;
      const message = JSON.stringify({id, method, params}) + '\n';
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('응답 시간이 초과됐습니다.'));
      }, timeoutMs);
      pending.set(id, {
        // A generic transport cannot validate method-specific result schemas.
        // Unknown is retained unless the caller explicitly supplies its contract.
        resolve: value => { clearTimeout(timer); resolve(value as T); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(message);
    });
  try {
    await request('initialize', {clientInfo: {name: 'codex_memo', title: 'Codex 메모', version: '1.0.0'}});
    child.stdin.write(JSON.stringify({method: 'initialized', params: {}}) + '\n');
  } catch (error) {
    close();
    throw error;
  }
  return {request, listen, close};
}

/** ChatGPT 연결 도구를 부를 수 있는 연결을 연다. 다 쓰면 close(). */
async function openTools(exe: string, timeoutMs = 60000, options: ServerOptions = {}): Promise<ToolConnection> {
  const server = await openServer(exe, timeoutMs, options);
  try {
    const account = await server.request('account/read', {refreshToken: false});
    if (!isAccountReadResult(account) || account.account?.type !== 'chatgpt') {
      throw Error('Codex 의 ChatGPT 로그인을 확인하지 못했습니다.');
    }
    const thread = await server.request('thread/start', {
      cwd: os.tmpdir(), ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
    });
    if (!isThreadStartResult(thread)) throw Error('Codex 연결 도구의 대화를 시작하지 못했습니다.');
    const call: ToolCall = async <T = unknown,>(tool: string, args: object): Promise<T> => {
      const response = await server.request('mcpServer/tool/call', {
        threadId: thread.thread.id, server: 'codex_apps', tool, arguments: args,
      });
      if (!isRecord(response)) throw Error(`${tool} 응답을 읽지 못했습니다.`);
      let data: unknown = response.structuredContent;
      if (!data && Array.isArray(response.content)) {
        for (const content of response.content as unknown[]) {
          if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') continue;
          try { data = JSON.parse(content.text); break; } catch { /* 글 응답 */ }
        }
      }
      const responseError = isRecord(data) ? data.error : undefined;
      if (response.isError || responseError) throw Error(errorMessage(responseError, `${tool} 실패`));
      // Tool results have tool-specific schemas, supplied by the caller as T.
      return data as T;
    };
    return {call, close: server.close};
  } catch (error) {
    server.close();
    throw error;
  }
}

/** 한 번 쓰고 닫는 연결. */
export async function withServer<T>(
  exe: string,
  work: (request: Request) => Promise<T>,
  timeoutMs = 60000,
): Promise<T> {
  const server = await openServer(exe, timeoutMs);
  try { return await work(server.request); } finally { server.close(); }
}

/**
 * 연결을 잠시 살려 두고 재사용한다. 작업은 차례로 실행하며 오류·휴식 뒤에는
 * 다시 연다. 연결을 여는 동안 종료되면 늦게 열린 연결도 바로 닫는다.
 */
export function createPool<C extends Closable>(
  exe: ExecutableResolver,
  open: (exe: string, signal: AbortSignal) => Promise<C>,
  idleMs: number,
): ConnectionPool<C> {
  let session: (C & {exe: string}) | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const lifetime = new AbortController();
  const closedError = (): Error => Error('연결 풀이 종료되었습니다.');
  let queue: Promise<unknown> = Promise.resolve();
  const reset = (): void => {
    if (idle !== null) clearTimeout(idle);
    idle = null;
    const previous = session;
    session = null;
    previous?.close();
  };
  const close = (): void => { lifetime.abort(); reset(); };
  return {
    run<T>(work: (connection: C) => Promise<T>): Promise<T> {
      if (lifetime.signal.aborted) return Promise.reject(closedError());
      const job = queue.then(async () => {
        if (lifetime.signal.aborted) throw closedError();
        if (idle !== null) clearTimeout(idle);
        try {
          const executable = exe();
          if (!executable) throw Error('Codex 실행 파일을 찾지 못했습니다.');
          if (session && session.exe !== executable) reset();
          if (!session) {
            const opened = await open(executable, lifetime.signal);
            if (lifetime.signal.aborted) { opened.close(); throw closedError(); }
            session = {...opened, exe: executable};
          }
          const result = await work(session);
          if (lifetime.signal.aborted) throw closedError();
          return result;
        } catch (error) {
          reset();
          throw lifetime.signal.aborted ? closedError() : error;
        } finally {
          if (session) {
            idle = setTimeout(reset, idleMs);
            idle.unref();
          }
        }
      });
      queue = job.catch(() => {});
      return job;
    },
    close,
  };
}

/** ChatGPT 연결 도구 연결을 재사용한다. run(call => ...). */
export function createToolPool(
  exe: ExecutableResolver,
  {idleMs = 120000, timeoutMs = 60000, cwd}: ToolPoolOptions = {},
): ConnectionPool<ToolCall> {
  const pool = createPool(exe, (executable, signal) => openTools(executable, timeoutMs, {cwd, signal}), idleMs);
  return {run: work => pool.run(session => work(session.call)), close: pool.close};
}

/** App Server 요청 연결을 재사용한다. run(request => ...). */
export function createServerPool(
  exe: ExecutableResolver,
  {idleMs = 120000, timeoutMs = 60000}: PoolOptions = {},
): ConnectionPool<Request> {
  const pool = createPool(exe, (executable, signal) => openServer(executable, timeoutMs, {signal}), idleMs);
  return {run: work => pool.run(session => work(session.request)), close: pool.close};
}
