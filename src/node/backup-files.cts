import fs = require('node:fs');
import path = require('node:path');
import {randomUUID} from 'node:crypto';
import {preferences, PREFS, validateData} from './backup-format.cjs';
import {errorMessage, hasErrorCode} from './backup-types.cjs';
import type {BackupFileOptions, BackupSourceData} from './backup-types.cjs';

type FileKey = 'labels' | 'assignments' | 'vocabulary' | 'memos';
const FILE_KEYS: readonly FileKey[] = ['labels', 'assignments', 'vocabulary', 'memos'];

export function readJSON(file: string, fallback: unknown): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (hasErrorCode(error, 'ENOENT')) return fallback; throw error; }
}

export function writeAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = file + '.backup-' + randomUUID();
  try {
    fs.writeFileSync(temp, Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (!hasErrorCode(error, 'ENOENT')) throw error; }
  }
}

export function createBackupFiles({directory, dataDir, settings, saveSettings, replaceSettings}: BackupFileOptions): {
  snapshot(): BackupSourceData;
  restore(source: unknown): string;
} {
  const files: Record<FileKey, string> = {
    labels: path.join(directory, 'labels.json'), assignments: path.join(directory, 'assignments.json'),
    vocabulary: path.join(directory, 'vocabulary.json'), memos: path.join(dataDir, 'memos', 'memos.json'),
  };
  const defaults: Record<FileKey, unknown> = {
    labels: null, assignments: {schemaVersion: 1, assignments: {}}, vocabulary: {version: 1, entries: []}, memos: [],
  };
  const cache = new Map<FileKey, {stamp: string; value: unknown}>();

  function read(key: FileKey): unknown {
    const file = files[key], st = fs.statSync(file, {throwIfNoEntry: false});
    const stamp = st ? `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}` : 'missing';
    const cached = cache.get(key);
    if (cached?.stamp === stamp) return cached.value;
    const value = readJSON(file, defaults[key]);
    cache.set(key, {stamp, value});
    return value;
  }

  function snapshot(): BackupSourceData {
    return {
      labels: read('labels'), assignments: read('assignments'), vocabulary: read('vocabulary'), memos: read('memos'),
      preferences: preferences(settings()),
    };
  }

  function restore(source: unknown): string {
    const data = validateData(source);
    // Prepare all original bytes before modifying any file.
    const originals = new Map<string, Buffer | null>();
    for (const file of Object.values(files)) {
      try { originals.set(file, fs.readFileSync(file)); }
      catch (error) { if (!hasErrorCode(error, 'ENOENT')) throw error; originals.set(file, null); }
    }
    const oldSettings = settings();
    const local = path.join(dataDir, 'restore-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
    fs.mkdirSync(local, {recursive: true});
    for (const key of FILE_KEYS) {
      const bytes = originals.get(files[key]);
      if (bytes !== null && bytes !== undefined) fs.writeFileSync(path.join(local, key + '.json'), bytes);
    }
    writeAtomic(path.join(local, 'settings.json'), oldSettings);
    const written: string[] = [];
    let settingsAttempted = false;
    try {
      for (const key of FILE_KEYS) {
        const file = files[key];
        writeAtomic(file, data[key]);
        written.push(file);
      }
      settingsAttempted = true;
      saveSettings(Object.fromEntries(PREFS.map(key => [key, data.preferences?.[key]])));
    } catch (error) {
      const failures: string[] = [];
      for (const file of written.reverse()) {
        try {
          const original = originals.get(file);
          if (original !== null && original !== undefined) writeAtomic(file, original);
          else fs.unlinkSync(file);
        } catch (rollbackError) { failures.push(errorMessage(rollbackError)); }
      }
      if (settingsAttempted) {
        try {
          if (replaceSettings) replaceSettings(oldSettings);
          else writeAtomic(path.join(dataDir, 'settings.json'), oldSettings);
        } catch (rollbackError) { failures.push(errorMessage(rollbackError)); }
      }
      if (failures.length) throw Error(`복원 중 오류: ${errorMessage(error)}\n이전 데이터: ${local}\n원본 복구 미완료: ${failures.join('; ')}`);
      throw Error(`복원하지 못해 이전 데이터로 되돌렸습니다: ${errorMessage(error)}\n보관 위치: ${local}`);
    } finally { cache.clear(); }
    return local;
  }
  return {snapshot, restore};
}
