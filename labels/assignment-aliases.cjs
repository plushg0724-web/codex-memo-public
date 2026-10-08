'use strict';

// Host names may contain colons (remote-ssh-discovered:host), as may local UUIDs.
const LOCAL_ID_KEY = /^thread:(.+):([^:]+):(local:[0-9a-f-]{8,})$/i;
const THREAD_KEY = /^thread:(.+):([^:]+):([^:]+)$/;
const canonical = key => {
  const m = LOCAL_ID_KEY.exec(key) || THREAD_KEY.exec(key);
  return m ? `thread:local:${m[2]}:${m[3]}` : null;
};

function withAliases(snapshot) {
  if (!snapshot) return snapshot;
  const result = {...snapshot};
  for (const field of ['assignments','categoryAssignments']) {
    const assignments = {...snapshot[field]};
    for (const [key,id] of Object.entries(snapshot[field] || {})) {
      const c = canonical(key);
      if (c && !(c in assignments)) assignments[c] = id;
    }
    result[field] = assignments;
  }
  return result;
}

function assignAliases(store,keys,id,kind) {
  return store.assignMany(keys,id,kind,(selected,assignments) => {
    const targets = new Set(selected.map(key => canonical(key) || key));
    const expanded = new Set(targets);
    for (const other of Object.keys(assignments)) {
      if (targets.has(canonical(other))) expanded.add(other);
    }
    return [...expanded];
  });
}

function assignWithAliases(store,key,id,kind) { return assignAliases(store,[key],id,kind); }

// 여러 대화에 같은 라벨을 지정한다(id=null 이면 해제). 마지막 스냅샷을 돌려준다.
function assignManyWithAliases(store,keys,id,kind) {
  if (!Array.isArray(keys) || keys.length === 0) throw Error('바꿀 대화를 고르세요.');
  if (kind !== 'status' && kind !== 'category') throw Error('라벨 종류가 올바르지 않습니다.');
  return assignAliases(store,[...new Set(keys.map(String))],id,kind);
}

module.exports = {canonical,withAliases,assignWithAliases,assignManyWithAliases};
