# 펫의 업무 진척

기존 CodexMemo 펫에서 **업무 진척**을 누르면 프로젝트 A–D를 작은 표로 봅니다. 행을 누르면 단계, 체크리스트, 차단 사유, 다음 행동, 출처 링크와 갱신 시각을 펼칩니다. 기본 예시는 기능 안내용 가상 데이터이며 실제 개인·회사 프로젝트의 이름이나 현황을 담지 않습니다.

**프로젝트 A 표시**는 이 화면에서 첫 행만 숨기는 설정입니다. 원본 업무나 가져온 자료는 변경하지 않습니다. 기존 다음 할 일 추천, 대화 열기, 넘기기와 펫 숨기기 동작은 유지합니다.

## 사용

1. 펫을 열고 **업무 진척**을 누릅니다. 처음에는 네 프로젝트 모두 `미정`이며 동기화 시각이 없습니다.
2. **수동 동기화 · JSON**에서 원본 자료를 아래 계약에 맞게 내보낸 JSON 파일을 고릅니다. 선택을 취소하면 기존 자료를 유지합니다.
3. **초기 예시 보기**는 가상 단계와 설명만 표시합니다. API 조회나 실제 업무 진척을 뜻하지 않으며 완료율을 추정하지 않습니다.
4. [검증용 JSON](task-progress.example.json)은 가상 체크리스트의 1/2 완료 막대를 시험할 수 있습니다.

가져온 자료와 표시 설정은 해당 Codex 화면의 `localStorage`에 저장합니다. 다시 열면 저장된 자료임을 표시하고 마지막으로 가져온 시각을 유지합니다. 기존 저장키와 JSON ID는 호환성을 위해 유지하며, 화면에 표시하는 기본 이름만 프로젝트 A–D로 통일합니다. 계정 백업이나 다른 PC 동기화에는 포함하지 않습니다.

## 연결과 계산 범위

화면은 사용자가 고른 파일을 읽습니다. Space/OpenProject에 직접 연결하거나 계정 인증을 추가하지 않습니다. 원본 URL은 사용자가 링크를 열 때만 사용하며 자동 조회·서버 폴링·파일 감시·원본 쓰기·업무 실행은 하지 않습니다.

`원본 마지막 갱신`은 JSON의 출처 시각이고, `마지막 동기화`는 JSON을 이 화면에 성공적으로 가져온 시각입니다. 가상 예시는 동기화 시각을 만들지 않습니다. Space의 자유 문장이나 OpenProject의 추정 퍼센트로 완료율을 만들지 않습니다.

## JSON 계약

`formatVersion: 1`이며 최대 128 KiB UTF-8, 프로젝트 최대 4개입니다. 호환성용 내부 ID `mmh`, `erp`, `sns`, `openproject`는 화면의 프로젝트 A, B, C, D에 각각 대응합니다. 누락된 프로젝트는 `미정`으로 표시합니다.

```json
{
  "formatVersion": 1,
  "source": {
    "kind": "space",
    "label": "가상 원본 페이지",
    "ref": "example-snapshot",
    "url": "https://example.test/original",
    "updatedAt": "2000-01-01T00:00:00Z"
  },
  "projects": [{
    "id": "erp",
    "stage": "가상 검토 단계",
    "summary": "문서 형식을 설명하는 예시입니다.",
    "blockers": ["가상 검토 대기"],
    "nextAction": "가상 항목을 확인합니다.",
    "checklist": {
      "complete": true,
      "items": [
        {"id": "first", "text": "가상 첫 항목", "done": true},
        {"id": "second", "text": "가상 다음 항목", "done": false}
      ]
    }
  }]
}
```

출처 `kind`는 `space`, `openproject`, `sample` 중 하나이며 `label`은 필수입니다. 프로젝트별 `source`가 없으면 문서 출처를 상속합니다. `ref`, `url`, `updatedAt`, 단계와 설명은 모르면 생략할 수 있습니다. URL은 자격증명이 없는 절대 HTTP(S) 주소만 표시하며 시각에는 시간대가 있어야 합니다. 가져온 문장을 HTML로 실행하지 않습니다.

`checklist.complete: true`는 목록이 해당 업무의 전체 범위를 담았다는 뜻입니다. 목록이 비어 있지 않고 모든 `done`이 boolean이면 `완료 항목 / 전체 항목`으로 계산합니다. 전체 범위를 모르면 `complete: false`, 체크리스트가 없으면 생략 또는 null로 둡니다. 두 경우 모두 퍼센트를 표시하지 않습니다.

잘못된 JSON, 중복 ID, 잘못된 완료값, 15초를 넘기는 읽기는 오류를 표시하고 이전 자료와 성공 시각을 유지합니다. 읽기 중 추가 클릭은 무시하며 뒤늦게 도착한 응답도 반영하지 않습니다.

## 구현과 검증

- `labels/task-progress-model.js`: 출처와 체크리스트 검증, 완료율 계산, 명시적 가상 예시.
- `labels/task-progress.js`: 파일 선택, 저장된 자료, 상세 정보, 표시 설정, 오류와 수명 종료 처리.
- `labels/task-pet.js`: 기존 펫에서 다음 할 일과 업무 진척 화면 전환.

```sh
npm run check
node --test tests/test_task_progress.cjs tests/test_task_pet.cjs tests/test_task_pet_catalog.cjs
python tests/test_task_progress_ui.py
```

UI 검사는 Playwright와 설치된 Chrome을 사용합니다. 가짜 페이지와 가상 JSON만 읽으며 실제 Codex 계정이나 외부 업무 서비스에 연결하지 않습니다. 스크린샷은 git에서 제외된 `output/pet-progress/`에 저장합니다. 실제 호스트 앱과 원본 서비스의 호환성은 별도로 확인해야 합니다.
