// 화면 스크립트와 Python 도우미가 주고받는 데이터. Node 메서드 계약은
// src/node/protocol.cts에서 관리하며 npm run build로 만든 선언을 공유한다.

// ---------------------------------------------------------------- 메모
/** memos/memos.json 의 메모 하나 */
interface Memo {
  id: string;
  created: string;          // "2026-10-02 12:00"
  title?: string;           // 메모를 쓴 대화 제목
  window?: string;          // 예전 형식의 제목
  conv?: string;            // 메모를 쓴 대화 ID (왼쪽 목록의 thread-id)
  quote: string;            // 선택한 글 (화면 표시용)
  note: string;             // 메모 내용
  exact?: string;           // 다시 찾기용: 정확한 글 (공백 정리됨)
  prefix?: string;          // 다시 찾기용: 앞 문맥 32자
  suffix?: string;          // 다시 찾기용: 뒤 문맥 32자
  category?: MemoCategory | "";
}
type MemoCategory = "todo" | "idea" | "question" | "reference";

/** 선택한 글의 위치 (W3C TextQuoteSelector 와 같은 방식) */
interface MemoAnchor {
  exact?: string;
  prefix?: string;
  suffix?: string;
}

/** 새 메모를 만들 때 화면이 모아 두는 정보 */
interface MemoDraft extends MemoAnchor {
  quote?: string;
  conv?: string;
  title?: string;
}

// ---------------------------------------------------------------- 화면 → 도우미 메시지
/** window.__codexMemoBridge(JSON.stringify(msg)) 로 보내는 메시지 (cdp_bridge.py Bridge.handle) */
type BridgeMessage =
  | { op: "hello" }
  | ({ op: "add"; note: string } & MemoDraft)
  | { op: "update"; id: string; note?: string; category?: MemoCategory | "" }
  | { op: "delete"; id: string }
  | { op: "labels"; id: number; method: LabelsMethod; args: unknown[]; cb?: ResponderName };

/** 도우미가 라벨·단어장 응답을 돌려줄 화면 쪽 객체 이름 */
type ResponderName = "__cxlBridge" | "__cxmPicker" | "__cxmUsage";

/** 도우미가 window[ResponderName].resolve(...) 로 응답을 넣어 주는 객체 */
interface Responder {
  resolve(id: number, ok: boolean, value: any): void;
}

// ---------------------------------------------------------------- 라벨·단어장 (backend.cjs 메서드)
type LabelsMethod = import('../dist/node/protocol.cjs').MethodName;
type LabelsCall = <K extends LabelsMethod>(method: K,
  ...args: import('../dist/node/protocol.cjs').MethodArgs<K>
) => Promise<import('../dist/node/protocol.cjs').MethodResult<K>>;

/** 다른 호스트(클라우드 durable) 대화 요약 — Codex 화면이 읽어 백엔드에 넘긴다 */
type ThreadDigest = { title: string; updatedAt: number; firstUser: string; lastUser: string; lastAgent: string; finished: boolean };

/** 자동 판단 기준 확신: 라벨 추천 · 대화 상태 · 메모 분류 · 단어 뜻 */
type AutoThresholds = { label: number; status: number; memo: number; sense: number };

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

interface VocabModel {
  id: string;
  name: string;
  efforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  /** FAST(service_tier "priority") 지원 */
  fast?: boolean;
}

interface VocabModelChoice {
  model: string;
  effort: ReasoningEffort;
  fast: boolean;
}

/** 단어장 요약 작성 지침 (설정에서 바꾸는 부분) */
interface VocabGuide {
  guide: string;
  defaultGuide: string;
  custom: boolean;
  limit: number;
}

/** 단어장 항목 (vendor/vocabulary.cjs entry()) — 메모 통합에 필요한 부분만 */
type VocabEntry = import('../dist/node/backend-types.cjs').VocabEntry;
type VocabRevisionDraft = import('../dist/node/backend-types.cjs').VocabRevisionDraft;
interface VocabParagraph {text: string; label: string; kind: string; recordId?: string}
interface VocabContent {
  paragraphs(entry: Partial<VocabEntry>): VocabParagraph[];
  selectedParagraphs(entry: Partial<VocabEntry>): VocabParagraph[];
  normalizeSelections(entry: Partial<VocabEntry>): string[];
  replaceParagraph(entry: VocabEntry, paragraph: VocabParagraph, answer: string): Partial<VocabEntry>;
}

interface VocabSnapshot {
  version: number;
  revision: string;
  entries: VocabEntry[];
}

/** Codex Labels 화면 코드가 쓰는 API (labels/shim.js 가 제공) */
interface CodexLabelsApi {
  read(knownVersion?: string | null): Promise<any>;
  onChanged(callback: () => void): () => void;
  assign(key: string, id: string | null, kind?: "status" | "category"): Promise<any>;
  assignMany(keys: string[], id: string | null, kind: "status" | "category"): Promise<any>;
  saveConfig(config: unknown, revision: string): Promise<any>;
  report(counts: { rows: number; badges: number }): Promise<boolean>;
  openConfig(): Promise<boolean>;
  vocabularyRead(): Promise<VocabSnapshot>;
  onVocabularyChanged(callback: () => void): () => void;
  vocabularySummarize(input: { term: string; context?: string; source?: unknown }): Promise<VocabEntry>;
  vocabularyReanalyze(id: string, revision: string): Promise<VocabRevisionDraft>;
  vocabularyFollowup(id: string, question: string, revision: string): Promise<VocabRevisionDraft>;
  vocabularyParagraph(id: string, paragraph: import('../dist/node/backend-types.cjs').VocabParagraphInput, revision: string): Promise<VocabRevisionDraft>;
  vocabularyCancel(): Promise<boolean>;
  vocabularySave(id: string, revision: string, options?: unknown): Promise<VocabSnapshot>;
  vocabularyEdit(id: string, patch: unknown, revision: string): Promise<VocabSnapshot>;
  vocabularyDelete(id: string, revision: string): Promise<VocabSnapshot>;
  vocabularyModels?(): Promise<VocabModel[]>;
  vocabularyModel?(): Promise<VocabModelChoice>;
  vocabularySetModel?(model: string, effort: ReasoningEffort): Promise<VocabModelChoice>;
  vocabularySetFast?(fast: boolean): Promise<VocabModelChoice>;
  vocabularyGuide?(): Promise<VocabGuide>;
  vocabularySetGuide?(text: string | null): Promise<VocabGuide>;
  /** Mica 로 이 문맥의 뜻 판단 (확신 낮거나 Mica 꺼짐이면 null) */
  vocabularyJudge?(input: { term: string; context?: string }): Promise<{ choice: string | "new"; confidence: number; via: string } | null>;
  /** 마우스 카드용: 이 문맥에 가까운 순서의 뜻 id (Mica 를 못 쓰면 null) */
  vocabularySenseRank?(term: string, context: string): Promise<string[] | null>;
  /** 저장된 뜻이 이 문맥에서 어떻게 쓰였는지 GPT 로 한 문장 */
  vocabularyUsage?(input: { term: string; context?: string }, entryId: string): Promise<string>;
  /** 라벨 없는 대화들(uuid)의 분류 라벨 추천 — 확신 높은 것만 { uuid: {labelId, confidence} } */
  labelSuggest?(threadIds: string[], titles?: Record<string, string | ThreadDigest>): Promise<Record<string, { labelId: string; confidence: number }>>;
  /** 끝난 대화들(uuid)의 답 필요·막힘 표시 — 자동 분류 확신 0.9 이상만 */
  /** 다른 호스트(클라우드) 대화를 Codex 화면 통로로 읽어 요약 (읽기 전용) */
  threadDigest?(hostId: string, threadId: string): Promise<ThreadDigest>;
  threadStatus?(threadIds: string[], digests?: Record<string, ThreadDigest>): Promise<Record<string, { state: 'ask' | 'blocked'; confidence: number }>>;
  /** 메모가 연결된 대화들이 아직 있는지: 있음·보관됨·없음·확인 못 함 */
  threadStates?(threadIds: string[]): Promise<Record<string, 'ok' | 'archived' | 'missing' | 'unknown'>>;
  taskPetSuggest?(options?: {currentThreadId?: string; dismissedIds?: string[]}): Promise<TaskPetResult>;
  /** 저장된 미분류 메모는 도우미가 결과를 기록한다. */
  memoClassify?(memo: Partial<Memo>): Promise<{category: MemoCategory; confidence: number} | null>;
  classifierGet?(): Promise<{mode: string; available: boolean; jevKey: boolean}>;
  /** 직접 고를 때 보여 줄 분류별 확률 (기준과 상관없이). 분류기를 못 쓰면 null */
  memoScores?(memo: Partial<Memo>): Promise<Record<string, number> | null>;
  labelScores?(threadId: string, title?: string | ThreadDigest): Promise<Record<string, number> | null>;
  /** 자동 판단 설정: 분류기 상태 + 기준 확신 */
  autoSettings?(): Promise<{mode: string; available: boolean; jevKey: boolean; thresholds: AutoThresholds; defaults: AutoThresholds}>;
  thresholdsSet?(patch: Partial<AutoThresholds>): Promise<AutoThresholds>;
  /** 기억한 자동 판단을 모두 버린다 */
  autoRefresh?(): Promise<boolean>;
}

interface TaskPetResult {
  limit?: number;
  status: 'ok' | 'empty' | 'unavailable' | 'source_error';
  checkedAt: string;
  totalCandidates: number;
  message?: string;
  /** Mica·대화 읽기 실패처럼 판단 범위가 줄었을 때의 안내 */
  notice?: string;
  items: {id: string; threadId: string; title: string; state: string; badge: string; action: string; quote: string;
    quoteKind: '' | 'agent' | 'request' | 'memo'; labelName: string; updatedAt: number; confidence?: number; adviceModel?: string; adviceEffort?: string}[];
}

// ---------------------------------------------------------------- 화면 스크립트 사이의 연결
/** inject.js 가 window.__codexMemo 로 여는 메모 기능 */
interface CodexMemoApi {
  version: number;
  destroy(): void;
  setMemos(list: Memo[]): void;
  readonly count: number;
  readonly marks: number;
  /** 테스트용: 본문 색인 (글자, 글자마다 노드 번호·위치) */
  indexDump(): { text: string; n: number[]; o: number[]; nodes: number };
  bench(times?: number): number;
  list(): Memo[];
  subscribe(fn: (memos: Memo[]) => void): () => void;
  takeVocabDraft(): MemoDraft | null;
  /** 화면 좌표 글자 위에 칠해진 메모들과 그 글자 상자 (마우스 올림 카드·클릭에서 사용) */
  memosAt(x: number, y: number): { memos: Memo[]; rect: DOMRect | null };
  /** 메모 위치로 이동: 지금 화면에서 그 메모가 칠해진 첫 범위 (없으면 null) */
  rangeOf(id: string): Range | null;
  add(draft: MemoDraft | null, note: string): void;
  update(id: string, note?: string, category?: MemoCategory | ""): void;
  remove(id: string): void;
}

/** vendor/vocabulary-renderer.js 의 단어장 창 상태 (memo-vocab.js 가 쓰는 부분만) */
interface VocabDialogState {
  dialog: HTMLDialogElement;
  mode?: "compose" | "archive" | "detail";
  save: HTMLButtonElement;
  saved: VocabEntry | null;
  snapshot: VocabSnapshot | null;
  list: HTMLElement;
  count?: HTMLElement;
  search?: HTMLInputElement;
  favorites?: HTMLInputElement;
  statusFilter?: HTMLSelectElement;
  newSense?: boolean;          // 저장된 뜻들과 다른 새 의미로 판단된 요약
}

interface VocabDialogTools {
  message(text: string, isError?: boolean): void;
  controls(): void;
  drawList(): void;
  showArchive(kind?: "all" | "word" | "memo"): void;
  showCompose(): void;
}

/** vendor/vocabulary-renderer.js 가 부르는 연결 지점 (labels/memo-vocab.js 가 채움) */
interface VocabHooks {
  version: number;
  destroy(): void | boolean;
  buttonLabel(exists: boolean): string;
  saveLabel(s: VocabDialogState): string | null;
  opened(s: VocabDialogState, tools: VocabDialogTools): void;
  saved(s: VocabDialogState, item?: VocabEntry): void;
  closed(s: VocabDialogState): void;
  drawList(s: VocabDialogState, q: string): void;
  viewChanged?(s: VocabDialogState, mode: "compose" | "archive" | "detail"): void;
  hasUnsaved?(s: VocabDialogState): boolean;
  libraryKind?(s: VocabDialogState, kind: "all" | "word" | "memo"): void;
  /** 이 문맥에서의 쓰임 (빈 글이면 지움). item 이 있으면 저장된 그 뜻과 같다고 판단된 경우 */
  usage(s: VocabDialogState, text: string, item: VocabEntry | null, info?: { via: "mica"; confidence: number } | null): void;
}

interface CxlBridge extends Responder {
  reset(): void;
  emit(name: "changed" | "vocabulary-changed"): void;
}

interface Window {
  CodexVocabContent?: VocabContent;
  __codexMemoBridge?: (json: string) => void;   // CDP Runtime.addBinding 이 만드는 함수
  __codexMemo?: CodexMemoApi;
  codexLabels?: CodexLabelsApi;
  __cxlBridge?: CxlBridge;
  __cxmPicker?: Responder;
  __cxmVocabHooks?: VocabHooks;
  __cxmModelPicker?: number;
  __cxmHover?: { version: number; destroy(): void };
  __cxmSuggest?: { version: number; destroy(): void };   // labels/label-suggest.js   // labels/hover-card.js
  __cxmThreadStatus?: { version: number; destroy(): void };   // labels/thread-status.js
  __cxmOpenLibrary?: (kind?: "all" | "word" | "memo") => void;   // labels/memo-vocab.js
  __codexLabelsInstalled?: boolean;
  __codexVocabularyInstalled?: boolean;
}
