// @ts-check
// Shared by the injected pet and Node tests. No network, inference or task writes.
(() => {
  const PROJECTS = Object.freeze([
    {id: 'mmh', name: '프로젝트 A'}, {id: 'erp', name: '프로젝트 B'},
    {id: 'sns', name: '프로젝트 C'}, {id: 'openproject', name: '프로젝트 D'},
  ]);
  const MAX_BYTES = 128 * 1024;
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function text(value, limit = 2000) {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > limit) throw Error('문자열 필드의 형식이나 길이를 확인해 주세요.');
    return value.trim();
  }
  function date(value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        || !Number.isFinite(Date.parse(value))) throw Error('갱신 시각은 시간대를 포함한 ISO 날짜여야 합니다.');
    return new Date(value).toISOString();
  }
  function safeUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  function source(value) {
    if (!record(value) || !['space', 'openproject', 'sample'].includes(value.kind) || !text(value.label, 200))
      throw Error('출처 kind(space/openproject/sample)와 label이 필요합니다.');
    return {kind: value.kind, label: text(value.label, 200), ref: text(value.ref, 300),
      url: safeUrl(text(value.url, 2000)), updatedAt: date(value.updatedAt)};
  }
  function checklist(value) {
    if (value == null) return null;
    if (!record(value) || typeof value.complete !== 'boolean' || !Array.isArray(value.items) || value.items.length > 200)
      throw Error('체크리스트에는 complete와 최대 200개의 items가 필요합니다.');
    const ids = new Set();
    const items = value.items.map(item => {
      if (!record(item) || !text(item.id, 100) || !text(item.text, 500) || typeof item.done !== 'boolean' || ids.has(item.id))
        throw Error('체크리스트의 고유 id, text, boolean done을 확인해 주세요.');
      const id = text(item.id, 100);
      if (ids.has(id)) throw Error('체크리스트 id가 중복됩니다.');
      ids.add(id);
      return {id, text: text(item.text, 500), done: item.done};
    });
    return {complete: value.complete, items};
  }
  function normalize(value) {
    if (!record(value) || value.formatVersion !== 1 || !Array.isArray(value.projects) || value.projects.length > 4)
      throw Error('formatVersion: 1과 최대 4개의 projects가 필요합니다.');
    const origin = source(value.source), seen = new Set();
    const projects = value.projects.map(item => {
      if (!record(item) || !PROJECTS.some(project => project.id === item.id) || seen.has(item.id))
        throw Error('업무 id는 mmh/erp/sns/openproject 중 하나이며 중복될 수 없습니다.');
      seen.add(item.id);
      if (item.blockers != null && (!Array.isArray(item.blockers) || item.blockers.length > 20))
        throw Error('blockers는 최대 20개의 문장 배열이어야 합니다.');
      return {id: item.id, stage: text(item.stage, 160), summary: text(item.summary),
        blockers: (item.blockers || []).map(line => text(line, 500)).filter(Boolean),
        nextAction: text(item.nextAction, 1000), checklist: checklist(item.checklist),
        source: item.source ? source(item.source) : origin};
    });
    return {formatVersion: 1, source: origin, projects};
  }
  function parse(raw) {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_BYTES)
      throw Error('JSON은 128 KiB 이하여야 합니다.');
    let value;
    try { value = JSON.parse(raw); } catch { throw Error('JSON 문법을 확인해 주세요. 이전 자료는 유지됩니다.'); }
    return normalize(value);
  }
  function progress(list) {
    if (!list) return {done: null, total: null, percent: null};
    const done = list.items.filter(item => item.done).length, total = list.items.length;
    return {done, total, percent: list.complete && total > 0 ? Math.round(done / total * 100) : null};
  }
  function rows(snapshot) {
    return PROJECTS.map(project => {
      const item = snapshot?.projects.find(candidate => candidate.id === project.id);
      return {...project, ...item, stage: item?.stage || '미정', progress: progress(item?.checklist), present: !!item};
    });
  }
  // Both adapters consume explicit exported snapshots, never native API estimates.
  // An existing authorized reader can later supply the same envelope to read().
  function createAdapter(kind, read) {
    if (!['space', 'openproject', 'sample'].includes(kind)) throw Error('지원하지 않는 출처입니다.');
    return {kind, async read() {
      const value = await read();
      const document = typeof value === 'string' ? parse(value) : normalize(value);
      if (document.source.kind !== kind) throw Error('어댑터와 자료의 출처가 다릅니다.');
      return document;
    }};
  }
  function sample() {
    return normalize({formatVersion: 1,
      source: {kind: 'sample', label: '기능 안내용 가상 프로젝트 · 실제 업무 아님', ref: 'demo-snapshot'},
      projects: [
        {id: 'mmh', stage: '예시 준비 단계', blockers: ['가상 체크리스트를 준비하는 단계입니다.'],
          nextAction: '예시 프로젝트의 확인 항목을 정리합니다.'},
        {id: 'erp', stage: '예시 검토 중',
          summary: '기능을 설명하기 위한 가상 자료입니다. 설명만으로 완료율을 계산하지 않습니다.',
          nextAction: '가상 체크리스트의 각 항목을 확인합니다.'},
        {id: 'sns', stage: '예시 작업 대기',
          summary: '준비가 끝난 뒤 시작할 가상 프로젝트입니다.',
          nextAction: '예시 작업의 시작 조건을 확인합니다.'},
        {id: 'openproject', stage: '예시 결과 확인',
          summary: '상세 정보 표시를 위한 가상 프로젝트입니다.',
          nextAction: '예시 결과와 확인 기준을 비교합니다.'},
      ]});
  }
  const api = {PROJECTS, MAX_BYTES, normalize, parse, progress, rows, safeUrl, createAdapter, sample};
  if (typeof window !== 'undefined') /** @type {any} */ (window).__cxmTaskProgressModel = api;
  else if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
