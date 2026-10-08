import type * as D from './backend-types.cjs';
import type {BackupStatus, BackupCreateResult, BackupList, BackupRestoreResult} from './backup-types.cjs';

/** Each method has one tuple for wire arguments and one result type. */
export interface BackendMethods {
  subscriptionUsage: {args: [force?: boolean]; result: import('./subscription-usage.cjs').SubscriptionUsage};
  subscriptionFeeSet: {args: [feeKrw: number]; result: number};
  read: {args: [knownVersion?: string | null]; result: D.LabelSnapshot | null};
  assign: {args: [key: string, id: string | null, kind?: D.LabelKind]; result: D.LabelSnapshot};
  assignMany: {args: [keys: string[], id: string | null, kind: D.LabelKind]; result: D.LabelSnapshot};
  saveConfig: {args: [draft: unknown, revision: string]; result: D.LabelSnapshot};
  report: {args: [counts?: unknown]; result: boolean};
  openConfig: {args: []; result: boolean};
  vocabularyRead: {args: []; result: D.VocabSnapshot};
  vocabularySummarize: {args: [input: D.VocabInput]; result: D.VocabDraft};
  vocabularyReanalyze: {args: [id: string, revision: string]; result: D.VocabRevisionDraft};
  vocabularyFollowup: {args: [id: string, question: string, revision: string]; result: D.VocabRevisionDraft};
  vocabularyParagraph: {args: [id: string, paragraph: D.VocabParagraphInput, revision: string]; result: D.VocabRevisionDraft};
  vocabularyCancel: {args: []; result: boolean};
  vocabularySave: {args: [id: string, revision: string, options?: D.VocabSaveOptions]; result: D.VocabSnapshot};
  vocabularyJudge: {args: [input: D.VocabInput]; result: D.SenseChoice | null};
  vocabularySenseRank: {args: [term: string, context: string]; result: string[] | null};
  vocabularyUsage: {args: [input: D.VocabInput, entryId: string]; result: string};
  labelSuggest: {args: [threadIds: string[], titles?: D.ThreadTitles]; result: D.LabelSuggestions};
  threadStatus: {args: [threadIds: string[], digests?: D.ThreadDigests]; result: D.ThreadStatuses};
  threadStates: {args: [threadIds: string[]]; result: D.ThreadStates};
  taskPetSuggest: {args: [options?: D.TaskPetOptions]; result: D.TaskPetResult};
  taskPetSettings: {args: []; result: D.PetSettings};
  taskPetSettingsSet: {args: [patch: Record<string, unknown>]; result: D.PetSettings};
  classifierGet: {args: []; result: D.ClassifierInfo};
  classifierSet: {args: [mode: D.ClassifierMode]; result: D.ClassifierInfo};
  memoClassify: {args: [memo: Partial<D.Memo>]; result: {category: D.MemoCategory; confidence: number} | null};
  memoScores: {args: [memo: Partial<D.Memo>]; result: D.Scores};
  labelScores: {args: [threadId: string, title?: string | D.ThreadDigest]; result: D.Scores};
  autoSettings: {args: []; result: D.AutoSettings};
  thresholdsSet: {args: [patch: Partial<D.AutoThresholds>]; result: D.AutoThresholds};
  autoRefresh: {args: []; result: boolean};
  vocabularyModels: {args: []; result: D.VocabModel[]};
  vocabularyModel: {args: []; result: D.VocabModelChoice};
  vocabularySetModel: {args: [model: string, effort: D.ReasoningEffort]; result: D.VocabModelChoice};
  vocabularySetFast: {args: [fast: boolean]; result: D.VocabModelChoice};
  vocabularyGuide: {args: []; result: D.VocabGuide};
  vocabularySetGuide: {args: [text?: string | null]; result: D.VocabGuide};
  vocabularyEdit: {args: [id: string, patch: D.VocabEdits, revision: string]; result: D.VocabSnapshot};
  vocabularyDelete: {args: [id: string, revision: string]; result: D.VocabSnapshot};
  vocabularyAdd: {args: [input: D.VocabAddInput]; result: D.VocabEntry | undefined};
  vocabularyRestore: {args: [entry: D.VocabEntry]; result: D.VocabEntry | null};
  threadCatalog: {args: [max?: number]; result: D.ThreadCatalogEntry[]};
  backupStatus: {args: []; result: BackupStatus};
  backupCreate: {args: []; result: BackupCreateResult};
  backupList: {args: [force?: boolean]; result: BackupList};
  backupRestore: {args: [pageId: string]; result: BackupRestoreResult};
  backupConfigure: {args: [enabled: boolean]; result: BackupStatus};
  sheetsStatus: {args: []; result: D.SheetsStatus};
  sheetsConnect: {args: [memos?: D.Memo[]]; result: D.SheetsStatus};
  sheetsAppendMemo: {args: [memo: D.Memo]; result: boolean};
  dispose: {args: []; result: boolean};
}
export type MethodName = keyof BackendMethods;
export type MethodArgs<K extends MethodName> = BackendMethods[K]['args'];
export type MethodResult<K extends MethodName> = BackendMethods[K]['result'];
export type MethodHandler<K extends MethodName> = (sender: string, ...args: MethodArgs<K>) => MethodResult<K> | Promise<MethodResult<K>>;
export type BackendHandlers = {[K in MethodName]: MethodHandler<K>};
export type BackendCall = <K extends MethodName>(method: K, sender: string, ...args: MethodArgs<K>) => Promise<MethodResult<K>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function errorMessage(value: unknown): string {return value instanceof Error ? value.message : String(value);}
function object(value: unknown): Record<string, unknown> {if (!isRecord(value)) throw Error('입력 객체를 확인하세요.'); return value;}
function text(value: unknown): string {if (typeof value !== 'string') throw Error('입력 문자열을 확인하세요.'); return value;}
function number(value: unknown): number {if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('입력 숫자를 확인하세요.'); return value;}
function boolean(value: unknown): boolean {if (typeof value !== 'boolean') throw Error('입력 설정을 확인하세요.'); return value;}
function strings(value: unknown): string[] {if (!Array.isArray(value)) throw Error('입력 목록을 확인하세요.'); return value.map(text);}
function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {return value == null ? undefined : parse(value);}
function nullableText(value: unknown): string | null {return value === null ? null : text(value);}
function kind(value: unknown): D.LabelKind {if (value === 'status' || value === 'category') return value; throw Error('라벨 종류를 확인하세요.');}
function classifier(value: unknown): D.ClassifierMode {if (value === 'mica' || value === 'jev' || value === 'both') return value; throw Error('분류기를 확인하세요.');}
export function isEffort(value: unknown): value is D.ReasoningEffort {
  return value === 'none' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' || value === 'ultra';
}
function effort(value: unknown): D.ReasoningEffort {if (isEffort(value)) return value; throw Error('추론 강도를 확인하세요.');}
function vocabInput(value: unknown): D.VocabInput {
  const v = object(value), source = optional(v.source, object);
  return {...v, term: text(v.term), context: optional(v.context, text), judge: optional(v.judge, boolean),
    source: source && {title: optional(source.title, text), path: optional(source.path, text)}};
}
function followups(value: unknown): D.VocabFollowup[] {
  if (!Array.isArray(value) || value.length > 20) throw Error('추가 질문은 단어 하나에 20개까지 저장할 수 있습니다.');
  return value.map(item => {
    const v = object(item);
    return {id: text(v.id), question: text(v.question), answer: text(v.answer), createdAt: number(v.createdAt), model: text(v.model), effort: effort(v.effort)};
  });
}
function edits(value: unknown): D.VocabEdits {
  const v = object(value);
  const status = optional(v.status, value => {if (value === 'new' || value === 'review' || value === 'known') return value; throw Error('학습 상태를 확인하세요.');});
  // Keep unknown fields for the vocabulary store's existing editable-field check.
  const result: D.VocabEdits = {...v};
  for (const key of ['meaning', 'example', 'partOfSpeech', 'explanation'] as const) if (key in v) result[key] = text(v[key]);
  for (const key of ['tags', 'definitions', 'previewParagraphs'] as const) if (key in v) result[key] = strings(v[key]);
  if ('followups' in v) result.followups = followups(v.followups);
  if ('favorite' in v) result.favorite = boolean(v.favorite);
  if ('definitionIndex' in v) result.definitionIndex = number(v.definitionIndex);
  if (status !== undefined) result.status = status;
  return result;
}
function entry(value: unknown): D.VocabEntry {
  const v = object(value);
  const editable: Record<string, unknown> = {};
  for (const key of ['meaning', 'example', 'partOfSpeech', 'explanation', 'tags', 'definitions', 'definitionIndex', 'favorite', 'status', 'followups', 'previewParagraphs']) if (key in v) editable[key] = v[key];
  return {...vocabInput(v), ...edits(editable), id: text(v.id), meaning: text(v.meaning), model: text(v.model), effort: effort(v.effort),
    savedAt: number(v.savedAt), updatedAt: optional(v.updatedAt, number)};
}
function addInput(value: unknown): D.VocabAddInput {
  const v = object(value);
  return {...v, term: text(v.term), meaning: text(v.meaning), context: optional(v.context, text), sourceTitle: optional(v.sourceTitle, text),
    example: optional(v.example, text), partOfSpeech: optional(v.partOfSpeech, text), explanation: optional(v.explanation, text), tags: optional(v.tags, strings)};
}
function saveOptions(value: unknown): D.VocabSaveOptions {
  const v = object(value);
  const mode = optional(v.mode, value => {if (value === 'add' || value === 'replace' || value === 'upsert') return value; throw Error('저장 방식을 확인하세요.');});
  return {...v, mode, targetId: optional(v.targetId, text), edits: optional(v.edits, edits)};
}
function memo(value: unknown): Partial<D.Memo> {
  const v = object(value), result: Partial<D.Memo> = {};
  for (const key of ['id', 'created', 'title', 'window', 'conv', 'quote', 'note', 'exact', 'prefix', 'suffix'] as const) if (v[key] != null) result[key] = text(v[key]);
  if (v.category !== undefined) {
    if (v.category !== '' && v.category !== 'todo' && v.category !== 'idea' && v.category !== 'question' && v.category !== 'reference') throw Error('메모 분류를 확인하세요.');
    result.category = v.category;
  }
  return result;
}
function fullMemo(value: unknown): D.Memo {const v = object(value); return {...memo(v), id: text(v.id), created: text(v.created), quote: typeof v.quote === 'string' ? v.quote : '', note: typeof v.note === 'string' ? v.note : ''};}
function digest(value: unknown): D.ThreadDigest {
  const v = object(value);
  return {title: text(v.title), updatedAt: number(v.updatedAt), firstUser: text(v.firstUser), lastUser: text(v.lastUser), lastAgent: text(v.lastAgent), finished: boolean(v.finished)};
}
function title(value: unknown): string | D.ThreadDigest {return typeof value === 'string' ? value : digest(value);}
function dictionary<T>(value: unknown, parse: (value: unknown) => T): Record<string, T> {return Object.fromEntries(Object.entries(object(value)).map(([key, item]) => [key, parse(item)]));}
function petOptions(value: unknown): D.TaskPetOptions {const v = object(value); return {currentThreadId: optional(v.currentThreadId, text), dismissedIds: optional(v.dismissedIds, strings)};}
function thresholds(value: unknown): Partial<D.AutoThresholds> {
  const v = object(value), result: Partial<D.AutoThresholds> = {};
  for (const key of ['label', 'status', 'memo', 'sense'] as const) if (v[key] != null) result[key] = number(v[key]);
  return result;
}

const decoders: {[K in MethodName]: (args: unknown[]) => MethodArgs<K>} = {
  subscriptionUsage: a => [optional(a[0], boolean)],
  subscriptionFeeSet: a => [number(a[0])],
  read: a => [a[0] == null ? a[0] : text(a[0])],
  assign: a => [text(a[0]), nullableText(a[1]), optional(a[2], kind)],
  assignMany: a => [strings(a[0]), nullableText(a[1]), kind(a[2])],
  saveConfig: a => [a[0], text(a[1])], report: a => [a[0]], openConfig: () => [],
  vocabularyRead: () => [], vocabularySummarize: a => [vocabInput(a[0])], vocabularyCancel: () => [],
  vocabularyReanalyze: a => [text(a[0]), text(a[1])], vocabularyFollowup: a => [text(a[0]), text(a[1]), text(a[2])],
  vocabularyParagraph: a => {const p=object(a[1]);return [text(a[0]),{kind:text(p.kind),text:text(p.text),...(p.recordId===undefined?{}:{recordId:text(p.recordId)})},text(a[2])];},
  vocabularySave: a => [text(a[0]), text(a[1]), optional(a[2], saveOptions)],
  vocabularyJudge: a => [vocabInput(a[0])], vocabularySenseRank: a => [text(a[0]), a[1] == null ? '' : text(a[1])],
  vocabularyUsage: a => [vocabInput(a[0]), text(a[1])],
  labelSuggest: a => [strings(a[0]), optional(a[1], v => dictionary(v, title))],
  threadStatus: a => [strings(a[0]), optional(a[1], v => dictionary(v, digest))], threadStates: a => [strings(a[0])],
  taskPetSuggest: a => [optional(a[0], petOptions)], classifierGet: () => [], classifierSet: a => [classifier(a[0])],
  taskPetSettings: () => [], taskPetSettingsSet: a => [object(a[0])],
  memoClassify: a => [memo(a[0])], memoScores: a => [memo(a[0])], labelScores: a => [text(a[0]), optional(a[1], title)],
  autoSettings: () => [], thresholdsSet: a => [thresholds(a[0])], autoRefresh: () => [],
  vocabularyModels: () => [], vocabularyModel: () => [], vocabularySetModel: a => [text(a[0]), effort(a[1])],
  vocabularySetFast: a => [boolean(a[0])], vocabularyGuide: () => [], vocabularySetGuide: a => [a[0] == null ? a[0] : text(a[0])],
  vocabularyEdit: a => [text(a[0]), edits(a[1]), text(a[2])], vocabularyDelete: a => [text(a[0]), text(a[1])],
  vocabularyAdd: a => [addInput(a[0])], vocabularyRestore: a => [entry(a[0])], threadCatalog: a => [optional(a[0], number)],
  backupStatus: () => [], backupCreate: () => [], backupList: a => [optional(a[0], boolean)],
  backupRestore: a => [text(a[0])], backupConfigure: a => [boolean(a[0])], sheetsStatus: () => [],
  sheetsConnect: a => [optional(a[0], value => {if (!Array.isArray(value)) throw Error('메모 목록을 확인하세요.'); return value.map(fullMemo);})],
  sheetsAppendMemo: a => [fullMemo(a[0])], dispose: () => [],
};

export function isMethodName(value: string): value is MethodName {return Object.hasOwn(decoders, value);}
export function createDispatcher(handlers: BackendHandlers) {
  const call: BackendCall = async <K extends MethodName>(method: K, sender: string, ...args: MethodArgs<K>): Promise<MethodResult<K>> => {
    const handler: MethodHandler<K> = handlers[method];
    return handler(sender, ...args);
  };
  const dispatch = async <K extends MethodName>(method: K, sender: string, args: unknown[]): Promise<MethodResult<K>> => call(method, sender, ...decoders[method](args));
  return {call, dispatch};
}
