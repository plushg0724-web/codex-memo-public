(function () {
  'use strict';

  /** One-click followup questions. Saved as ordinary followups; the label replaces the long question in headings. */
  const PRESETS = [
    {label: '자세한 설명', question: '이 단어를 더 자세히 설명해 주세요. 배경, 작동 원리나 구성, 실제로 쓰이는 방식을 단계적으로 풀어 주세요.'},
    {label: '쉬운 설명', question: '이 분야를 처음 접하는 사람도 바로 이해할 수 있게 쉬운 말과 일상적인 비유로 짧게 설명해 주세요.'},
    {label: '예시 더 보기', question: '이 단어가 다른 상황에서 쓰이는 예시를 2~3개 더 들고, 각 예시의 뜻을 짧게 풀어 주세요.'},
  ];
  function followupLabel(question) {
    const preset = PRESETS.find(item => item.question === question);
    return preset ? preset.label : question;
  }

  /** Canonical display paragraphs shared by the editor, preview card, and store. */
  function paragraphs(entry) {
    const result = [];
    if (!entry || typeof entry !== 'object') return result;
    const add = (value, label, kind, split, recordId) => {
      if (typeof value !== 'string') return;
      for (const part of split ? value.split(/\n\s*\n/) : [value]) {
        const text = part.trim();
        if (text) result.push({text, label, kind, ...(recordId?{recordId}:{})});
      }
    };
    add(entry.meaning, '맥락분석', 'meaning', true);
    add(entry.partOfSpeech, '품사', 'partOfSpeech', false);
    for (const definition of Array.isArray(entry.definitions) ? entry.definitions : []) {
      add(definition, '사전적 의미', 'definition', false);
    }
    add(entry.explanation, '참고', 'explanation', true);
    add(entry.example, '예문', 'example', false);
    for (const followup of Array.isArray(entry.followups) ? entry.followups : []) {
      if (!followup || typeof followup !== 'object') continue;
      add(followup.answer, typeof followup.question === 'string' ? followupLabel(followup.question) : '추가 질문', 'followup', true, followup.id);
    }
    return result;
  }

  /** Pins use exact paragraph text; duplicate text appears once in canonical order. */
  function selectedParagraphs(entry) {
    const selected = new Set(Array.isArray(entry?.previewParagraphs) ? entry.previewParagraphs : []);
    const seen = new Set();
    return paragraphs(entry).filter(paragraph => {
      if (paragraph.kind === 'meaning' && entry.showContextAnalysis === false) return false;
      if (!selected.has(paragraph.text) || seen.has(paragraph.text)) return false;
      seen.add(paragraph.text);
      return true;
    });
  }

  function normalizeSelections(entry) {
    const selected=new Set(Array.isArray(entry?.previewParagraphs)?entry.previewParagraphs:[]),seen=new Set();
    return paragraphs(entry).filter(p=>selected.has(p.text)&&!seen.has(p.text)&&(seen.add(p.text),true)).map(p=>p.text);
  }

  function replaceParagraph(entry, paragraph, answer) {
    const replace = value => String(value||'').split(/\n\s*\n/).map(p=>p.trim()).map(p=>p===paragraph.text?answer:p).filter(Boolean).join('\n\n');
    if(['meaning','explanation'].includes(paragraph.kind))return {[paragraph.kind]:replace(entry[paragraph.kind])};
    if(['partOfSpeech','example'].includes(paragraph.kind))return {[paragraph.kind]:answer};
    if(paragraph.kind==='definition'){
      const index=(entry.definitions||[]).indexOf(paragraph.text),definitions=[...(entry.definitions||[])];
      if(index<0)throw Error('대상 문단을 찾지 못했습니다.');
      if(answer)definitions[index]=answer;else definitions.splice(index,1);
      const old=entry.definitionIndex??-1;
      return {definitions,definitionIndex:answer?old:old===index?-1:old>index?old-1:old};
    }
    if(paragraph.kind==='followup')return {followups:(entry.followups||[]).map(f=>f.id===paragraph.recordId?{...f,answer:replace(f.answer)}:f).filter(f=>f.answer)};
    if(paragraph.kind==='context')return {contextAnalyses:(entry.contextAnalyses||[]).flatMap(c=>c.id!==paragraph.recordId?[c]:answer?[{...c,analysis:answer}]:[])};
    throw Error('수정할 문단 종류를 확인하세요.');
  }
  const content = {PRESETS, followupLabel, paragraphs, selectedParagraphs, normalizeSelections, replaceParagraph};
  if (typeof globalThis === 'object') globalThis.CodexVocabContent = content;
  if (typeof module === 'object' && module.exports) module.exports = content;
})();
