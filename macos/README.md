# Codex 메모 · macOS

기존 Windows 도우미의 메모·형광펜·단어장·라벨 화면과 저장소를 공유하고, macOS 메뉴 막대는 Swift/AppKit으로 구현합니다.

## 사용

1. `Codex 메모.app`을 Applications 폴더나 원하는 위치에 복사하고 엽니다.
2. 메뉴 막대의 메모 아이콘을 누르고 **메모 모드 시작…**을 선택합니다.
3. Codex가 실행 중이면 재시작 여부를 확인합니다. 진행 중인 작업을 먼저 마무리하세요.
4. Codex 대화 글을 드래그하면 메모·단어장 버튼이 표시됩니다. 보관함의 설정에서 라벨·모델·작성 지침을 조절합니다.

Codex.app과 Codex 기능이 포함된 ChatGPT.app을 `/Applications` 및 `~/Applications`에서 찾습니다.
앱에 포함된 Codex CLI를 사용하며, 별도 API 키를 생성하지 않습니다.
데이터는 `~/Library/Application Support/CodexMemo`에 저장합니다. 기존 Windows 백업은 **계정 백업에서 복원…**으로 가져올 수 있습니다.
자동 백업과 Google 시트 연결은 사용자가 메뉴에서 켰을 때만 사용합니다.

프로그램은 실행 중인 호스트 앱을 자동 종료하지 않습니다. macOS에서 앱 종료 제어를 처음 요청하면 시스템의 자동화 접근 확인이 나타날 수 있습니다.
호스트 앱을 다시 시작한 뒤 연결 포트가 열리지 않으면 오류를 표시합니다. 앱 버전에 따라 디버그 연결과 화면 구조가 달라질 수 있습니다.

## 현재 범위

- 메뉴 막대, 메모/단어장 보관함, 메모 모드 실행·재시작, 화면 새로 고침, 데이터 폴더 열기
- 공통 화면의 드래그 메모·형광펜·단어 표시·라벨·분류·검색
- 계정 백업·복원·자동 백업, Google 시트 연결, 다음 할 일 추천 설정
- 기존 MCP의 macOS 데이터 경로

Windows의 BAT/CMD/PS1/EXE/LNK 바로 실행 관리와 Ctrl+Alt+M 전역 단축키는 이 macOS 메뉴 앱에 포함하지 않습니다.
메뉴가 열린 상태에서는 ⌘M으로 메모, ⌘V로 단어장을 열 수 있습니다.
macOS 앱의 자동 업데이트는 구현하지 않았습니다. 새 앱 묶음으로 교체하면 개인 데이터는 유지됩니다.

## 빌드

macOS 13.5 이상에서 빌드하며 Swift Command Line Tools, Node, Python 3.12 이상이 필요합니다.
결과 앱에는 Python과 Node가 포함되어 있어 실행할 때 별도로 설치하지 않아도 됩니다.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r macos/requirements-build.txt
npm ci
.venv/bin/python macos/build.py --output "$PWD/release/Codex 메모.app"
```

Node v24.21.0의 공식 배포 파일을 내려받아 소스에 고정된 SHA-256과 대조합니다.
Swift 메뉴 실행 파일과 frozen Python 도우미를 만들고 로컬 ad-hoc 서명 후 검증합니다.
빌드 결과는 개발용입니다. `macos/release.py`가 별도 복사본에 Developer ID 서명·공증·설치 파일 생성을 수행합니다.
Apple Silicon 맥에서는 arm64, Intel 맥에서는 x64 앱을 만듭니다. 유니버설 앱은 아닙니다.

```sh
npm run check
node --test --test-concurrency=1 tests/test_*.cjs
.venv/bin/python tests/test_core.py
.venv/bin/python tests/test_agent_tools.py
.venv/bin/python tests/test_macos.py
.venv/bin/python tests/test_macos_packaging.py
.venv/bin/python tests/test_macos_release.py
.venv/bin/python tests/test_cdp_targets.py
CODEX_MEMO_DATA="$(mktemp -d)" "release/Codex 메모.app/Contents/MacOS/CodexMemoMenu" --smoke-test
```

화면 회귀 검사는 `playwright`와 Chrome이 필요합니다. 실제 Codex 작업·계정 쓰기를 포함한 검사는 별도입니다.
`--smoke-test`는 메뉴 앱·도우미·Node 백엔드의 시작과 정상 종료를 검사하며 실제 메모 모드를 켜거나 모델을 호출하지 않습니다.

## 외부 배포 준비

설치 패키지 테스트는 다음과 같이 실행합니다. 출력 폴더는 새 경로여야 합니다.

```sh
.venv/bin/python macos/release.py --app "$PWD/release/Codex 메모.app" --output "$PWD/release/preview" --preview
```

서명·공증 배포는 Developer ID Application 인증서와 비공개 키, Keychain에 저장한 notarytool 자격 증명이 필요합니다.
준비 절차와 실제 검증 범위는 [DISTRIBUTION.md](DISTRIBUTION.md)에 있습니다.
`release-manifest.json`의 `distributionReady`는 Developer ID 서명·공증·Gatekeeper 검증 완료를 뜻합니다.
`--preview` 결과는 공증되지 않은 테스트용이며, 파일명에도 `preview`가 붙습니다.
지인에게 미공증 테스트본을 직접 전달할 때는 첫 실행 확인이 필요할 수 있음을 안내합니다.
Apple의 [미공증 앱 열기 안내](https://support.apple.com/ko-kr/102445)를 참고하세요.
포함 소프트웨어 고지는 앱의 `Contents/Resources/THIRD_PARTY_NOTICES.txt`와 `Licenses`에 보관합니다.

## 개발 설정

- `CODEX_MEMO_DATA`: 데이터 경로 교체 (테스트는 임시 폴더 사용)
- `CODEX_MEMO_APP`: 호스트 `.app` 경로 명시
- `CODEX_EXE`: Codex CLI 경로 명시
- `CODEX_MEMO_NODE`: Python 도우미가 사용할 Node 경로 명시
- `CODEX_MEMO_DEBUG_PORT`: 테스트용 연결 포트 (기본 9233)

MCP를 연결하려면 앱 묶음 안의 `Contents/Resources/node/bin/node`와
`Contents/Resources/runtime/CodexMemoHelper/_internal/labels/memo-mcp.cjs`를 실행하도록 등록합니다.
기존 사용자 설정은 자동으로 고치지 않습니다.
