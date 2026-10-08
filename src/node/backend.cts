import {randomUUID} from 'node:crypto';
import type {AutoThresholds, KnownSense, LegacyModules, Mica, SummaryHome, SummaryOptions, SummaryServer, SheetsModule, ThreadCatalogEntry, LastTurn, VocabModel, VocabModelChoice, VocabularyModule} from './backend-types.cjs';
import {createDispatcher, errorMessage, isEffort, isMethodName, isRecord} from './protocol.cjs';
import type {BackendHandlers} from './protocol.cjs';
// Codex Labels 의 라벨·단어장 저장/요약 코드를 공식 Codex 앱에서 쓰기 위한 Node 백엔드.
// codex_memo.py 가 실행하며, 표준 입출력으로 JSON 한 줄씩 주고받는다.
//   입력:  {"id": "<호출 ID>", "sender": "<화면 ID>", "method": "read", "args": [...]}
//   출력:  {"id": "...", "ok": true, "value": ...} | {"id": "...", "ok": false, "error": "..."}
//          {"event": "changed"} | {"event": "vocabulary-changed"}   (화면들에 알릴 변경 신호)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
const {createStore} = require('../../labels/vendor/store.cjs') as LegacyModules['store'];
const {createSnapshotCache} = require('../../labels/vendor/snapshot-cache.cjs') as LegacyModules['snapshotCache'];
const {createVocabularyStore, createSummarizer, loginEnvironment, EFFORTS, GUIDE, GUIDE_LIMIT} = require('../../labels/vendor/vocabulary.cjs') as VocabularyModule;
const {createSummaryServer} = require('../../labels/summary-server.cjs') as {createSummaryServer(options: {exe: () => string | null; env: NodeJS.ProcessEnv; home: SummaryHome}): SummaryServer};
const {createSummaryHome} = require('../../labels/summary-home.cjs') as {createSummaryHome(options: {source: string; dir: string}): SummaryHome};
const {createSheetSync, vocabRow, memoRow} = require('../../labels/sheets.cjs') as SheetsModule;
import {withServer, createServerPool} from './appserver.cjs';
import {createBackup} from './backup.cjs';
import {createSettingsStore} from './settings-store.cjs';
import {createSubscriptionUsage} from './subscription-usage.cjs';
import {createVocabularyService} from './vocabulary-service.cjs';
import {createCodexFinder} from './codex-executable.cjs';
import {createWebchatSummaryServer, vocabularySummaryServer, WEBCHAT_MODEL} from './webchat-summary-server.cjs';
const {createLabelSuggester} = require('../../labels/label-suggest.cjs') as LegacyModules['labelSuggester'];
const {createThreadStatus} = require('../../labels/thread-status.cjs') as LegacyModules['threadStatus'];
const {createThreadStates} = require('../../labels/thread-state.cjs') as LegacyModules['threadStates'];
const {createTaskPet} = require('../../labels/task-pet.cjs') as LegacyModules['taskPet'];
const {withAliases,assignWithAliases,assignManyWithAliases} = require('../../labels/assignment-aliases.cjs') as LegacyModules['assignmentAliases'];
const {assignmentKind} = require('../../labels/vendor/label-kind.cjs') as LegacyModules['labelKind'];
const mica = require('../../labels/mica.cjs') as Mica;
const {classifyMemo, memoScores, clearMemoCache} = require('../../labels/memo-classify.cjs') as LegacyModules['memoClassify'];

const directory = process.env.CODEX_LABELS_DIR;
if (!directory || !fs.existsSync(path.join(directory, 'labels.json'))) {
  process.stderr.write(`labels.json 을 찾지 못했습니다: ${directory}\n`);
  process.exit(2);
}

const findCodex = createCodexFinder();

const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const emit = (event: 'changed' | 'vocabulary-changed') => out({event});

// ---------------------------------------------------------------- 라벨
const store = createStore(directory);
const cache = createSnapshotCache(store, directory, {onChange: () => emit('changed')});

// ---------------------------------------------------------------- 단어장
const vocabulary = createVocabularyStore(directory);
const APP_LABELS_DIR = path.resolve(__dirname, '../../labels');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
// 요약은 App Server 연결을 재사용하고(빠름), 연결이 안 될 때만 codex exec 를 띄운다
// 요약 전용 CODEX_HOME: 원래 폴더의 AGENTS.md·config.toml(MCP 등)이 요약에 들어가지 않게 로그인 파일만 둔다
const summaryHome = createSummaryHome({source: CODEX_HOME, dir: path.join(process.env.CODEX_MEMO_DATA || APP_LABELS_DIR, 'summary-codex-home')});
const summaryServer = createSummaryServer({exe: findCodex, env: loginEnvironment(process.env, CODEX_HOME), home: summaryHome});
// ---------------------------------------------------------------- 개인 설정 (labels/settings.json)
// 단어장 모델, Google 시트 연결 정보. 도우미가 알려 준 개인 데이터 폴더(CODEX_MEMO_DATA)에 둔다.
const DATA_DIR = process.env.CODEX_MEMO_DATA || APP_LABELS_DIR;
const settingsStore = createSettingsStore(path.join(DATA_DIR, 'settings.json'));
const readSettings = settingsStore.read;
const saveSettings = settingsStore.update;
const subscriptionUsage = createSubscriptionUsage({exe: findCodex, settings: readSettings, saveSettings});
const {createPetModel} = require('../../labels/pet-model.cjs') as LegacyModules['petModel'];
const petModel = createPetModel({server: summaryServer, settings: readSettings, saveSettings});

// 분류기 선택 (mica 로컬 / jev 클라우드 / both 둘 다). 트레이 메뉴에서 바꾼다.
try { mica.setMode(String(readSettings().classifier || 'mica')); } catch { /* 예전 값이면 기본(mica) */ }
const classifierInfo = async () => ({mode: mica.getMode(), available: await mica.available(), jevKey: Boolean(process.env.JEV_API_KEY)});

// 자동 판단 기준 확신 (단어장 창의 슬라이더). 판단 결과는 확률 그대로 기억하므로 바꾸면 바로 반영된다.
const DEFAULT_THRESHOLDS: AutoThresholds = {label: 0.6, status: 0.9, memo: 0.6, sense: 0.8};   // 라벨: 실측 0.8 이면 라벨 없는 14개 중 추천 0개, 0.6 이면 6개(대부분 맞음)
const clampThreshold = (v: unknown) => Math.round(Math.min(0.99, Math.max(0.3, Number(v))) * 100) / 100;
const thresholdKeys = ['label', 'status', 'memo', 'sense'] as const;
function loadThresholds(): AutoThresholds {
  const value = readSettings().thresholds;
  const saved = isRecord(value) ? value : {};
  const result = {...DEFAULT_THRESHOLDS};
  for (const key of thresholdKeys) {
    if (saved[key] != null && Number.isFinite(Number(saved[key]))) result[key] = clampThreshold(saved[key]);
  }
  return result;
}
let thresholds = loadThresholds();
function setThresholds(patch: Partial<AutoThresholds>): AutoThresholds {
  const next = {...thresholds};
  for (const key of thresholdKeys) if (patch[key] != null && Number.isFinite(Number(patch[key]))) next[key] = clampThreshold(patch[key]);
  saveSettings({thresholds: next});
  thresholds = next;
  return thresholds;
}

// ---------------------------------------------------------------- 단어장 요약 설정 (모델 · FAST · 작성 지침)
// FAST 는 Codex 의 Fast(service_tier "priority": 2배 빠름, 사용량 증가). 기본으로 켜고, 모델이 지원할 때만 쓴다.
const DEFAULT_MODEL: VocabModelChoice = {model: 'gpt-6-luna', effort: 'high', fast: true};  // 단어장 기본 모델
function loadModel(): VocabModelChoice {
  const v = readSettings().vocabularyModel;
  if (!isRecord(v) || typeof v.model !== 'string' || !isEffort(v.effort)) return {...DEFAULT_MODEL};
  return {model: v.model, effort: v.effort, fast: typeof v.fast === 'boolean' ? v.fast : DEFAULT_MODEL.fast};
}
let currentModel = loadModel();
/** 설정창에서 바꾼 작성 지침 (없으면 기본 지침) */
const loadGuide = () => { const g = readSettings().vocabularyGuide; return typeof g === 'string' && g.trim() ? g : ''; };
let customGuide = loadGuide();

// 지금 로그인한 계정에서 쓸 수 있는 모델 목록 (codex app-server 의 model/list, 10분 캐시)
let modelCache: VocabModel[] | null = null, modelCacheAt = 0, modelLoading: Promise<VocabModel[]> | null = null;
function fetchModels() {
  const exe = findCodex();
  if (!exe) return Promise.reject(Error('Codex 실행 파일을 찾지 못했습니다.'));
  return withServer(exe, async request => {
    const response: unknown = await request('model/list', {});
    const data = isRecord(response) && Array.isArray(response.data) ? response.data : [];
    const result: VocabModel[] = [];
    for (const value of data) {
      if (!isRecord(value) || value.hidden) continue;
      const id = typeof value.id === 'string' ? value.id : typeof value.model === 'string' ? value.model : '';
      const efforts = (Array.isArray(value.supportedReasoningEfforts) ? value.supportedReasoningEfforts : [])
        .map((item: unknown) => isRecord(item) ? item.reasoningEffort : item).filter(isEffort);
      if (!id || !efforts.length) continue;
      result.push({id, name: typeof value.displayName === 'string' ? value.displayName : id, efforts,
        defaultEffort: isEffort(value.defaultReasoningEffort) ? value.defaultReasoningEffort : undefined,
        fast: Array.isArray(value.serviceTiers) && value.serviceTiers.some((tier: unknown) => isRecord(tier) && tier.id === 'priority')});
    }
    return result;
  }, 20000).catch(() => { throw Error('모델 목록을 받아오지 못했습니다.'); });
}
/** 웹챗 경로가 설정돼 있으면 Codex 목록을 못 받아도 웹챗 모델 하나로 목록을 만든다 */
function models() {
  if (modelCache && Date.now() - modelCacheAt < 10 * 60 * 1000) return Promise.resolve(modelCache);
  const webChat = isRecord(readSettings().vocabularyWebChat);
  return modelLoading ||= fetchModels()
    .catch(error => { if (!webChat) throw error; return []; })
    .then(list => {
      modelCache = webChat ? [{...WEBCHAT_MODEL, efforts: [...WEBCHAT_MODEL.efforts]}, ...list] : list;
      modelCacheAt = Date.now();
      return modelCache;
    })
    .finally(() => { modelLoading = null; });
}
const usingWebChat = (model = currentModel.model) => model === WEBCHAT_MODEL.id;
/** 저장에 성공했을 때만 현재 값을 바꾼다 */
function commitModel(next: VocabModelChoice) {
  saveSettings({vocabularyModel: next});
  currentModel = next;
  return currentModel;
}
async function setModel(model: string, effort: VocabModelChoice['effort']) {
  const list = await models().catch(() => null);
  if (list) {
    const m = list.find(x => x.id === model);
    if (!m) throw Error('지금 계정에서 쓸 수 없는 모델입니다.');
    if (!m.efforts.includes(effort)) throw Error(`${m.name} 은(는) ${effort} 추론 강도를 지원하지 않습니다.`);
  } else if (!EFFORTS.includes(effort)) throw Error('추론 강도를 확인하세요.');
  return commitModel({...currentModel, model, effort, fast: usingWebChat(model) ? false : currentModel.fast});
}
function setFast(fast: boolean) {
  if (typeof fast !== 'boolean') throw Error('FAST 설정을 확인하세요.');
  return commitModel({...currentModel, fast: usingWebChat() ? false : fast});
}
/** 요약에 넘길 옵션. FAST 를 지원하지 않는 모델이면(목록을 아는 경우) 끈다 */
function summaryOptions(known: KnownSense[]): SummaryOptions {
  const info = modelCache?.find(x => x.id === currentModel.model);
  return {model: currentModel.model, effort: currentModel.effort, fast: currentModel.fast && info?.fast !== false, guide: customGuide, known};
}
const guideInfo = () => ({guide: customGuide || GUIDE, defaultGuide: GUIDE, custom: Boolean(customGuide), limit: GUIDE_LIMIT});
/** 빈 값·null 이면 기본 지침으로 되돌린다 */
function setGuide(text: string | null | undefined) {
  if (text != null && typeof text !== 'string') throw Error('작성 지침을 확인하세요.');
  const value = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (value.length > GUIDE_LIMIT) throw Error(`작성 지침은 ${GUIDE_LIMIT}자까지 쓸 수 있습니다.`);
  const next = value === GUIDE ? '' : value;
  saveSettings({vocabularyGuide: next || undefined});
  customGuide = next;
  return guideInfo();
}

// ---------------------------------------------------------------- 대화 라벨 추천 (분류 라벨, Mica)
const serverPool = createServerPool(findCodex);   // thread/list·thread/read 연결 재사용
const threadStates = createThreadStates({server: serverPool});   // 메모가 연결된 대화가 아직 있는지
const suggester = createLabelSuggester({server: serverPool, mica, snapshot: () => store.snapshot(), threshold: () => thresholds.label});
const threadStatus = createThreadStatus({server: serverPool, mica, threshold: () => thresholds.status});
const webchatServer = createWebchatSummaryServer({worker: path.join(APP_LABELS_DIR, 'webchat-mcp.cjs'), config() {
  const value = readSettings().vocabularyWebChat;
  if (!isRecord(value) || typeof value.endpoint !== 'string' || typeof value.playwrightModule !== 'string') throw Error('웹챗 MCP 연결 설정을 확인하세요.');
  return {endpoint: value.endpoint, playwrightModule: value.playwrightModule};
}});
const vocabularyServer = vocabularySummaryServer(summaryServer, webchatServer);
const summarizer = createSummarizer({executable: findCodex, home: CODEX_HOME, homeLease: summaryHome, server: vocabularyServer});
const vocabService = createVocabularyService({store: vocabulary, summarizer, server: vocabularyServer, mica, options: summaryOptions});
const {knownSenses, clearRanks} = vocabService;
const clearPredictions = () => { clearRanks(); suggester.clear(); threadStatus.clear(); clearMemoCache(); };

/** Fresh local catalog; a bounded recheck stops as soon as all requested IDs are found.
 * @param {number} [max]
 * @param {string[]} [threadIds]
 */
async function readThreadCatalog(max = 500, threadIds?: string[]): Promise<ThreadCatalogEntry[]> {
  const wanted = Array.isArray(threadIds) ? new Set(threadIds) : null;
  if (wanted && !wanted.size) return [];
  return serverPool.run(async request => {
    const list: ThreadCatalogEntry[] = [];
    let cursor: string | null = null, scanned = 0;
    for (let page = 0; page < 10 && scanned < (Number(max) || 500); page++) {
      const response: unknown = await request('thread/list', {limit: 100, ...(cursor ? {cursor} : {})});
      if (!isRecord(response) || !Array.isArray(response.data)) throw Error('대화 목록을 읽을 수 없습니다.');
      for (const thread of response.data) {
        scanned++;
        if (!isRecord(thread) || typeof thread.id !== 'string') continue;
        if (!wanted || wanted.delete(String(thread.id).replace(/^local:/, '').toLowerCase())) {
          list.push(catalogEntry(thread));
        }
      }
      cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
      if (!cursor || (wanted && !wanted.size)) break;
    }
    return list;
  });
}

function catalogEntry(thread: Record<string, unknown>): ThreadCatalogEntry {
  return {id: String(thread.id),
    name: typeof thread.name === 'string' ? thread.name : typeof thread.preview === 'string' ? thread.preview : '',
    cwd: typeof thread.cwd === 'string' ? thread.cwd : '', updatedAt: Number(thread.updatedAt) || 0};
}

/** Pet sources: the given conversations by ID, plus those updated since `since` (seconds), newest first.
 * thread/list slows down with every listed conversation (about 45 ms each), so only the recent part is listed
 * and labeled or memo-linked conversations are read directly by ID. Missing or archived conversations are omitted. */
async function readPetThreads(threadIds: string[], since?: number): Promise<ThreadCatalogEntry[]> {
  const ids = [...new Set((Array.isArray(threadIds) ? threadIds : []).map(id => String(id).replace(/^local:/, '').toLowerCase()))].slice(0, 200);
  if (!ids.length && since === undefined) return [];
  return serverPool.run(async request => {
    const list: ThreadCatalogEntry[] = [];
    const seen = new Set<string>();
    const add = (thread: Record<string, unknown>) => {
      const id = String(thread.id).replace(/^local:/, '').toLowerCase();
      if (!seen.has(id)) { seen.add(id); list.push(catalogEntry(thread)); }
    };
    if (since !== undefined) {
      let cursor: string | null = null;
      for (let page = 0; page < 8; page++) {
        const response: unknown = await request('thread/list', {limit: 25, sortKey: 'updated_at', ...(cursor ? {cursor} : {})});
        if (!isRecord(response) || !Array.isArray(response.data)) throw Error('대화 목록을 읽을 수 없습니다.');
        let older = false;
        for (const thread of response.data) {
          if (!isRecord(thread) || typeof thread.id !== 'string') continue;
          if ((Number(thread.updatedAt) || 0) < since) older = true;
          else add(thread);
        }
        cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
        if (older || !cursor) break;
      }
    }
    for (const id of ids) {
      if (seen.has(id)) continue;
      let response: unknown;
      try { response = await request('thread/read', {threadId: id, includeTurns: false}); }
      catch (error) {
        // 지워진 대화는 없는 것으로 본다. 연결 문제는 알려서 빈 추천과 구별한다.
        if (/not (?:loaded|found)/i.test(errorMessage(error))) continue;
        throw error;
      }
      const thread = isRecord(response) && isRecord(response.thread) ? response.thread : null;
      // 보관한 대화는 목록에 나오지 않으므로 추천하지 않는다.
      if (!thread || typeof thread.id !== 'string' || /[\\/]archived_sessions[\\/]/i.test(String(thread.path ?? ''))) continue;
      add(thread);
    }
    return list;
  });
}

/** Newest turn per thread in the summary view (last user request + final answer). Unreadable threads are omitted. */
async function readLastTurns(threadIds: string[]): Promise<Record<string, LastTurn>> {
  const ids = [...new Set(Array.isArray(threadIds) ? threadIds.map(String) : [])].slice(0, 40);
  if (!ids.length) return {};
  const itemText = (item: unknown): string => !isRecord(item) ? ''
    : typeof item.text === 'string' ? item.text
      : Array.isArray(item.content) ? item.content.map(c => isRecord(c) && typeof c.text === 'string' ? c.text : '').join(' ') : '';
  return serverPool.run(async request => {
    const out: Record<string, LastTurn> = {};
    let failed = 0;
    for (const threadId of ids) {
      // 최신 턴 하나만 읽는다. thread/read 로 모든 턴을 읽으면 긴 대화는 수십 MB가 된다.
      let response: unknown;
      try { response = await request('thread/turns/list', {threadId, limit: 1}); } catch { failed++; continue; }
      const turn: unknown = isRecord(response) && Array.isArray(response.data) ? response.data[0] : undefined;
      if (!isRecord(turn)) continue;
      const items: unknown[] = Array.isArray(turn.items) ? turn.items : [];
      const last = (type: string) => items.filter(i => isRecord(i) && i.type === type).at(-1);
      const completedAt = turn.completedAt == null ? NaN : Number(turn.completedAt);
      out[threadId] = {
        status: typeof turn.status === 'string' ? turn.status : '',
        completedAt: Number.isFinite(completedAt) ? completedAt : null,
        agentText: itemText(last('agentMessage')).slice(-2000),
        userText: itemText(last('userMessage')).slice(0, 1000),
      };
    }
    // 모두 실패하면 연결 문제로 보고 알린다(연결 풀이 새 연결을 연다).
    if (failed && !Object.keys(out).length) throw Error('대화의 마지막 상태를 읽을 수 없습니다.');
    return out;
  });
}

// 펫은 저장된 상태·로컬 대화 목록·각 대화의 마지막 턴만 읽는다. 요청마다 새 목록을 받고 분류기는 Mica로 고정한다.
const taskPet = createTaskPet({
  mica,
  settings: petModel.read,
  advise: petModel.advise,
  getSnapshot: () => store.snapshot(),
  getThreads: (threadIds, since) => readPetThreads(threadIds, since),
  getLastTurns: readLastTurns,
  getMemos: async () => {
    const file = path.join(process.env.CODEX_MEMO_DATA || path.join(os.homedir(), 'AppData', 'Local', 'CodexMemo'), 'memos', 'memos.json');
    let text;
    try { text = await fs.promises.readFile(file, 'utf8'); }
    catch (error) { if (isRecord(error) && error.code === 'ENOENT') return []; throw error; }
    const memos: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!Array.isArray(memos)) throw Error('메모 목록을 읽을 수 없습니다.');
    return memos;
  },
});

// ---------------------------------------------------------------- Google 시트 (단어·메모 표)
const sheets = createSheetSync({exe: findCodex, settings: readSettings, saveSettings});
const backup = createBackup({exe: findCodex, directory, dataDir: DATA_DIR, settings: readSettings, saveSettings,
  replaceSettings: settingsStore.replace,
  onRestore: () => {
    settingsStore.invalidate();
    cache.invalidate(); cache.snapshot(); vocabulary.read(); currentModel = loadModel(); customGuide = loadGuide(); thresholds = loadThresholds();
    try { mica.setMode(String(readSettings().classifier || 'mica')); } catch {}
    vocabService.reset(); clearPredictions();
    emit('changed'); vocabularyChanged();
  },
});
let vocabTimer: ReturnType<typeof setTimeout> | undefined;
const vocabularyChanged = () => {
  clearRanks();
  clearTimeout(vocabTimer);
  vocabTimer = setTimeout(() => emit('vocabulary-changed'), 40);
};
try {
  fs.watch(directory, {persistent: false}, (_event, name) => {
    if (name == null || String(name) === 'vocabulary.json') vocabularyChanged();
  });
} catch { /* 감시 실패 시 화면 포커스 복귀 때 다시 읽는다 */ }

// 대화 라벨 열쇠는 'thread:<host>:<kind>:<대화 ID>' 꼴이다. host 는 Codex 버전·실행 환경에 따라
// local, durable, remote-ssh-discovered:codex-runner-a1 처럼 바뀌므로(그 자체에 ':' 가 들어가기도 함),
// 화면(vendor/renderer.js)은 항상 host=local 로 묻고, 여기서는 저장된 열쇠를 host 와 상관없이 같은 대화로 묶는다.
const methods: BackendHandlers = {
  subscriptionUsage: (_sender, force) => subscriptionUsage.read(force),
  subscriptionFeeSet: (_sender, feeKrw) => subscriptionUsage.setFee(feeKrw),
  // 라벨
  read: (_sender, knownVersion) => withAliases(cache.snapshot(knownVersion ?? undefined)),
  assign: (_sender, key, id, kind) => {
    const next = assignWithAliases(store,key,id,kind);
    if ((kind === undefined ? (id === null ? 'status' : assignmentKind(next.config,id)) : kind) === 'category') suggester.clear();
    return withAliases(cache.update(next));
  },
  // [codex-memo 추가] 여러 대화에 같은 진행 상태·카테고리를 한 번에 지정 (id=null 이면 해제)
  assignMany: (_sender, keys, id, kind) => {
    const next = assignManyWithAliases(store,keys,id,kind);
    if (kind === 'category') suggester.clear();
    return withAliases(cache.update(next));
  },
  saveConfig: (_sender, draft, revision) => {
    const next = store.saveConfig(draft,revision);
    suggester.clear();
    return withAliases(cache.update(next));
  },
  report: () => true,
  openConfig: () => {
    spawn(process.platform === 'darwin' ? '/usr/bin/open' : 'explorer.exe', [store.configPath], {detached: true, stdio: 'ignore', windowsHide: false}).unref();
    return true;
  },
  // 단어장
  vocabularyRead: () => vocabulary.read(),
  vocabularySummarize: vocabService.summarize,
  vocabularyReanalyze: vocabService.reanalyze,
  vocabularyFollowup: vocabService.followup,
  vocabularyParagraph: vocabService.paragraph,
  vocabularyCancel: vocabService.cancel,
  vocabularySave(sender, draftId, revision, options) {
    const snapshot = vocabService.save(sender, draftId, revision, options);
    const saved = snapshot.entries.find(entry => entry.id === draftId);
    if (saved) sheets.enqueue(vocabRow(saved));
    vocabularyChanged();
    return snapshot;
  },
  // Mica 로 이 문맥의 뜻 판단 (확신 0.8 이상일 때만, 아니면 null → 화면이 GPT 로 판단)
  vocabularyJudge: (_sender, input) => usingWebChat() ? null : mica.judgeSense(String(input?.term || ''), String(input?.context || ''), knownSenses(input?.term), thresholds.sense),

  // 같은 단어·문단의 진행 중인 순위 요청도 함께 사용한다.
  vocabularySenseRank: (_sender, term, context) => usingWebChat() ? knownSenses(term).map(sense => sense.id) : vocabService.rank(term, context),
  vocabularyUsage: vocabService.usage,

  // 라벨 없는 대화들의 분류 라벨 추천 (확신 0.8 이상만, Mica 가 꺼져 있으면 빈 결과)
  labelSuggest: (_sender, threadIds, titles) => suggester.suggest(Array.isArray(threadIds) ? threadIds.map(String) : [], titles && typeof titles === 'object' ? titles : {}),

  // 사용자 답이 필요한 대화·막힌 대화 (자동 분류 확신 0.9 이상만)
  threadStatus: (_sender, threadIds, digests) => threadStatus.status(Array.isArray(threadIds) ? threadIds.map(String) : [], digests && typeof digests === 'object' ? digests : {}),
  // 메모 위치로 이동: 연결된 대화들이 있음·보관됨·없음 중 어느 것인지
  threadStates: (_sender, threadIds) => threadStates.states(threadIds),
  taskPetSuggest: (_sender, options) => taskPet.suggest(options || {}),
  taskPetSettings: () => petModel.read(),
  taskPetSettingsSet: async (_sender, patch) => {
    const previous = petModel.read();
    if ((patch.model !== undefined && patch.model !== previous.model) || (patch.effort !== undefined && patch.effort !== previous.effort)) {
      const next = {...previous, ...patch};
      const list = await models();
      const model = list.find(m => m.id === next.model);
      if (!model || !isEffort(next.effort) || !model.efforts.includes(next.effort)) throw Error('현재 모델 목록에서 모델·추론 강도를 확인할 수 없습니다.');
    }
    const next = petModel.save(patch);
    emit('changed');
    return next;
  },

  // 분류기 선택 상태와 바꾸기 (도우미 트레이 메뉴)
  classifierGet: () => classifierInfo(),
  memoClassify: (_sender, memo) => classifyMemo(memo, thresholds.memo),
  // 직접 고를 때 보여 줄 선택지별 확률 (기준과 상관없이)
  memoScores: (_sender, memo) => memoScores(memo),
  labelScores: (_sender, threadId, title) => suggester.scores(String(threadId || ''), title || ''),
  // 자동 판단 설정 (단어장 창): 분류기 상태 + 기준 확신
  autoSettings: async () => ({...(await classifierInfo()), thresholds, defaults: DEFAULT_THRESHOLDS}),
  thresholdsSet: (_sender, patch) => setThresholds(patch),
  // 새로 고침: 기억한 판단을 모두 버린다 (화면은 이어서 다시 묻는다)
  autoRefresh: () => { clearPredictions(); return true; },
  classifierSet: (_sender, mode) => {
    const previous = mica.getMode();
    mica.setMode(String(mode));
    try { saveSettings({classifier: mica.getMode()}); }
    catch (error) { mica.setMode(previous); throw error; }
    clearPredictions();
    return classifierInfo();
  },

  vocabularyModels: () => models(),
  vocabularyModel: () => currentModel,
  vocabularySetModel: (_sender, model, effort) => setModel(model, effort),
  vocabularySetFast: (_sender, fast) => setFast(fast),
  vocabularyGuide: () => guideInfo(),
  vocabularySetGuide: (_sender, text) => setGuide(text),
  vocabularyEdit: (_sender, id, patch, revision) => { const s = vocabulary.edit(id, patch, revision); vocabularyChanged(); return s; },
  vocabularyDelete: (_sender, id, revision) => { const s = vocabulary.remove(id, revision); vocabularyChanged(); return s; },
  // [codex-memo 추가] Codex 대화의 모델이 직접 관리할 때(memo-mcp): 뜻을 모델이 써서 바로 저장, 삭제 되돌리기
  vocabularyAdd: (_sender, input) => {
    const id = randomUUID(), now = Date.now();
    const draft = {id, term: input?.term, context: input?.context ?? '', source: {title: String(input?.sourceTitle ?? 'Codex 대화').slice(0, 200), path: ''},
      meaning: input?.meaning, example: input?.example ?? '', partOfSpeech: input?.partOfSpeech ?? '', explanation: input?.explanation ?? '',
      tags: input?.tags ?? [], model: currentModel.model, effort: currentModel.effort, savedAt: now};
    const s = vocabulary.save(draft, vocabulary.read().revision, {mode: 'add'});
    vocabularyChanged();
    const saved = s.entries.find(e => e.id === id);
    if (saved) sheets.enqueue(vocabRow(saved));
    return saved;
  },
  vocabularyRestore: (_sender, entry) => {
    const s = vocabulary.save(entry, vocabulary.read().revision, {mode: 'add'});
    vocabularyChanged();
    return s.entries.find(e => e.id === entry?.id) || null;
  },
  // [codex-memo 추가] 이 PC 의 대화 목록(제목·작업 폴더·수정 시각)
  threadCatalog: (_sender, max) => readThreadCatalog(max),
  // 화면이 닫히거나 새로 고쳐지면 그 화면의 요약/초안을 정리
  // Google 시트: 도우미(Python)가 메모를 넘겨준다
  backupStatus: () => backup.status(),
  backupCreate: () => backup.create(),
  backupList: (_sender, force = false) => backup.list(force),
  backupRestore: (_sender, pageId) => backup.restore(pageId),
  backupConfigure: (_sender, enabled) => backup.configure(enabled),
  sheetsStatus: () => sheets.status(),
  sheetsConnect: (_sender, memos) => sheets.connect([
    ...vocabulary.read().entries.map(vocabRow),
    ...(Array.isArray(memos) ? memos : []).map(memoRow),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)))),
  sheetsAppendMemo: (_sender, memo) => { sheets.enqueue(memoRow(memo)); return true; },
  dispose: vocabService.cancel,
};

const {dispatch} = createDispatcher(methods);
readline.createInterface({input: process.stdin}).on('line', async (line: string) => {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return; }
  if (!isRecord(message)) return;
  const id = message.id;
  try {
    if (typeof message.method !== 'string' || !isMethodName(message.method)) throw Error(`지원하지 않는 기능입니다: ${String(message.method)}`);
    if (message.args != null && !Array.isArray(message.args)) throw Error('호출 인자 목록을 확인하세요.');
    const value = await dispatch(message.method, String(message.sender || ''), message.args || []);
    out({id, ok: true, value: value === undefined ? null : value});
  } catch (error) {
    out({id, ok: false, error: errorMessage(error)});
  }
}).on('close', () => { vocabService.dispose(); sheets.dispose(); backup.dispose(); serverPool.close(); cache.close(); process.exit(0); });
process.on('exit', () => { vocabService.dispose(); sheets.dispose(); backup.dispose(); serverPool.close(); });
out({event: 'ready'});
