import fs = require('node:fs');
import path = require('node:path');
import os = require('node:os');
import {createToolPool} from './appserver.cjs';
import {createBackupFiles, writeAtomic} from './backup-files.cjs';
import {createBackupSpace} from './backup-space.cjs';
import {encode, counts} from './backup-format.cjs';
import {errorMessage, hasErrorCode, isRecord} from './backup-types.cjs';
import type {BackupAPI, BackupItem, BackupOptions, BackupStatus, Settings} from './backup-types.cjs';

const INTERVAL = 5 * 60 * 1000;

function backupConfig(settings: Settings): Record<string, unknown> {
  return isRecord(settings.accountBackup) ? settings.accountBackup : {};
}

function savedBackup(value: unknown): BackupItem | null {
  if (!isRecord(value) || typeof value.pageId !== 'string' || typeof value.title !== 'string' ||
      typeof value.createdAt !== 'string' || typeof value.deviceId !== 'string') return null;
  const countValues = value.counts;
  const savedCounts = isRecord(countValues) &&
    typeof countValues.labels === 'number' && typeof countValues.status === 'number' &&
    typeof countValues.categories === 'number' && typeof countValues.vocabulary === 'number' && typeof countValues.memos === 'number'
    ? {labels: countValues.labels, status: countValues.status, categories: countValues.categories,
      vocabulary: countValues.vocabulary, memos: countValues.memos}
    : undefined;
  return {
    pageId: value.pageId, title: value.title, createdAt: value.createdAt, deviceId: value.deviceId,
    ...(savedCounts ? {counts: savedCounts} : {}), ...(typeof value.url === 'string' ? {url: value.url} : {}),
  };
}

export function createBackup({exe, directory, dataDir, settings, saveSettings, replaceSettings, onRestore}: BackupOptions): BackupAPI {
  const pool = createToolPool(exe);
  const space = createBackupSpace(pool);
  const files = createBackupFiles({directory, dataDir, settings, saveSettings, replaceSettings});
  const lastDataPath = path.join(dataDir, 'account-backup-last-data.json');
  const version = fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim();
  const deviceId = os.hostname();
  let operation: BackupStatus['operation'] = '';
  let closed = false, lastContent: string | null = null, lastError = '', warning = '', failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { lastContent = fs.readFileSync(lastDataPath, 'utf8'); }
  catch (error) { if (!hasErrorCode(error, 'ENOENT')) warning = errorMessage(error); }

  function ensureOpen(): void { if (closed) throw Error('계정 백업 연결이 종료됐습니다.'); }

  async function exclusive<T>(name: Exclude<BackupStatus['operation'], ''>, work: () => Promise<T>): Promise<T> {
    ensureOpen();
    if (operation) throw Error('백업 작업이 진행 중입니다. 잠시 뒤 다시 시도하세요.');
    operation = name;
    warning = '';
    try {
      const result = await work();
      lastError = '';
      return result;
    } catch (error) {
      lastError = errorMessage(error);
      throw error;
    } finally { operation = ''; }
  }

  // A completed remote save/restore stays successful if optional bookkeeping fails.
  function remember(content: string): void {
    lastContent = content;
    try { writeAtomic(lastDataPath, Buffer.from(content)); }
    catch (error) { warning = '완료했지만 마지막 백업 상태를 저장하지 못했습니다: ' + errorMessage(error); }
  }

  function schedule(delay = INTERVAL): void {
    clearTimeout(timer);
    if (closed) return;
    timer = setTimeout(async () => {
      try {
        if (!operation && backupConfig(settings()).automatic) {
          await api.create(true);
          failures = 0;
        }
      } catch (error) {
        lastError = errorMessage(error);
        failures++;
      } finally { schedule(Math.min(INTERVAL * 2 ** failures, 60 * 60 * 1000)); }
    }, delay);
    timer.unref();
  }

  const api: BackupAPI = {
    status() {
      const config = backupConfig(settings());
      return {busy: !!operation, operation, automatic: !!config.automatic, last: savedBackup(config.last), error: lastError, warning};
    },
    configure(enabled) {
      ensureOpen();
      saveSettings({accountBackup: {...backupConfig(settings()), automatic: !!enabled}});
      failures = 0;
      schedule();
      return api.status();
    },
    create(automatic = false) {
      return exclusive('create', async () => {
        const data = files.snapshot();
        const content = JSON.stringify(data);
        if (automatic && content === lastContent) return {unchanged: true as const};
        const document = encode(data, {version, deviceId});
        const last = await space.create(document);
        ensureOpen();
        remember(content);
        try { saveSettings({accountBackup: {...backupConfig(settings()), last}}); }
        catch (error) { warning = '백업은 저장됐지만 이 PC의 완료 기록을 갱신하지 못했습니다: ' + errorMessage(error); }
        return {...last, ...(warning ? {warning} : {})};
      });
    },
    list(force = false) { return exclusive('list', () => space.list(force)); },
    restore(pageId) {
      return exclusive('restore', async () => {
        const backup = await space.read(pageId);
        ensureOpen();
        const localBackup = files.restore(backup.data);
        remember(JSON.stringify(files.snapshot()));
        try { onRestore?.(); }
        catch (error) { warning = '데이터는 복원됐지만 화면 갱신에 실패했습니다. 도우미를 다시 실행하세요: ' + errorMessage(error); }
        return {counts: counts(backup.data), localBackup, createdAt: backup.createdAt, ...(warning ? {warning} : {})};
      });
    },
    dispose() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      pool.close();
    },
  };
  schedule();
  return api;
}
