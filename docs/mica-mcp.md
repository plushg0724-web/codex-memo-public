# 분류기 MCP 서버

`labels/mica-mcp.cjs`는 Codex나 다른 MCP 클라이언트가 대화 중 빠른 분류를 요청할 수 있는 독립 stdio 서버다. Node 내장 모듈과 기존 `mica.cjs`만 사용하며 npm 설치는 필요 없다. Node 22 이상을 권장한다. Codex 메모 트레이·CDP·App Server를 실행하지 않고 개인 메모·라벨·설정 파일도 읽지 않는다.

기본은 무료 로컬 Mica(`http://127.0.0.1:8010`)다. `classifier` 도구 인자 또는 `CODEX_MEMO_CLASSIFIER` 환경변수로 `mica`, `jev`, `both`를 선택한다. 도구 인자가 환경변수보다 우선하며 다음 호출의 기본값은 바꾸지 않는다. `both`는 두 분류기의 확률을 평균 내고, 한쪽이 실패하면 다른 쪽 답을 사용한다.

JEV는 클라우드 서비스다. `jev`·`both`를 선택하면 판단할 글이 JEV로 전송된다. 무료·로컬이라는 설명은 Mica에 해당하며 JEV의 요금·사용 조건은 별도로 확인해야 한다. 실제 키를 문서나 설정 예시에 적지 않는다.

## Codex 연결

아래는 사용자가 필요할 때 **직접** `~/.codex/config.toml`에 넣는 예시다. 서버와 테스트는 이 파일을 읽거나 수정하지 않는다. `<설치경로>`를 실제 절대 경로로 바꾼다. TOML의 작은따옴표 문자열은 Windows 역슬래시를 그대로 쓸 수 있다.

```toml
[mcp_servers.mica]
command = "node"
args = ['<설치경로>\labels\mica-mcp.cjs']
env = { CODEX_MEMO_CLASSIFIER = "mica" }
```

예를 들어 설치 경로가 `D:\labels\codex-memo`면 `args = ['D:\labels\codex-memo\labels\mica-mcp.cjs']`다. `node`가 클라이언트 PATH에 없으면 `command`에도 `node.exe`의 절대 경로를 작은따옴표로 넣는다. 연결 설정의 `command`, `args`, `env`, `env_vars` 형식은 [OpenAI 공식 MCP 문서](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)에 따른다.

JEV를 사용하려면 클라이언트 프로세스에 `JEV_API_KEY` 환경변수가 있어야 한다. 위 블록에 `env_vars = ["JEV_API_KEY"]`를 추가해 전달하고 `env`의 기본 분류기를 `"jev"` 또는 `"both"`로 바꿀 수 있다. 키 값은 TOML에 쓰지 않는다. 로컬만 쓰려면 `mica`를 유지한다.

| 환경변수 | 기본값 / 역할 |
|---|---|
| `CODEX_MEMO_CLASSIFIER` | `mica`; `mica`, `jev`, `both` 중 선택 |
| `CODEX_MEMO_MICA_URL` | `http://127.0.0.1:8010`; 로컬 분류기 주소 |
| `CODEX_MEMO_JEV_URL` | `https://api.typesafe.ai`; JEV 주소, 테스트에서는 가짜 서버로 지정 |
| `JEV_API_KEY` | JEV 인증키; 환경변수로만 전달 |

잘못된 환경변수 선택값은 기존 `mica.cjs` 규칙대로 `mica`를 기본으로 쓴다. 잘못된 `classifier` 도구 인자는 오류다.

## 수동 확인

PowerShell에서 설치 폴더로 이동해 `node .\labels\mica-mcp.cjs`를 실행한다. 입력을 기다리는 동안 시작 문구가 없는 것이 정상이다. 다음 줄을 **한 줄씩** 입력한다.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"manual","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"ping"}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"mica_choose","arguments":{"text":"라우터의 경로 표를 수정했습니다.","question":"어느 분야인가?","options":{"net":"네트워크","web":"웹 화면"}}}}
```

초기화 응답의 `serverInfo.name`은 `mica`, 버전은 `1.0.0`이며 목록에는 네 도구가 나온다. 알림에는 응답하지 않고 `ping`은 빈 객체를 반환한다. stdout은 줄 단위 JSON-RPC 메시지만, 내부 로그는 stderr로 출력한다. 종료는 입력을 닫거나 Ctrl+C를 누른다.

서버가 지원하는 프로토콜 버전은 `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`다. 지원 버전 요청에는 같은 버전을 돌려주고, 다른 버전 요청에는 `2025-11-25`를 제안한다. 클라이언트는 그 버전을 지원하지 않으면 연결을 종료해야 한다. 초기화 순서와 협상은 [MCP 수명주기 규격](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)에 따른다.

실제 분류기가 없어도 초기화·목록·ping은 확인할 수 있다. Mica가 꺼져 있으면 호출 결과의 `isError: true`와 `Start-Mica.cmd` 안내를 확인한다. JEV 키가 없으면 `JEV_API_KEY` 안내가 나온다. 상태 확인 결과는 기존 모듈에서 30초간 기억하므로 서비스를 켠 직후에는 잠시 기다리거나 MCP 서버만 다시 시작해 확인한다.

가짜 서버로 모든 도구를 확인하려면 저장소에서 실행한다. 실제 Mica·JEV를 호출하지 않는다.

```powershell
node --test tests/test_mica_mcp.cjs
```

## 도구별 예시와 반환값

아래 JSON은 `tools/call`의 `params`에 넣는다. 모든 도구는 선택 인자 `classifier`를 받을 수 있다. 결과는 MCP `content[0].text` 안의 JSON 문자열이다. `isError`는 도구 호출 오류를 나타내며 낮은 확신 자체는 오류가 아니다.

### mica_choose

```json
{"name":"mica_choose","arguments":{"text":"서버 오류를 고쳐 주세요.","question":"요청 유형은?","options":{"bug":"오류 수정","feature":"새 기능 추가","other":"그 외"},"classifier":"mica"}}
```

`options`는 `id: 설명` 객체 또는 설명 배열이다. 배열은 `"0"`, `"1"`처럼 0부터 시작하는 문자열 id로 변환된다. 선택지는 2~64개다. 결과 예시(설명용이며 실측 결과가 아님):

```json
{"choice":"bug","description":"오류 수정","probabilities":{"bug":0.9,"feature":0.06,"other":0.04},"confidence":0.9,"reliable":true,"classifier":"mica","classifierName":"Mica"}
```

`classifier`·`classifierName`은 실제 답을 사용한 분류기다. `both` 요청에서도 JEV만 성공하면 `jev`·`JEV`로 표시한다. `confidence`는 선택된 항목의 확률, `reliable`은 확신이 0.8 이상인지다. 이 표시는 정답 보증이 아니다.

### mica_yes_no

```json
{"name":"mica_yes_no","arguments":{"text":"회의는 내일 오후 3시에 열립니다.","question":"회의 시간이 명시되어 있는가?"}}
```

결과: `answer`(불리언), `confidence`(선택한 예/아니오의 확률), `reliable`, 실제 분류기. `noul` 응답은 예 확률로 해석한다. 예 확률이 0.1이면 `answer: false`, `confidence: 0.9`다. `answer`·`confidence` 형식도 지원한다.

### mica_score

```json
{"name":"mica_score","arguments":{"text":"한 문장짜리 짧은 요청입니다.","question":"글의 길이에 가장 가까운 단계는?","scale":["짧음: 한두 문장","중간: 한두 문단","길음: 여러 문단"]}}
```

`scale`은 낮음→높음 순서의 설명 배열(2~64개)이다. 결과는 `score`(1~단계 수 정수), 선택한 설명, 확률 표, 확신과 실제 분류기다. 연속 점수나 객관적인 평가가 아니라 **척도 선택**이다. 작업 완료도 점수는 부정확하므로 완료 판정에 사용하지 않는다.

### mica_batch

```json
{"name":"mica_batch","arguments":{"items":[{"id":"a","text":"오류를 고쳐 주세요."},{"id":"b","text":"검색 버튼을 추가해 주세요."}],"question":"요청 유형은?","options":["오류 수정","새 기능 추가","그 외"]}}
```

`items`는 1~100개이며 `id`는 중복되지 않는 문자열이다. 동시에 최대 4개씩 요청하고 결과의 `items` 배열은 입력 순서를 보존한다. 각 항목에는 `id`와 선택·확률·확신·실제 분류기가 들어간다. 일부 요청이 실패하면 해당 항목에 `error`가 들어가고 전체 `isError`가 참이다. 성공한 항목은 함께 남는다. 시작부터 분류기를 쓸 수 없으면 전체 오류 안내를 반환한다.

글·질문·설명·id는 비어 있지 않은 100000자 이하 문자열이다. 큰 일괄 요청은 클라이언트 제한 시간 안에 끝나도록 나누어 보내는 것이 좋다. 기본 HTTP 요청 제한 시간은 기존 모듈의 8초다.

## 정확도와 사용 기준

프로젝트에서 제공된 기존 실측은 단어 뜻 판단 **7/7**, 라벨 분류에서 확신 **0.8 이상인 사례 5/5**였다. 표본이 작고 특정 문맥의 결과이며, 이번 가짜 서버 테스트에서 정확도를 다시 측정한 값은 아니다. **작업 완료도 점수는 부정확**했다.

확신이 0.8 미만이면 선택을 확정하지 않고 사람이 보거나 주 모델로 다시 판단한다. 확신이 높아도 근거가 필요한 결정·미묘한 문맥·완료 판정은 별도 확인한다. 분류기는 글을 생성하지 못하며 목록에서 고르거나 예/아니오를 판단한다. 에이전트에게 줄 사용 지침은 [mica-skill.md](mica-skill.md)를 참고한다.
