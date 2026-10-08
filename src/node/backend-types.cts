import type {Request} from './appserver.cjs';
import type {Settings} from './backup-types.cjs';

export type LabelKind = 'status' | 'category';
export interface Label {
  id: string; kind?: LabelKind; name: string; backgroundColor: string; textColor: string;
  order: number; enabled: boolean; description: string;
}
export interface LabelConfig {
  schemaVersion: 1; labels: Label[];
  appearance: {position: 'before-title'; style: 'filled'; fontSizePx: number; borderRadiusPx: number;
    horizontalPaddingPx: number; verticalPaddingPx: number; gapPx: number};
}
export interface LabelSnapshot {
  config: LabelConfig; assignments: Record<string, string>; categoryAssignments: Record<string, string>;
  configPath: string; configRevision: string; configError: string | null; snapshotVersion?: string;
}
export interface LabelStore {
  snapshot(): LabelSnapshot;
  saveConfig(draft: unknown, revision: string): LabelSnapshot;
  configPath: string;
}
export interface SnapshotCache {
  snapshot(knownVersion?: string): LabelSnapshot | null;
  update(snapshot: LabelSnapshot): LabelSnapshot;
  invalidate(): void; close(): void;
}
export type MemoCategory = 'todo' | 'idea' | 'question' | 'reference';
export interface Memo {
  id: string; created: string; title?: string; window?: string; conv?: string; quote: string; note: string;
  exact?: string; prefix?: string; suffix?: string; category?: MemoCategory | '';
}
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export interface VocabModel {id: string; name: string; efforts: ReasoningEffort[]; defaultEffort?: ReasoningEffort; fast: boolean}
export interface VocabModelChoice {model: string; effort: ReasoningEffort; fast: boolean}
export interface VocabGuide {guide: string; defaultGuide: string; custom: boolean; limit: number}
export interface VocabInput {term: string; context?: string; source?: {title?: string; path?: string}; judge?: boolean}
export interface VocabEdits {
  meaning?: string; example?: string; partOfSpeech?: string; explanation?: string; tags?: string[];
  definitions?: string[]; definitionIndex?: number; favorite?: boolean; status?: 'new' | 'review' | 'known';
  followups?: VocabFollowup[]; previewParagraphs?: string[];
  showContextAnalysis?: boolean; contextAnalyses?: VocabContextAnalysis[];
}
export interface VocabContextAnalysis {id: string; context: string; analysis: string; source: {title?: string; path?: string}; createdAt: number; visible: boolean}
export interface VocabParagraphInput {kind: string; text: string; recordId?: string}
export interface VocabFollowup {id: string; question: string; answer: string; createdAt: number; model: string; effort: ReasoningEffort}
export interface VocabEntry extends VocabInput, VocabEdits {
  id: string; meaning: string; model: string; effort: ReasoningEffort; savedAt: number; updatedAt?: number;
}
export interface VocabDraft extends VocabEntry {usage?: string; matchedId?: string}
export interface VocabRevisionDraft extends VocabDraft {targetId: string; baseRevision: string; action: 'reanalyze' | 'followup'}
export interface VocabAddInput extends VocabEdits {term: string; meaning: string; context?: string; sourceTitle?: string}
export interface VocabSaveOptions {mode?: 'add' | 'replace' | 'upsert'; targetId?: string; edits?: VocabEdits}
export interface VocabSnapshot {version: number; revision: string; entries: VocabEntry[]}
export interface KnownSense {id: string; meaning: string; partOfSpeech: string; context: string}
export interface SummaryOptions extends VocabModelChoice {guide: string; known: KnownSense[]}
export interface SummaryHome {prepare(): string; release(): void}
export interface SummaryServer {
  run(request: {model: string; effort: string; fast: boolean; prompt: string; schema: object}, options?: {timeoutMs?: number; onStop?: (stop: () => void) => void}): Promise<string>;
  close(): void;
}
export interface Summarizer {summarize(sender: string, input: VocabInput, options: SummaryOptions): Promise<VocabDraft>; cancel(sender: string): void; dispose(): void}
export interface VocabularyStore {
  read(): VocabSnapshot;
  save(draft: VocabEntry, revision: string, options?: VocabSaveOptions): VocabSnapshot;
  edit(id: string, patch: VocabEdits, revision: string): VocabSnapshot;
  remove(id: string, revision: string): VocabSnapshot;
}
export interface VocabularyModule {
  createVocabularyStore(directory: string): VocabularyStore;
  createSummarizer(options: {executable: string | null | (() => string | null); home: string; homeLease: SummaryHome; server: SummaryServer}): Summarizer;
  loginEnvironment(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv;
  EFFORTS: ReasoningEffort[]; GUIDE: string; GUIDE_LIMIT: number;
}
export type ClassifierMode = 'mica' | 'jev' | 'both';
export interface ClassifierInfo {mode: ClassifierMode; available: boolean; jevKey: boolean}
export interface SenseChoice {choice: string; confidence: number; via: string}
export interface Mica {
  setMode(mode: string): void; getMode(): ClassifierMode; available(): Promise<boolean>;
  judgeSense(term: string, context: string, known: KnownSense[], threshold: number): Promise<SenseChoice | null>;
  rankSenses(term: string, context: string, known: KnownSense[]): Promise<{probabilities: Record<string, number>} | null>;
  ask(state: string, questions: Record<string, object>, options: {classifier: string}): Promise<unknown>;
}
export interface AutoThresholds {label: number; status: number; memo: number; sense: number}
export interface AutoSettings extends ClassifierInfo {thresholds: AutoThresholds; defaults: AutoThresholds}
export interface ThreadDigest {title: string; updatedAt: number; firstUser: string; lastUser: string; lastAgent: string; finished: boolean}
export type ThreadTitles = Record<string, string | ThreadDigest>;
export type ThreadDigests = Record<string, ThreadDigest>;
export interface ThreadCatalogEntry {id: string; name: string; cwd: string; updatedAt: number}
export type LabelSuggestions = Record<string, {labelId: string; confidence: number}>;
export type ThreadStatuses = Record<string, {state: 'ask' | 'blocked'; confidence: number}>;
export type ThreadStates = Record<string, 'ok' | 'archived' | 'missing' | 'unknown'>;
export type Scores = Record<string, number> | null;
export interface ServerPool {run<T>(work: (request: Request) => Promise<T>): Promise<T>}
export interface LabelSuggester {
  clear(): void; suggest(ids: string[], titles: ThreadTitles): Promise<LabelSuggestions>;
  scores(id: string, title: string | ThreadDigest): Promise<Scores>;
}
export interface ThreadStatus {clear(): void; status(ids: string[], digests: ThreadDigests): Promise<ThreadStatuses>}
export interface TaskPetOptions {currentThreadId?: string; dismissedIds?: string[]}
export interface PetSettings {enabled: boolean; model: string; effort: string; threshold: number; count: number; guide: string}
/** Newest turn of a conversation: its status, final answer and the user's last request. */
export interface LastTurn {status: string; completedAt: number | null; agentText: string; userText: string}
export interface TaskPetResult {
  limit?: number;
  status: 'ok' | 'empty' | 'unavailable' | 'source_error'; checkedAt: string; totalCandidates: number; message?: string; notice?: string;
  items: {id: string; threadId: string; title: string; state: string; badge: string; action: string; quote: string;
    quoteKind: '' | 'agent' | 'request' | 'memo'; labelName: string; updatedAt: number; confidence?: number; adviceModel?: string; adviceEffort?: string}[];
}
export type SheetRow = Record<string, string>;
export interface SheetsStatus {connected: boolean; url: string | null; spacePageUrl: string | null; pending: number; error: string; spaceError?: string}
export interface SheetSync {status(): SheetsStatus; connect(rows: SheetRow[]): Promise<SheetsStatus>; enqueue(row: SheetRow): void; dispose(): void}
export interface SheetsModule {
  createSheetSync(options: {exe: () => string | null; settings: () => Settings; saveSettings: (patch: Settings) => unknown}): SheetSync;
  vocabRow(entry: VocabEntry): SheetRow; memoRow(memo: Memo): SheetRow;
}

/** The legacy modules retain their own normalization; these adapters describe their public API. */
export interface LegacyModules {
  store: {createStore(directory: string): LabelStore};
  snapshotCache: {createSnapshotCache(store: LabelStore, directory: string, options: {onChange: () => void}): SnapshotCache};
  assignmentAliases: {
    withAliases<T extends LabelSnapshot | null>(snapshot: T): T;
    assignWithAliases(store: LabelStore, key: string, id: string | null, kind?: LabelKind): LabelSnapshot;
    assignManyWithAliases(store: LabelStore, keys: string[], id: string | null, kind: LabelKind): LabelSnapshot;
  };
  labelKind: {assignmentKind(config: LabelConfig, id: string): LabelKind};
  labelSuggester: {createLabelSuggester(options: {server: ServerPool; mica: Mica; snapshot: () => LabelSnapshot; threshold: () => number}): LabelSuggester};
  threadStatus: {createThreadStatus(options: {server: ServerPool; mica: Mica; threshold: () => number}): ThreadStatus};
  threadStates: {createThreadStates(options: {server: ServerPool}): {states(ids: string[]): Promise<ThreadStates>}};
  taskPet: {createTaskPet(options: {mica: Mica; settings?: () => PetSettings; advise?: (items: TaskPetResult['items'], config: PetSettings) => Promise<TaskPetResult['items']>; getSnapshot: () => LabelSnapshot; getThreads: (ids: string[], since?: number) => Promise<ThreadCatalogEntry[]>; getMemos: () => Promise<unknown[]>; getLastTurns: (ids: string[]) => Promise<Record<string, LastTurn>>}): {suggest(options: TaskPetOptions): Promise<TaskPetResult>}};
  petModel: {createPetModel(options: {server: SummaryServer; settings: () => Record<string, unknown>; saveSettings: (patch: Record<string, unknown>) => unknown}): {
    read(): PetSettings;
    save(patch: Record<string, unknown>): PetSettings;
    advise(items: TaskPetResult['items'], config?: PetSettings): Promise<TaskPetResult['items']>;
  }};
  memoClassify: {classifyMemo(memo: Partial<Memo>, threshold: number): Promise<{category: MemoCategory; confidence: number} | null>; memoScores(memo: Partial<Memo>): Promise<Scores>; clearMemoCache(): void};
}
