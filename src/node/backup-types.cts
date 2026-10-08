export type Settings = Record<string, unknown>;

export interface SettingsStore {
  read(): Settings;
  update(patch: Settings): Settings;
  replace(value: Settings): Settings;
  invalidate(): void;
}

export interface BackupLabel {
  id: string;
  kind?: 'status' | 'category';
  name: string;
  backgroundColor: string;
  textColor: string;
  order: number;
  enabled: boolean;
  description: string;
  [key: string]: unknown;
}

export interface BackupLabelConfig {
  schemaVersion: 1;
  labels: BackupLabel[];
  appearance: {
    position: 'before-title';
    style: 'filled';
    fontSizePx: number;
    borderRadiusPx: number;
    horizontalPaddingPx: number;
    verticalPaddingPx: number;
    gapPx: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface BackupAssignments {
  schemaVersion: 1;
  assignments: Record<string, string>;
  categoryAssignments?: Record<string, string>;
  [key: string]: unknown;
}

// Raw backup entries retain optional legacy fields without normalizing them.
export interface BackupVocabularyEntry {
  id: string;
  term: string;
  meaning: string;
  model: string;
  effort: string;
  savedAt: number;
  [key: string]: unknown;
}

export interface BackupVocabulary {
  version: 1 | 2;
  entries: BackupVocabularyEntry[];
  [key: string]: unknown;
}

export interface BackupMemo {
  id: string;
  created: string;
  quote: string;
  note: string;
  [key: string]: unknown;
}

export type PreferenceKey = 'vocabularyModel' | 'vocabularyGuide' | 'thresholds' | 'classifier';
export type BackupPreferences = Partial<Record<PreferenceKey, unknown>>;

export interface BackupData {
  labels: BackupLabelConfig;
  assignments: BackupAssignments;
  vocabulary: BackupVocabulary;
  memos: BackupMemo[];
  preferences?: BackupPreferences;
  [key: string]: unknown;
}

export interface BackupSourceData {
  labels: unknown;
  assignments: unknown;
  vocabulary: unknown;
  memos: unknown;
  preferences: BackupPreferences;
}

export interface BackupCounts {
  labels: number;
  status: number;
  categories: number;
  vocabulary: number;
  memos: number;
}

export interface BackupEnvelope {
  format: 'codex-memo-backup';
  schemaVersion: 1;
  appVersion: string;
  createdAt: string;
  deviceId: string;
  counts: BackupCounts;
  data: BackupData;
}

export interface BackupDocument {
  envelope: BackupEnvelope;
  title: string;
  markdown: string;
}

export interface BackupItem {
  pageId: string;
  title: string;
  createdAt: string;
  deviceId: string;
  counts?: BackupCounts;
  url?: string;
}

export interface BackupList {
  items: BackupItem[];
  partial: boolean;
  at: number;
  cached?: boolean;
}

export interface BackupStatus {
  busy: boolean;
  operation: '' | 'create' | 'list' | 'restore';
  automatic: boolean;
  last: BackupItem | null;
  error: string;
  warning: string;
}

export type BackupCreateResult = {unchanged: true} | (BackupItem & {warning?: string});

export interface BackupRestoreResult {
  counts: BackupCounts;
  localBackup: string;
  createdAt: string;
  warning?: string;
}

export interface BackupAPI {
  status(): BackupStatus;
  configure(enabled: boolean): BackupStatus;
  create(automatic?: boolean): Promise<BackupCreateResult>;
  list(force?: boolean): Promise<BackupList>;
  restore(pageId: string): Promise<BackupRestoreResult>;
  dispose(): void;
}

export interface BackupFileOptions {
  directory: string;
  dataDir: string;
  settings(): Settings;
  saveSettings(patch: Settings): unknown;
  replaceSettings?(value: Settings): unknown;
}

export interface BackupOptions extends BackupFileOptions {
  exe: () => string | null;
  onRestore?(): void;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
