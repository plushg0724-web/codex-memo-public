const {test} = require('node:test');
const assert = require('node:assert/strict');
const {quotaWindow, createSubscriptionUsage} = require('../dist/node/subscription-usage.cjs');
const fixture = (usedPercent = 32, minutes = 10080, resetsAt = 2000000000) => ({rateLimits: {
  limitId: 'codex', primary: {usedPercent, windowDurationMins: minutes, resetsAt}, secondary: null,
}});
function service(fetch, overrides = {}) {
  let saved = {unrelated: 'preserved'};
  return createSubscriptionUsage({exe: () => null, settings: () => saved,
    saveSettings: patch => { saved = {...saved, ...patch}; }, fetch, ...overrides});
}
test('159000원/30일: 주간 32%를 11872원, 구독료 7.4667%로 환산', () => {
  const q = quotaWindow(fixture(), 159000);
  assert.equal(q.budgetKrw, 37100); assert.equal(q.usedKrw, 11872);
  assert.equal(q.remainingKrw, 25228); assert.ok(Math.abs(q.subscriptionPercent - 7.4666666667) < 1e-8);
  assert.equal(quotaWindow(fixture(100), 159000).usedKrw, 37100);
  assert.equal(quotaWindow(fixture(0), 159000).usedKrw, 0);
});
test('단기와 주간은 합산하지 않고 긴 주기를 사용, 별도 상품 버킷 제외', () => {
  const raw = fixture(90, 300);
  raw.rateLimits.secondary = fixture(50).rateLimits.primary;
  raw.rateLimitsByLimitId = {other: fixture(100).rateLimits, codex: raw.rateLimits};
  const q = quotaWindow(raw, 159000);
  assert.equal(q.usedKrw, 18550); assert.equal(q.windowDurationMins, 10080);
  assert.throws(() => quotaWindow({rateLimits: {...raw.rateLimits, limitId: 'other'}}, 159000));
});
test('알 수 없는 기간이나 누락/잘못된 사용률을 0으로 표시하지 않는다', () => {
  for (const raw of [null, {}, fixture(null), fixture(NaN), fixture(-1), fixture(101), fixture(30, 0), fixture(30, 300, null)]) {
    assert.throws(() => quotaWindow(raw, 159000));
  }
  assert.throws(() => quotaWindow(fixture(), -1));
});
test('동시 요청은 하나로 읽고, 받은 객체는 격리하며 캐시는 10초까지만 사용', async () => {
  let calls = 0, time = 1000000, resolve;
  const meter = service(() => { calls++; return new Promise(r => { resolve = r; }); }, {now: () => time});
  const a = meter.read(), b = meter.read(true); resolve(fixture());
  const [first, second] = await Promise.all([a, b]);
  first.window.usedKrw = 0;
  assert.equal(second.window.usedKrw, 11872); assert.equal(calls, 1);
  assert.equal((await meter.read()).window.usedKrw, 11872); assert.equal(calls, 1);
  time += 15000; const next = meter.read(); resolve(fixture(33));
  assert.equal((await next).window.usedPercent, 33); assert.equal(calls, 2);
});
test('연결 실패는 이전 값을 stale로 보존, 복구 시 새 값, 초기 실패도 재시도', async () => {
  let fail = true, time = 1000000;
  const meter = service(() => { if (fail) throw Error('offline'); return Promise.resolve(fixture()); }, {now: () => time});
  assert.equal((await meter.read()).status, 'unavailable');
  fail = false; assert.equal((await meter.read(true)).status, 'ready');
  fail = true; time += 15000;
  const old = await meter.read(); assert.equal(old.status, 'stale'); assert.equal(old.window.usedKrw, 11872);
  assert.equal(old.observedAt, 1000000);
  fail = false; assert.equal((await meter.read(true)).status, 'ready');
});
test('초기화 시각을 지나면 남은 양을 새 할당량처럼 표시하지 않는다', async () => {
  const meter = service(async () => fixture(32, 10080, 1000), {now: () => 1000001});
  assert.equal((await meter.read()).status, 'resetting');
});
test('최근 캐시가 있어도 강제 조회 실패 후에는 다시 조회해 실패를 숨기지 않는다', async () => {
  let fail = false, calls = 0;
  const meter = service(async () => { calls++; if (fail) throw Error('offline'); return fixture(); });
  await meter.read(); fail = true;
  assert.equal((await meter.read(true)).status, 'stale');
  assert.equal((await meter.read()).status, 'stale'); assert.equal(calls, 3);
});
test('구독료 변경은 같은 할당량을 재환산하고 부적합한 금액/저장 실패는 거절', async () => {
  const meter = service(async () => fixture());
  await meter.read(); assert.equal(meter.setFee(300000), 300000);
  assert.equal((await meter.read()).window.usedKrw, 22400);
  for (const invalid of [NaN, -1, 0, 1.2, Infinity, '159000', 100000001]) assert.throws(() => meter.setFee(invalid));
  const failed = service(async () => fixture(), {saveSettings: () => { throw Error('disk full'); }});
  assert.throws(() => failed.setFee(300000), /disk full/);
  assert.equal((await failed.read()).feeKrw, 159000);
});
