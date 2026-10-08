import {randomUUID} from 'node:crypto';
import type {SummaryOptions, SummaryServer, VocabDraft, VocabEntry, VocabFollowup, VocabRevisionDraft} from './backend-types.cjs';

const {normalizeSelections} = require('../../labels/vocabulary-content.js') as {
  normalizeSelections(entry: VocabEntry): string[];
};

/** 다시 분석: 기존 추가 답변은 그대로 두고, 아직 없는 기본 설명(자세한·쉬운·예시)만 새 결과에서 더한다. */
function withNewPresets(kept: VocabFollowup[] | undefined, fresh: VocabFollowup[] | undefined): VocabFollowup[] | undefined {
  if (!fresh?.length) return kept;
  const asked = new Set((kept || []).map(item => item.question));
  const added = fresh.filter(item => !asked.has(item.question));
  return added.length ? [...(kept || []), ...added].slice(0, 20) : kept;
}

export function revisionDraft(original: VocabEntry, changes: VocabDraft, baseRevision: string, action: VocabRevisionDraft['action']): VocabRevisionDraft {
  const draft: VocabRevisionDraft = {
    ...original, ...changes,
    id: original.id, savedAt: original.savedAt, updatedAt: original.updatedAt,
    term: original.term, context: original.context, source: original.source,
    favorite: original.favorite, status: original.status,
    followups: action === 'followup' ? changes.followups : withNewPresets(original.followups, changes.followups),
    previewParagraphs: original.previewParagraphs,
    targetId: original.id, baseRevision, action,
  };
  if (original.previewParagraphs !== undefined) draft.previewParagraphs = normalizeSelections(draft);
  return draft;
}

const answerSchema = {
  type: 'object', properties: {answer: {type: 'string', minLength: 1, maxLength: 6000}},
  required: ['answer'], additionalProperties: false,
};

export function followupQuestion(original: VocabEntry, question: string): string {
  const value = question.replace(/\r\n?/g, '\n').trim();
  if (!value || value.length > 2000) throw Error('추가 질문은 1~2,000자로 입력하세요.');
  if ((original.followups?.length || 0) >= 20) throw Error('추가 질문은 단어 하나에 20개까지 저장할 수 있습니다.');
  return value;
}

export async function generateFollowup(server: SummaryServer, original: VocabEntry, question: string, options: SummaryOptions, onStop: (stop: () => void) => void): Promise<VocabFollowup> {
  const prompt = [
    '저장된 단어장과 원문 문맥에 대한 사용자의 추가 질문에 한국어로 답하세요.',
    '질문에 직접 답하고, 필요하면 기존 설명과의 차이 및 구체적인 예시를 포함하세요. 답변은 6,000자 이내로 작성하세요.',
    options.guide ? `작성 지침:\n${options.guide}` : '',
    'answer 문자열 하나를 가진 JSON 객체로 답하세요.',
    JSON.stringify({term: original.term, context: original.context || '',
      current: {meaning: original.meaning, definitions: original.definitions || [], definitionIndex: original.definitionIndex,
        partOfSpeech: original.partOfSpeech || '', explanation: original.explanation || '', example: original.example || '', tags: original.tags || []},
      followups: original.followups || [], question}),
  ].filter(Boolean).join('\n\n');
  const raw = await server.run({model: options.model, effort: options.effort, fast: options.fast, prompt, schema: answerSchema}, {onStop});
  let response: unknown;
  try {response = JSON.parse(raw);} catch {throw Error('추가 질문 답변을 읽지 못했습니다. 다시 시도하세요.');}
  if (!response || typeof response !== 'object' || !('answer' in response) || typeof response.answer !== 'string') throw Error('추가 질문 답변 형식을 확인하지 못했습니다. 다시 시도하세요.');
  const answer = response.answer.replace(/\r\n?/g, '\n').trim();
  if (!answer || answer.length > 6000) throw Error('추가 질문 답변은 1~6,000자여야 합니다. 질문을 조정해 다시 시도하세요.');
  return {id: randomUUID(), question, answer, createdAt: Date.now(), model: options.model, effort: options.effort};
}
