import {isRecord} from './backup-types.cjs';
import type {
  BackupCounts, BackupData, BackupDocument, BackupEnvelope, BackupLabelConfig,
  BackupPreferences, PreferenceKey, Settings,
} from './backup-types.cjs';

const {validateConfig, validateKey} = require('../../labels/vendor/store.cjs') as {
  validateConfig(value: unknown): BackupLabelConfig;
  validateKey(value: unknown): void;
};
const {validateVocabularyData} = require('../../labels/vendor/vocabulary.cjs') as {
  validateVocabularyData(value: unknown): unknown[];
};

export const PREFIX = 'CodexMemo Backup';
const FORMAT = 'codex-memo-backup';
const MAX_BYTES = 80000;
export const PREFS: readonly PreferenceKey[] = ['vocabularyModel', 'vocabularyGuide', 'thresholds', 'classifier'];

export function preferences(settings: Settings): BackupPreferences {
  return Object.fromEntries(PREFS.filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
}

/** The legacy validators preserve stored fields; snapshots are never rewritten during validation. */
export function validateData(data: unknown): BackupData {
  if (!isRecord(data)) throw Error('백업 데이터가 없습니다.');
  validateConfig(data.labels);
  if (!isRecord(data.assignments) || data.assignments.schemaVersion !== 1 || !isRecord(data.assignments.assignments)) {
    throw Error('진행 상태 지정 형식을 확인하세요.');
  }
  const categories = data.assignments.categoryAssignments ?? {};
  if (!isRecord(categories)) throw Error('카테고리 지정 형식을 확인하세요.');
  for (const map of [data.assignments.assignments, categories]) {
    for (const [key, value] of Object.entries(map)) {
      validateKey(key);
      if (typeof value !== 'string') throw Error('라벨 지정 형식을 확인하세요.');
    }
  }
  validateVocabularyData(data.vocabulary);
  if (!Array.isArray(data.memos)) throw Error('메모 목록 형식을 확인하세요.');
  const ids = new Set<string>();
  for (const memo of data.memos as unknown[]) {
    if (!isRecord(memo) || typeof memo.id !== 'string' || !memo.id || ids.has(memo.id) ||
        ['created', 'quote', 'note'].some(key => typeof memo[key] !== 'string')) {
      throw Error('메모 항목 형식을 확인하세요.');
    }
    ids.add(memo.id);
  }
  if (data.preferences !== undefined && !isRecord(data.preferences)) throw Error('공통 설정 형식을 확인하세요.');
  // All required data fields have passed their existing format validators above.
  return data as BackupData;
}

export function counts(data: BackupData): BackupCounts {
  return {
    labels: data.labels.labels.length,
    status: Object.keys(data.assignments.assignments).length,
    categories: Object.keys(data.assignments.categoryAssignments || {}).length,
    vocabulary: data.vocabulary.entries.length,
    memos: data.memos.length,
  };
}

export function encode(source: unknown, {version, deviceId, now = new Date()}: {
  version: string; deviceId: string; now?: Date;
}): BackupDocument {
  const data = validateData(source);
  const envelope: BackupEnvelope = {
    format: FORMAT, schemaVersion: 1, appVersion: version,
    createdAt: now.toISOString(), deviceId, counts: counts(data), data,
  };
  const markdown = '# Codex 메모 계정 백업\n\n' + envelope.createdAt + ' · ' + deviceId +
    '\n\n```json\n' + JSON.stringify(envelope) + '\n```';
  if (Buffer.byteLength(markdown, 'utf8') > MAX_BYTES) throw Error('텍스트 백업 한도(80 KB)를 넘었습니다. 파일 백업을 사용하세요.');
  return {envelope, title: `${PREFIX} · ${deviceId} · ${envelope.createdAt}`, markdown};
}

export function decode(page: unknown): BackupEnvelope {
  const content = isRecord(page) && isRecord(page.content) ? page.content : {};
  const blocks: unknown[] = Array.isArray(content.blocks) ? content.blocks : [];
  const markdown = blocks.map(block => isRecord(block) && typeof block.markdown === 'string' ? block.markdown : '').join('\n') ||
    (typeof content.markdown === 'string' ? content.markdown : '');
  const matches = markdown.matchAll(/```json\s*\n([\s\S]*?)\n```/g);
  for (const match of matches) {
    let backup: unknown;
    try { backup = JSON.parse(match[1]); } catch { continue; }
    if (!isRecord(backup) || backup.format !== FORMAT) continue;
    if (backup.schemaVersion !== 1) throw Error('지원하지 않는 백업 버전입니다.');
    const data = validateData(backup.data);
    return {
      format: FORMAT, schemaVersion: 1,
      appVersion: typeof backup.appVersion === 'string' ? backup.appVersion : '',
      createdAt: typeof backup.createdAt === 'string' ? backup.createdAt : '',
      deviceId: typeof backup.deviceId === 'string' ? backup.deviceId : '',
      counts: counts(data), data,
    };
  }
  throw Error('이 페이지에서 코덱스 메모 백업을 찾지 못했습니다.');
}
