import {withServer} from './appserver.cjs';
import {isRecord} from './protocol.cjs';

/** A personal, time-proportional valuation of included quota, not a billing amount. */
export const DEFAULT_SUBSCRIPTION_FEE_KRW = 159000;
const PERIOD_MINUTES = 30 * 24 * 60;
export interface QuotaWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
  budgetKrw: number;
  usedKrw: number;
  remainingKrw: number;
  subscriptionPercent: number;
}
export interface SubscriptionUsage {
  feeKrw: number;
  periodDays: 30;
  dailyKrw: number;
  observedAt: number | null;
  status: 'ready' | 'stale' | 'unavailable' | 'resetting';
  window: QuotaWindow | null;
  message: string;
}
interface Options {
  exe: () => string | null;
  settings: () => Record<string, unknown>;
  saveSettings: (patch: Record<string, unknown>) => unknown;
  fetch?: () => Promise<unknown>;
  now?: () => number;
}
function validFee(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100000000;
}
export function quotaWindow(response: unknown, feeKrw: number): QuotaWindow {
  if (!validFee(feeKrw)) throw Error('30일 구독료를 올바른 원화 금액으로 입력해 주세요.');
  if (!isRecord(response)) throw Error('할당량 정보가 없습니다.');
  // Other named buckets can meter different products. Never add them together.
  const buckets = response.rateLimitsByLimitId;
  const bucket = isRecord(buckets) && isRecord(buckets.codex) ? buckets.codex : response.rateLimits;
  if (!isRecord(bucket) || (bucket.limitId != null && bucket.limitId !== 'codex')) throw Error('Codex 할당량이 없습니다.');
  const windows = [bucket.primary, bucket.secondary].filter(isRecord).filter(w =>
    typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100
    && typeof w.windowDurationMins === 'number' && Number.isFinite(w.windowDurationMins) && w.windowDurationMins > 0
    && typeof w.resetsAt === 'number' && Number.isSafeInteger(w.resetsAt) && w.resetsAt > 0);
  if (!windows.length) throw Error('기간과 초기화 시각이 있는 할당량을 확인하지 못했습니다.');
  // Short and long limits constrain the same usage. Value only the longest window.
  const selected = windows.sort((a, b) => Number(b.windowDurationMins) - Number(a.windowDurationMins))[0]!;
  const usedPercent = selected.usedPercent as number, windowDurationMins = selected.windowDurationMins as number;
  const budget = feeKrw * windowDurationMins / PERIOD_MINUTES;
  const used = budget * usedPercent / 100;
  return {usedPercent, windowDurationMins, resetsAt: selected.resetsAt as number,
    budgetKrw: Math.round(budget), usedKrw: Math.round(used), remainingKrw: Math.round(budget - used),
    subscriptionPercent: usedPercent * windowDurationMins / PERIOD_MINUTES};
}

export function createSubscriptionUsage(options: Options) {
  const now = options.now || Date.now;
  let last: {raw: unknown; at: number} | null = null;
  let failed = false;
  let flight: Promise<SubscriptionUsage> | null = null;
  const fee = () => {
    const value = options.settings().subscriptionFeeKrw;
    return validFee(value) ? value : DEFAULT_SUBSCRIPTION_FEE_KRW;
  };
  const snapshot = (error = false): SubscriptionUsage => {
    const feeKrw = fee();
    const window = last ? quotaWindow(last.raw, feeKrw) : null;
    const expired = window !== null && window.resetsAt * 1000 <= now();
    return {feeKrw, periodDays: 30, dailyKrw: feeKrw / 30, observedAt: last?.at ?? null, window,
      status: expired ? 'resetting' : error ? (window ? 'stale' : 'unavailable') : 'ready',
      message: expired ? '할당량 초기화 시각이 지났습니다. 새 사용량을 확인 중입니다.'
        : error ? '사용량을 갱신하지 못했습니다. Codex 로그인과 연결을 확인해 주세요.' : ''};
  };
  const fetch = options.fetch || (async () => {
    const exe = options.exe();
    if (!exe) throw Error('Codex 실행 파일이 없습니다.');
    // A fresh read-only connection picks up login changes; no thread or model turn is started.
    return withServer(exe, request => request('account/rateLimits/read'), 15000);
  });
  function read(force = false): Promise<SubscriptionUsage> {
    if (flight) return flight.then(value => structuredClone(value));
    if (!force && !failed && last && now() - last.at < 10000 && snapshot().status === 'ready') return Promise.resolve(snapshot());
    flight = (async () => {
      try {
        const raw = await fetch();
        quotaWindow(raw, fee()); // Do not replace a known value with malformed/absent data.
        last = {raw, at: now()};
        failed = false;
        return snapshot();
      } catch { failed = true; return snapshot(true); }
    })().finally(() => { flight = null; });
    return flight.then(value => structuredClone(value));
  }
  function setFee(value: number): number {
    if (!validFee(value)) throw Error('30일 구독료는 1원 이상 1억 원 이하의 정수로 입력해 주세요.');
    options.saveSettings({subscriptionFeeKrw: value});
    return fee();
  }
  return {read, setFee};
}
