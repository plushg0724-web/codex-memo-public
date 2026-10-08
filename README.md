# Codex 메모

Codex 대화에 **드래그 메모, 형광펜, 단어장, 대화 라벨**을 더하는 비공식 데스크톱 도우미입니다. Windows에서는 트레이 앱으로, macOS에서는 메뉴 막대 앱으로 실행합니다.

OpenAI가 제공하거나 보증하는 제품이 아닙니다. 별도로 설치한 Codex 호스트 앱의 로컬 디버그 연결을 통해 화면 기능을 더하며, 호스트 앱 파일을 수정하지 않습니다. 화면 주입과 일부 앱 내부 통신에 의존하므로 공식 확장 API로 보장되는 통합은 아닙니다. Codex Labels는 이 프로젝트 작성자가 직접 개발한 이전 이름의 프로그램으로, 해당 화면·저장 코드를 이어서 사용합니다.

## 주요 기능

- **메모와 형광펜:** 대화에서 선택한 문장을 메모로 저장하고, 보관함에서 검색·수정하거나 원래 위치로 이동합니다.
- **문맥 단어장:** 선택한 단어의 문맥상 뜻과 사전적 의미를 정리하고, 추가 질문·다시 분석·학습 상태를 관리합니다. AI 분석 없이 메모만 저장할 수도 있습니다.
- **대화 정리:** 진행 상태와 카테고리를 독립적으로 지정하고, 목록 필터와 분류 추천을 사용합니다.
- **읽기 보조:** 저장된 단어의 본문 표시, 마우스 올림 카드, 중요 문단 고정, 구독 할당량의 금액 환산 표시를 제공합니다. 환산액은 실제 청구액이 아닙니다.
- **선택형 연동:** 계정 백업·복원, Google 시트 누적 저장, MCP를 통한 메모·라벨 관리를 연결할 수 있습니다.

세부 조작, 모델 설정, 백업 범위와 코드 구성은 [기능과 아키텍처](docs/architecture.md)에 정리했습니다.

## 지원 환경

| 항목 | Windows | macOS |
|---|---|---|
| 실행 방식 | 트레이 앱 | Swift/AppKit 메뉴 막대 앱 |
| 호스트 | Microsoft Store의 Codex 앱 | Codex CLI를 포함한 Codex.app 또는 Codex 기능이 포함된 ChatGPT.app |
| 시스템 조건 | 설치한 호스트 앱의 Windows 요구사항을 충족해야 함 | 현재 테스트 대상은 **Apple Silicon(arm64), macOS 13.5 이상** |
| 메모·형광펜·단어장·라벨 | 지원 | 공통 화면·저장소 사용 |
| 프로그램 바로 실행·전역 단축키 | BAT/CMD/PS1/EXE/LNK 관리, Ctrl+Alt+M | 현재 메뉴 앱에는 포함하지 않음 |
| Python·Node | 설치 프로그램이 준비 | 빌드된 앱에 포함 |
| 업데이트 | Windows 릴리스 설치·업데이트 기능 | 새 앱 묶음으로 교체 |

macOS 호스트는 `/Applications` 또는 `~/Applications`에서 찾습니다. 호스트 앱이 요구하는 OS가 더 높으면 그 요구사항을 따릅니다. Intel/Universal 앱과 별도 맥에서의 첫 실행은 아직 검증 대상으로 남아 있습니다. 호스트 업데이트로 화면 구조나 디버그 연결 방식이 바뀌면 호환성 수정이 필요할 수 있습니다.

## 설치와 첫 실행

### Windows

아직 이 새 저장소에 설치용 Release를 게시하지 않았습니다. 아래 설치 프로그램 절차는 첫 Windows Release를 올린 뒤 사용할 수 있습니다. 현재는 소스를 내려받아 [개발 안내](docs/development.md)에 따라 빌드합니다.

1. [Releases](https://github.com/plushg0724-web/codex-memo-public/releases)에서 `CodexMemo-Setup.cmd`를 받아 실행합니다.
2. 설치 프로그램이 Python·Node와 필요한 패키지를 준비하고, `CodexMemo-Windows.zip`을 사용자 프로그램 폴더에 설치합니다.
3. 트레이 아이콘이 나타나면 메모 모드 시작 안내를 따릅니다. 실행 중인 Codex를 다시 시작해야 할 때는 먼저 확인합니다.

미리 받은 `CodexMemo-Windows.zip`은 압축을 풀고 `CodexMemo-Install.cmd`로 설치할 수 있습니다. GitHub의 **Source code (zip)**은 실행용 설치 파일과 다르며 빌드가 필요합니다. [Windows 설치·업데이트 상세](docs/development.md#windows-설치-상세)를 참고하세요.

공개 저장소의 배포 파일은 GitHub 로그인 없이 받을 수 있습니다. 비공개 저장소에서 배포 파일을 받는 경우에는 해당 저장소의 접근 권한이 필요합니다.

### macOS

macOS는 테스트 배포 단계입니다. 현재 준비된 DMG/ZIP은 로컬 빌드 산출물이며, 이 README에서 제공하는 공개 macOS Release 다운로드 링크는 아직 없습니다. 직접 빌드하려면 [macOS 빌드 안내](macos/README.md)를 따르세요.

1. 전달받거나 직접 만든 DMG/ZIP에서 `Codex 메모.app`을 **Applications** 폴더로 복사합니다.
2. 앱을 열고 메뉴 막대의 메모 아이콘에서 **메모 모드 시작…**을 선택합니다.
3. 호스트 앱이 실행 중이면 재시작 여부를 확인합니다. 진행 중인 작업을 마무리한 뒤 시작하세요.
4. 대화 글을 드래그하면 메모·단어장 버튼이 표시됩니다.

미공증 테스트본을 지인에게 무료로 전달할 수 있습니다. 현재 preview는 **Apple Developer ID 서명과 Apple 공증을 받지 않은 테스트본**이므로 받는 사람에게 첫 실행 확인이 필요할 수 있음을 함께 알려 주세요. 출처와 파일을 신뢰한다면 실행을 시도한 뒤 **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**에서 확인할 수 있습니다. 자세한 절차는 [Apple 공식 안내](https://support.apple.com/ko-kr/102445)를 따릅니다.

`release-manifest.json`의 `distributionReady`는 Developer ID 서명·공증·Gatekeeper 검증 완료 여부를 뜻합니다. `preview-unnotarized`와 `distributionReady: false`는 이 검증을 완료하지 않았다는 표시입니다. 서명·공증 패키지를 만드는 절차는 [macOS 배포 안내](macos/DISTRIBUTION.md)에 있습니다.

## 개인정보와 데이터

메모·설정·라벨·단어장은 기본적으로 컴퓨터의 파일에 저장합니다. 앱 자체가 암호화 저장소를 제공하는 것은 아닙니다.

| 데이터 | 저장 위치·처리 |
|---|---|
| Windows 사용자 데이터 | `%LOCALAPPDATA%\CodexMemo` |
| macOS 사용자 데이터 | `~/Library/Application Support/CodexMemo` |
| 기존 Codex Labels 데이터 | `~/Documents/ChatGPT/codexlabels/app`에 기존 라벨 파일이 있으면 라벨·단어장을 재사용 |
| 메모 | 사용자 데이터 폴더의 `memos/memos.json`, 읽기용 `memos.md` |
| 복원 전 사본 | 사용자 데이터 폴더의 `restore-backups` |

새 앱으로 교체해도 사용자 데이터는 별도로 남습니다. 기존 Codex Labels 폴더를 재사용한다면 그 폴더도 백업 대상입니다. `CODEX_MEMO_DATA` 개발 설정으로 데이터 위치를 바꿀 수 있습니다.

다음 기능은 선택한 내용이나 데이터를 외부 서비스로 전달할 수 있습니다.

- **AI 분석·추가 질문:** 설치된 Codex CLI와 현재 로그인 계정을 사용하며, 선택한 글과 필요한 문맥이 서비스로 전달되고 계정 사용량을 소비할 수 있습니다. 요약용 로컬 폴더에 로그인 파일 복사본을 만들며, 갱신된 인증 정보를 원본에 반영할 수 있습니다.
- **분류기:** Mica의 기본 연결은 로컬 `127.0.0.1:8010`입니다. JEV 또는 `both`를 선택하면 분류할 글을 JEV 서비스로 전송합니다. 분류에 필요한 확신을 얻지 못하면 기능에 따라 Codex 모델 분석으로 이어질 수 있습니다.
- **계정 백업:** 사용자가 실행하거나 자동 백업을 켰을 때 메모·단어장·라벨·공통 설정을 계정의 개인 Space에 저장합니다. 로그인 파일과 로컬 제어 토큰은 이 백업에 포함하지 않습니다.
- **Google 시트:** 연결을 켜면 기존 항목과 새 저장 항목을 사용자의 시트에 추가합니다. 앱에서 수정·삭제해도 이미 추가한 시트 행은 그대로 남습니다. 해당 계정에 Google Drive 연결이 필요합니다.

메모 모드는 호스트의 `127.0.0.1:9233` 디버그 연결을 사용합니다. 이 연결이 열려 있는 동안 같은 컴퓨터의 다른 프로그램도 호스트 화면에 접근할 수 있습니다. **일반 모드로 돌아가려면 Codex 메모와 호스트 앱을 모두 완전히 종료한 뒤 호스트를 평소처럼 다시 여세요.** Codex 메모 종료만으로 호스트의 디버그 포트가 닫히지는 않습니다.

## 개발과 검증

소스 개발에는 Node.js/npm과 Python이 필요합니다. macOS 앱 빌드에는 Python 3.12 이상과 Swift Command Line Tools도 필요합니다. 플랫폼별 Python 의존성 설치는 [개발 환경 안내](docs/development.md#개발-환경)를 참고하세요.

가상환경을 준비한 뒤 다음 검사를 실행합니다.

```sh
npm ci
npm run check
python tests/run_all.py --suite core
python tests/run_all.py --suite node
```

macOS에서 가상환경을 활성화하지 않았다면 `python` 대신 `.venv/bin/python`을 사용합니다. `npm run check`는 TypeScript 빌드와 화면 JavaScript 타입 검사를 실행합니다. `core`에는 macOS 어댑터·패키징·배포·CDP 검사도 포함됩니다. Windows 전용 `test_updater.py`와 `test_watch.py`는 macOS에서 이유를 기록하고 건너뜁니다.

UI 검사는 설치된 Chrome과 Playwright가 필요하며, Windows 전용 native 화면 검사도 포함합니다. 단위검사 통과와 실제 AI 생성·계정 백업·Google 시트 쓰기 검증은 구분합니다. 전체 검사, 성능 비교, 패키징 명령은 [개발과 검증](docs/development.md)에 있습니다.

## 더 알아보기

- [세부 기능과 코드 구성](docs/architecture.md)
- [macOS 사용·빌드](macos/README.md)와 [서명·공증·패키징](macos/DISTRIBUTION.md)
- [메모·라벨 관리 MCP](docs/memo-mcp.md)
- [Mica/JEV 분류 MCP](docs/mica-mcp.md)와 [에이전트 사용 지침](docs/mica-skill.md)

프로젝트에서 직접 작성한 코드는 [MIT 라이선스](LICENSE)로 제공합니다. 포함하거나 함께 사용하는 외부 런타임·라이브러리는 각자의 라이선스를 따르며, macOS 번들의 고지는 [THIRD_PARTY_NOTICES.txt](macos/THIRD_PARTY_NOTICES.txt)에 있습니다. Codex와 ChatGPT는 별도로 설치하고 사용하는 OpenAI 제품이며, 이 프로젝트의 라이선스가 해당 제품이나 서비스의 권리를 부여하지 않습니다.
