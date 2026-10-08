# 앱 단어장 분석을 ChatGPT 웹챗 MCP로 처리하기

사용자가 Codex 앱의 단어장 기능에서 분석하면 다음 흐름으로 처리한다.

`앱 분석 버튼 → 단어장 서비스 → 로컬 webchat_summarize MCP → 로그인된 ChatGPT 웹챗 → JSON 초안 → 앱의 기존 미리보기`

`labels/webchat-mcp.cjs`는 웹챗 요약 전용 MCP 서버다. 앱의
`src/node/webchat-summary-server.cts`가 MCP 클라이언트로 초기화와 도구 호출을 수행한다.
단어 분석·다시 분석·문단 분석·추가 질문·문맥 쓰임 분석이 같은 경로를 사용한다.
초안의 저장·원본 버전 확인·취소는 기존 단어장 서비스를 사용한다.
웹챗 연결 실패 시 오류를 표시하며 Codex나 유료 API로 자동 전환하지 않는다.

개인 설정의 `vocabularyModel.model`이 `chatgpt-web`일 때만 이 경로를 사용한다.
다른 Codex 모델을 선택하면 기존 Codex 분석 경로를 사용한다. 펫·라벨 등은 이 설정의 영향을 받지 않는다.
`vocabularyWebChat`에는 로컬 브라우저 디버그 `endpoint`와 `playwrightModule` 경로를 둔다.
웹챗 모델은 요약 전용 탭의 웹챗 설정을 사용하며 앱의 FAST는 사용하지 않는다.
설정 → 단어장의 추론 강도는 즉시(Instant), 보통(Medium), 높음(High), 매우 높음(Extra High)을 제공한다.
선택은 기존 `vocabularyModel.effort`에 저장하고 MCP 요청에 전달한다. 요청마다 새 임시 대화에서
웹챗 메뉴의 키보드 선택기를 조작하고 표시 이름과 선택 값을 확인한 뒤 프롬프트를 보낸다.
웹챗의 Extra High 메뉴가 내부적으로 `max`를 표시해도 앱에는 `xhigh`로 기록한다.
Pro는 별도 실행 모드이므로 추론 강도 목록에 넣지 않는다. 메뉴를 확인하거나 적용할 수 없으면
질문을 보내지 않고 오류를 표시한다. 요청에 강도가 없는 기존 MCP 호출은 Medium을 적용한다.

사이드 브라우저에 `https://chatgpt.com/?temporary-chat=true&codexmemo-webchat=1`을 연다.
이 전용 탭에서 로그인된 상태여야 한다. 요청마다 전용 탭에서 새 임시 대화를 시작한다.
답변 후에도 전용 탭 URL 표시를 유지해 브라우저가 탭을 복원했을 때 다시 찾을 수 있게 한다.
다른 탭은 조작하지 않고, 전용 탭에 작성 중인 글이나 생성 중인 답변이 있으면 요청을 거절한다.
키/쿠키를 복사하지 않는다. 이 분석 경로의 답변 생성에는 OpenAI API 키를 사용하지 않는다.
웹챗 자동 조작은 공식 ChatGPT 추론 API가 아닌 로컬 브라우저 중계이며 화면 변경에 영향을 받을 수 있다.

검증: `node --test tests/test_webchat_summary.cjs`는 실제 stdio MCP 왕복,
라우팅 분리, 취소·동시 요청·시간 초과·잘못된 답변·제외 도구 차단을 검사한다.
실제 완료 판정은 설치된 앱의 분석 버튼 클릭과 앱에 돌아온 웹챗 초안으로 확인한다.

## 웹챗에서 단어장을 직접 읽는 별도 연결

기존 `labels/memo-mcp.cjs`에 `CODEX_MEMO_MCP_PROFILE=vocabulary`를 지정하면
`status`, `vocabulary_list`, `vocabulary_add`, `vocabulary_update` 네 도구만 제공한다.
프로필을 지정하지 않은 기존 Codex 연결은 모든 도구를 그대로 제공한다.
웹챗 프로필에서는 단어 삭제, 메모, 라벨, 대화 이동 도구를 호출할 수 없다.

답변 생성은 ChatGPT 웹챗이 한다. 사용자가 답변을 확인한 뒤 저장/수정을 요청하면
기존 도우미를 통해 같은 단어장에 반영한다. 변경에는 기존 `changeId`와 되돌리기 기록이 남는다.
이 별도 터널 연결은 웹챗이 저장된 단어를 읽거나 명시된 추가/수정 요청을 처리하는 용도다.
위의 앱 분석 경로를 대신하지 않는다. 앱 분석에는 로컬 요약 MCP가 필요하다.

## 연결

- 공식 Secure MCP Tunnel의 별도 터널을 사용한다. 기존 `codex-chatgpt-web` 터널을 바꾸지 않는다.
- 터널을 Platform 조직과 사용할 ChatGPT 워크스페이스에 연결한다.
- `tunnel-client`의 stdio 명령은 Node 실행 파일과 연결용 런타임의 `memo-mcp.cjs`를 가리킨다.
  이 파일은 저장소의 `labels/memo-mcp.cjs`와 같으며 메모 도우미 업데이트와 별도로 유지한다.
- 실행 환경에 `CODEX_MEMO_MCP_PROFILE=vocabulary`와 터널 인증용
  `CONTROL_PLANE_API_KEY`를 전달한다. 키는 출력하거나 소스/프로필에 기록하지 않는다.
- ChatGPT 플러그인에서 사용자 지정 MCP 서버를 추가하고 Connection을 Tunnel로 설정한다.
  개인 워크스페이스로 제한된 이 서버의 Authentication은 None이다.
  플랫폼 터널 인증과 워크스페이스 접근 제어가 외부 연결을 제한한다.
- 로컬 도우미와 터널 클라이언트가 실행 중이어야 웹챗 호출이 성공한다.
- 터널의 발견 요청과 실제 세션이 같은 stdio 프로세스를 사용하므로,
  웹챗 프로필은 반복 초기화를 허용한다. 기본 전체 프로필의 초기화 검증은 유지한다.

## 현재 PC의 실행

사용자 환경 변수 `pet`은 키 파일의 경로를 가리킨다. 로컬 실행 스크립트가
파일에서 키 하나를 읽어 자식 프로세스의 `CONTROL_PLANE_API_KEY`로만 전달한다.
키를 터널 프로필에 저장하지 않는다. 저장소 안의 키 파일은 로컬 Git 제외 목록에 넣는다.
실행 파일과 스크립트는 `%LOCALAPPDATA%\CodexMemoWebChat`에 설치하며,
로그인 시 숨김 창으로 재연결한다. 원래 도우미가 시작된 뒤에 단어장 호출이 가능하다.

예: “단어장에서 cache를 찾아 문맥에 맞게 설명해줘.”
답변을 확인한 다음 “그 뜻과 예문으로 이 항목을 수정해줘.”

## 확인

`node --test tests/test_memo_mcp_profile.cjs`는 기본 전체 도구 유지,
웹챗 도구 목록 제한, 제외 도구와 잘못된 인자 차단, 가짜 백엔드 전달을 검증한다.
`python tests/test_agent_tools.py`는 기존 제어 서버와 전체 MCP 회귀 검사다.
실제 웹챗 연결 완료는 터널 ready 상태와 웹챗의 실제 도구 호출로 별도 확인한다.

참고: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
