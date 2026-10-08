import type {KnownSense, Mica, Summarizer, SummaryOptions, SummaryServer, VocabDraft, VocabEntry, VocabInput, VocabParagraphInput, VocabRevisionDraft, VocabSaveOptions, VocabularyStore} from './backend-types.cjs';
import {followupQuestion, generateFollowup, revisionDraft} from './vocabulary-analysis.cjs';
const content=require('../../labels/vocabulary-content.js') as {paragraphs(entry: VocabEntry): Array<VocabParagraphInput & {label: string}>;replaceParagraph(entry: VocabEntry,paragraph: VocabParagraphInput,answer: string): Partial<VocabEntry>};

interface Options {
  store: VocabularyStore;
  summarizer: Summarizer;
  server: SummaryServer;
  mica: Pick<Mica, 'rankSenses'>;
  options(known: KnownSense[]): SummaryOptions;
}
interface Request {cancel?: () => void}
interface PendingDraft {value: VocabDraft | VocabRevisionDraft; createdAt: number}
const DRAFT_LIFETIME = 30 * 60 * 1000;
const RANK_LIMIT = 300;
const termKey = (value: unknown) => String(value || '').normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();

/** 단어장 생성·초안 수명과 뜻 조회를 한곳에서 관리한다. 저장 알림은 호출자가 보낸다. */
export function createVocabularyService({store, summarizer, server, mica, options}: Options) {
  const requests = new Map<string, Request>();
  const drafts = new Map<string, PendingDraft>();
  const index = new Map<string, KnownSense[]>();
  const ranks = new Map<string, string[]>();
  const ranking = new Map<string, Promise<string[] | null>>();
  let indexedRevision: string | undefined;
  let generation = 0;

  function clearRanks() {
    generation++;
    ranks.clear();
    ranking.clear();
  }

  function knownSenses(term: unknown): KnownSense[] {
    const snapshot = store.read();
    if (snapshot.revision !== indexedRevision) {
      index.clear();
      for (const entry of snapshot.entries) {
        const key = termKey(entry.term);
        let senses = index.get(key);
        if (!senses) index.set(key, senses = []);
        senses.push({id: entry.id, meaning: entry.meaning, partOfSpeech: entry.partOfSpeech || '', context: entry.context || ''});
      }
      indexedRevision = snapshot.revision;
      clearRanks();
    }
    return index.get(termKey(term)) || [];
  }

  function cancel(sender: string) {
    const request = requests.get(sender);
    requests.delete(sender);
    drafts.delete(sender);
    request?.cancel?.();
    summarizer.cancel(sender);
    summarizer.cancel(`${sender}:usage`);
    return true;
  }

  async function generate<T extends VocabDraft>(sender: string, work: (onStop: (stop: () => void) => void) => Promise<T>): Promise<T> {
    if (requests.has(sender)) throw Error('이미 단어장 내용을 생성하고 있습니다. 잠시 기다려 주세요.');
    const now = Date.now();
    for (const [owner, draft] of drafts) if (now - draft.createdAt > DRAFT_LIFETIME) drafts.delete(owner);
    const request: Request = {};
    requests.set(sender, request);
    drafts.delete(sender);
    try {
      const draft = await work(stop => {
        request.cancel = stop;
        if (requests.get(sender) !== request) stop();
      });
      if (requests.get(sender) !== request) throw Error('단어장 생성이 취소되었습니다.');
      drafts.set(sender, {value: draft, createdAt: Date.now()});
      return draft;
    } finally {
      if (requests.get(sender) === request) requests.delete(sender);
    }
  }

  function source(id: string, revision: string) {
    const snapshot = store.read();
    if (snapshot.revision !== revision) throw Error('다른 창에서 단어장이 변경되었습니다. 목록을 새로고침한 뒤 다시 시도하세요.');
    const original = snapshot.entries.find(entry => entry.id === id);
    if (!original) throw Error('저장된 단어를 찾지 못했습니다. 목록을 새로고침하세요.');
    return original;
  }

  function summarize(sender: string, input: VocabInput) {
    return generate(sender, () => summarizer.summarize(sender, input, options(input.judge === false ? [] : knownSenses(input.term))));
  }

  function reanalyze(sender: string, id: string, revision: string) {
    const original = source(id, revision);
    return generate(sender, async () => {
      const result = await summarizer.summarize(sender, {term: original.term, context: original.context, source: original.source, judge: false}, options([]));
      return revisionDraft(original, result, revision, 'reanalyze');
    });
  }

  function followup(sender: string, id: string, question: string, revision: string) {
    const original = source(id, revision);
    const nextQuestion = followupQuestion(original, question);
    return generate(sender, async onStop => {
      const answer = await generateFollowup(server, original, nextQuestion, options([]), onStop);
      return revisionDraft(original, {...original, followups: [...(original.followups || []), answer]}, revision, 'followup');
    });
  }

  function paragraph(sender: string,id: string,input: VocabParagraphInput,revision: string) {
    const original=source(id,revision);
    const targets=[...content.paragraphs(original),...(original.contextAnalyses||[]).map(c=>({kind:'context',text:c.analysis,recordId:c.id,label:'다른 문장 맥락분석'}))];
    const target=targets.find(p=>p.kind===input.kind&&p.text===input.text&&p.recordId===input.recordId);
    if(!target)throw Error('문단이 변경되었거나 삭제되었습니다. 목록을 새로고침하세요.');
    const limits:Record<string,number>={meaning:1600,partOfSpeech:80,explanation:800,example:600,definition:200,followup:6000,context:1600};
    const limit=limits[target.kind];if(!limit)throw Error('재분석할 문단 종류를 확인하세요.');
    return generate(sender,async onStop=>{
      const sentence=target.kind==='context'?original.contextAnalyses?.find(c=>c.id===target.recordId)?.context:original.context;
      const question='다음 '+target.label+' 문단 하나만 재분석해 대체할 문장만 답하세요. '+limit+'자 이내. 다른 항목은 바꾸지 마세요.\n'+JSON.stringify({sentence,text:target.text});
      const answer=await generateFollowup(server,original,question,options([]),onStop);
      if(answer.answer.length>limit)throw Error('재분석 문단이 너무 깁니다. 원본은 유지됩니다.');
      const patch=content.replaceParagraph(original,target,answer.answer);
      return {...revisionDraft(original,{...original,...patch},revision,'reanalyze'),...patch};
    });
  }

  function save(sender: string, id: string, revision: string, saveOptions?: VocabSaveOptions) {
    const pending = drafts.get(sender);
    if (pending && Date.now() - pending.createdAt > DRAFT_LIFETIME) drafts.delete(sender);
    if (!drafts.has(sender) || pending?.value.id !== id) throw Error('요약을 다시 확인한 뒤 저장하세요.');
    const draft = pending.value;
    const revising = 'targetId' in draft;
    if (revising && (revision !== draft.baseRevision || saveOptions?.mode !== 'replace' || saveOptions.targetId !== draft.targetId)) {
      throw Error('생성한 원본 단어와 버전을 확인한 뒤 다시 저장하세요.');
    }
    const snapshot = store.save(revising ? draft : {...draft, savedAt: Date.now()}, revision, saveOptions);
    drafts.delete(sender);
    return snapshot;
  }

  async function rank(term: string, context: string): Promise<string[] | null> {
    const senses = knownSenses(term);
    if (senses.length < 2) return senses.map(sense => sense.id);
    const key = JSON.stringify([termKey(term), String(context || '').slice(0, 1600)]);
    const cached = ranks.get(key);
    if (cached) return [...cached];
    const running = ranking.get(key);
    if (running) return running.then(order => order && [...order]);
    const started = generation;
    const pending = Promise.resolve().then(() => mica.rankSenses(term, context, senses)).then(result => {
      const order = result ? senses.map(sense => sense.id).sort((a, b) => (result.probabilities[b] || 0) - (result.probabilities[a] || 0)) : null;
      if (order && started === generation) {
        ranks.set(key, order);
        if (ranks.size > RANK_LIMIT) { const first = ranks.keys().next().value; if (first !== undefined) ranks.delete(first); }
      }
      return order;
    }).finally(() => { if (ranking.get(key) === pending) ranking.delete(key); });
    ranking.set(key, pending);
    return pending.then(order => order && [...order]);
  }

  async function usage(sender: string, input: VocabInput, entryId: string) {
    const sense = knownSenses(input.term).find(entry => entry.id === entryId);
    if (!sense) throw Error('저장된 뜻을 찾지 못했습니다.');
    return (await summarizer.summarize(`${sender}:usage`, input, options([sense]))).usage || '';
  }

  function reset() {
    for (const sender of new Set([...requests.keys(), ...drafts.keys()])) cancel(sender);
    index.clear();
    indexedRevision = undefined;
    clearRanks();
  }

  return {summarize, reanalyze, followup, paragraph, save, cancel, knownSenses, rank, usage, clearRanks, reset,
    dispose() { reset(); summarizer.dispose(); }};
}
