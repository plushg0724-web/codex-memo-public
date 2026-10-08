export interface ServerOptions {
  config?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
}

export interface PoolOptions {
  idleMs?: number;
  timeoutMs?: number;
}

export interface ToolPoolOptions extends PoolOptions {
  cwd?: string;
}

/** App Server notifications have method-specific, externally supplied parameters. */
export interface ServerNotification {
  method: string;
  params?: unknown;
}

export type NotificationListener = (message: ServerNotification) => void;

/**
 * T describes the caller's expected wire result; callers must narrow unknown
 * responses when they do not already have a method-specific response contract.
 */
export type Request = <T = unknown>(method: string, params?: object) => Promise<T>;
export type ToolCall = <T = unknown>(tool: string, args: object) => Promise<T>;
export type ExecutableResolver = () => string | null;

export interface Closable {
  close(): void;
}

export interface ServerConnection extends Closable {
  request: Request;
  listen(listener: NotificationListener): () => void;
}

export interface ToolConnection extends Closable {
  call: ToolCall;
}

export interface ConnectionPool<C> extends Closable {
  run<T>(work: (connection: C) => Promise<T>): Promise<T>;
}

export interface AccountReadResult {
  account: ({type: string} & Record<string, unknown>) | null;
}

export interface ThreadStartResult {
  thread: {id: string} & Record<string, unknown>;
}
