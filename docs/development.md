# 개발과 검증

[프로젝트 소개](../README.md) · [기능과 아키텍처](architecture.md) · [macOS 빌드](../macos/README.md)

## 개발 환경

Node.js와 npm, Python을 준비합니다. macOS 빌드에는 Python 3.12 이상과 Swift Command Line Tools가 필요합니다. 설치용 macOS 앱에는 Python과 Node가 포함됩니다.

Windows에서는 저장소 루트에서 다음 명령으로 시작합니다.

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
npm ci
npm run check
python tests/run_all.py --suite core
python tests/run_all.py --suite node
```

macOS에서는 다음 명령을 사용합니다.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r macos/requirements-build.txt
npm ci
npm run check
.venv/bin/python tests/run_all.py --suite core
.venv/bin/python tests/run_all.py --suite node
```

`test_macos.py`, `test_macos_packaging.py`, `test_macos_release.py`, `test_cdp_targets.py`는 `core`에 자동 포함됩니다. macOS에서는 Windows 전용 `test_updater.py`와 `test_watch.py`를 건너뛰며, 실행 결과에 이유를 기록합니다. 건너뛴 검사는 통과 개수에 포함하지 않습니다.

전체/UI 검사에는 추가 화면 테스트 의존성과 설치된 Chrome이 필요합니다. `test_quick_launch.py`는 Windows CMD와 native 관리 창을 사용하는 검사입니다. macOS에서 core와 Node가 통과했다는 사실이 Windows UI나 실제 계정 연동 검증까지 뜻하지는 않습니다.

## macOS 앱과 테스트 패키지

```sh
.venv/bin/python macos/build.py --output "$PWD/release/Codex 메모.app"
.venv/bin/python macos/release.py \
  --app "$PWD/release/Codex 메모.app" \
  --output "$PWD/release/preview" --preview
```

출력은 새 경로를 사용합니다. `--preview`는 Developer ID 서명과 Apple 공증을 생략한 테스트 패키지이며 `release-manifest.json`에 `preview-unnotarized`로 기록됩니다. 정식 서명·공증과 배포 검증은 [macOS 배포 절차](../macos/DISTRIBUTION.md)를 따릅니다. macOS 앱 업데이트는 새 앱으로 교체하는 방식입니다.

## 빌드와 회귀 검사

- **개발 환경·빌드**: `npm ci` 후 `npm run build`를 실행합니다.
  `src/node/*.cts`를 `strict: true`로 검사하고 `dist/node/*.cjs` CommonJS 실행 파일, 타입 선언, source map을 생성합니다.
  TypeScript 소스를 수정한 뒤 다시 빌드하면 기존 `labels/*.cjs` 호환 래퍼를 통해 Python 도우미와 JS 모듈에서 변경된 구현을 사용합니다.
  Windows 트레이·단축키·프로세스 제어는 Python을 유지하며, 화면 스크립트와 vendor 코드는 기존 JS를 사용합니다.
- **배포 ZIP 만들기**: 빌드 후 `python scripts/package-release.py --output <ZIP경로>`를 실행합니다.
  `--include-source`를 붙이면 TypeScript 소스와 개발 자료도 포함합니다. 일반 설치용 ZIP에는 빌드된 실행 파일이 들어 있으므로 설치 시 `npm ci`나 TypeScript 컴파일이 필요 없습니다.
- **전체 회귀 검사**: `npm test` 또는 `python tests/run_all.py`.
  기존 Node 테스트와 Python 테스트를 각기 별도 프로세스로 실행하고, 결과와 로그를 `output/tests/`에 저장합니다.
  임시 데이터·가짜 백엔드·가짜 화면을 사용합니다. 화면 검사는 개발용 Python 패키지 `playwright`(`python -m pip install playwright`, 브라우저 내려받기 불필요)와 설치된 Chrome이 필요하고,
  바로 실행 검사는 임시 CMD와 관리 창도 실행합니다. `playwright`가 없으면 실행기가 마지막에 설치 안내를 표시합니다.
  저장·통신만 검사하려면 `npm run test:core`, Node만 검사하려면 `npm run test:node`, 화면은 `npm run test:ui`를 사용합니다.
  로그 위치는 `python tests/run_all.py --output <폴더>`로 지정할 수 있습니다. 타입 검사는 별도로 `npm run check`를 실행합니다.
- **타입 검사**: `npm run check`는 strict Node 빌드와 기존 화면 JS 검사를 함께 실행합니다. 출력 파일 없이 Node 타입만 검사하려면 `npm run check:node`를 사용합니다.
  Node 메서드별 인자·응답은 `src/node/protocol.cts`, 도메인 데이터는 `src/node/backend-types.cts`와 각 기능의 타입 모듈에 정의합니다.
  직접 만든 화면 JS(`inject.js`, `labels/*.js`)의 `// @ts-check`와 `types/globals.d.ts`도 유지합니다.
  `labels/vendor/` 원본은 직접 검사하지 않고, TypeScript 백엔드와 만나는 경계에 명시적인 API 타입을 둡니다.
- **화면 테스트**: `python tests/test_ui.py` (설치된 Chrome 사용)
- **저장소·백엔드 회귀 검사**: `python -m unittest discover -s tests -p test_core.py -v`
- **Windows Codex 일반 모드 감지 검사**: `python -m unittest tests/test_watch.py -v`
- **라벨 추천 칩 검사**: `python tests/test_label_suggest.py`
- **Mica 연동 검사**: `node --test tests/test_mica.cjs` (가짜 Mica 서버 사용)
- **분류기 MCP 검사**: `node --test tests/test_mica_mcp.cjs` (별도 stdio 프로세스 + 가짜 Mica·JEV 서버)
- **App Server 연결 재사용 검사**: `node --test tests/test_appserver.cjs` (가짜 App Server 사용)
- **진행 상태·카테고리 저장 검사**: `node --test tests/test_label_assignments.cjs tests/test_label_scores.cjs` (임시 데이터로 이전 배정 보존·독립 해제·호스트 별칭·카테고리 예시 검사)
- **진행 상태·카테고리 화면 검사**: `python tests/test_label_separation.py` (설치된 Chrome의 합성 목록으로 두 배지·선택 메뉴·설정·추천·좁은 사이드바 검사)
- **단어 본문 표시 검사**: `python -m pytest tests/test_vocab_highlight.py` (조사·제외 영역·본문 변경·표시 방법, 설치된 Chrome 사용)
- **형광펜 캐시·대화 전환 검사**: `python tests/test_highlights.py -v` (설치된 Chrome 사용)
- **성능 비교**: `python tests/benchmark.py --baseline <비교할-커밋>`
  - 임시 폴더의 메모 1,000개와 Chrome의 가짜 대화 200문단으로 이전 커밋과 현재 작업 사본을 비교합니다.
    실제 메모·설정·Codex 앱은 사용하지 않습니다. 각 경로를 미리 읽은 뒤 5개 표본의 중앙값을 출력합니다.
    캐시가 유효한 반복 작업의 측정이며 첫 읽기·본문 변경 후 재계산 시간은 포함하지 않습니다.
- **일괄 라벨 저장 성능 비교**: `node tests/benchmark_assignments.cjs <비교할-이전-소스-폴더>`.
  임시 데이터의 대화 100개와 기존 호스트 별칭 100개를 바꿔, 워밍업 후 5회 중앙값과 파일 교체 횟수를 비교합니다.
  같은 대화의 별칭과 여러 대화의 배정을 모두 검증한 뒤 한 번에 저장하며, 변경이 없는 배정은 파일 쓰기를 생략합니다.
  진행 상태·카테고리의 독립성, 알 수 없는 기존 라벨, 추가 메타데이터는 보존합니다.

연결 종료·전송 실패·제한 시간 초과 시 CDP와 백엔드의 대기 항목을 정리합니다.
App Server 연결 풀은 명시적으로 닫은 뒤 새 작업을 시작하지 않으며, 유휴 종료·일반 오류 후에는 다시 연결할 수 있습니다.
요약을 대기 중 취소하면 새 모델 턴을 시작하지 않습니다. 로컬 응답 대기를 해제하는 것만으로 이미 전달된 백엔드 작업이 취소되는 것은 아닙니다.

바로 실행 목록은 파일 저장 성공 뒤 메모리 상태를 바꾸고, 내용이 같으면 불필요한 저장을 생략합니다.
업데이터는 Git worktree도 개발용 사본으로 보호하고, 압축의 필수 파일과 변경된 의존성 설치를 확인한 뒤 프로그램 파일을 교체합니다.
프로그램 파일 복사 전체에 대한 자동 롤백 기능은 포함하지 않습니다.

단어 강조와 마우스 카드는 최신 읽기·현재 위치에 해당하는 응답만 반영하고 종료된 화면의 지연 작업을 정리합니다.
단어 강조 색상만 바뀌면 기존 범위 목록을 다시 만들지 않습니다.
설정창이 열린 동안에는 설정 스크립트 교체를 미뤄 작성 중 내용을 유지합니다.
정리 기능이 없는 이전 설정 스크립트(v4)가 이미 주입된 창은 다음 새 창 실행부터 새 버전이 적용됩니다.
독립 메모 팝업도 바깥 클릭·Escape·다른 메모 열기·재주입 전에 미저장 변경의 폐기를 확인합니다.
폐기를 취소하면 입력 내용·원문 위치·커서와 포커스를 유지하고, 브리지 전송이 즉시 실패해도 작성 내용이 남습니다.

메모 저장소는 파일의 수정 시각(나노초)·크기·파일 식별자가 같으면 읽은 내용을 재사용합니다.
읽기 결과를 수정해도 저장된 메모는 바뀌지 않으며, 실제 내용이 바뀐 경우에만 JSON·Markdown을 저장합니다.
같은 내용으로 저장해도 화면의 편집 상태가 종료되도록 기존 변경 알림은 유지합니다.
형광펜과 선택 위치 계산은 본문 글자 색인을 공유하고, 본문 변경 시 다시 만듭니다.
대화 선택 속성이 바뀌면 해당 대화의 형광펜을 다시 계산하며, 단어장 창·툴바·메모 창은 색인에서 제외합니다.

## Windows 설치 상세

새 공개 저장소의 설치용 Release는 아직 게시 전입니다. 아래 다운로드와 설치 프로그램은 첫 Windows Release가 게시된 뒤 사용합니다.

1. [최신 릴리스](https://github.com/plushg0724-web/codex-memo-public/releases/latest)에서 **`CodexMemo-Setup.cmd`** 를 받아 더블클릭합니다.
   - 또는 PowerShell 에서:
     `powershell -ExecutionPolicy Bypass -c "iwr https://raw.githubusercontent.com/plushg0724-web/codex-memo-public/main/install.ps1 -OutFile $env:TEMP\cm.ps1 -UseBasicParsing; & $env:TEMP\cm.ps1"`
2. 설치 프로그램이 알아서 합니다.
   - Python·Node.js 가 없으면 winget 으로 설치
   - 최신 릴리스의 **`CodexMemo-Windows.zip`** 을 받아 `%LOCALAPPDATA%\Programs\CodexMemo` 에 설치하고 필요한 Python 패키지 설치
   - ZIP에 포함된 `dist/node/*.cjs`를 바로 실행하므로 사용자 PC에서 TypeScript를 컴파일할 필요 없음
   - 바탕화면·시작 메뉴에 **Codex 메모** 바로가기를 만들고 실행
3. 트레이 아이콘이 나타나면 Codex 가 메모 모드로 다시 시작됩니다(진행 중인 Codex 작업이 끊길 수 있어 먼저 묻습니다).
   Codex 를 업데이트하거나 일반 방식으로 다시 열어 메모 기능 없이 켜지면, 약 10초 뒤 메모 모드로 다시 시작할지 자동으로 묻습니다.

필요한 것: 설치한 호스트 앱의 시스템 요구사항을 충족하는 Windows, Microsoft Store의 OpenAI Codex. Google 시트 기능을 쓰려면 ChatGPT 에 Google Drive 가 연결돼 있어야 합니다.

미리 받은 ZIP으로 설치하려면 릴리스의 **`CodexMemo-Windows.zip`** 을 풀고 안의 **`CodexMemo-Install.cmd`** 를 실행합니다.
같은 폴더의 빌드된 프로그램을 설치하며, Python·Node.js와 필요한 Python 패키지는 설치 프로그램이 준비합니다.
GitHub가 자동으로 제공하는 **Source code (zip)** 은 개발용 소스이므로, 실행 전에 아래 개발 절차로 빌드해야 합니다.

## Windows 업데이트

- 시작할 때와 하루에 한 번 새 버전을 확인하고, 있으면 알림을 띄웁니다.
- 트레이의 **업데이트 설치 (vX.Y.Z)** 를 누르면 받아서 바꾸고 다시 시작합니다. 직접 확인하려면 **업데이트 확인**.
- 설치 프로그램을 다시 실행해도 최신 버전으로 바뀝니다.
- 메모·설정·라벨·단어장은 `%LOCALAPPDATA%\CodexMemo` 에 있어 업데이트해도 그대로입니다.
  (예전에 Codex Labels 를 쓰던 PC 는 그 라벨·단어장 데이터를 그대로 씁니다.)

## Windows 릴리스 패키징

1. `VERSION` 의 숫자를 올리고 `npm ci`로 개발 의존성을 설치합니다.
2. `npm run check`로 strict TypeScript 백엔드를 빌드하고 화면 JS 타입 검사까지 완료합니다.
3. `python scripts/package-release.py --output release/CodexMemo-Windows.zip`으로 빌드 결과를 포함한 설치용 ZIP을 만듭니다.
4. 변경을 커밋·푸시한 뒤 두 파일을 함께 올립니다.

   ```powershell
   gh release create v<VERSION> "CodexMemo-Setup.cmd" "release/CodexMemo-Windows.zip" --title "v<VERSION>" --notes "바뀐 점"
   ```

설치·업데이트에는 **`CodexMemo-Setup.cmd`와 `CodexMemo-Windows.zip` 두 릴리스 자산이 모두 필요합니다.**
소스까지 포함한 ZIP이 필요하면 패키징 명령에 `--include-source`를 붙입니다.
패키징은 이미 생성된 `dist/node`를 사용하므로, TypeScript를 수정한 뒤에는 먼저 `npm run build` 또는 `npm run check`를 실행해야 합니다.

사용자 PC 는 `releases/latest` 를 보고 업데이트합니다. git 으로 받은 개발용 폴더는 덮어쓰지 않으며 `git pull` 로 업데이트합니다.
