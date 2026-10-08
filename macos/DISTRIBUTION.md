# macOS 외부 배포 준비 기록

검토일: 2026-10-08 (한국 시간). 이 문서는 배포 준비와 실제 공개 배포를 구분한다.
현재 작업용 맥에는 유효한 코드 서명 identity가 0개다. 따라서 Developer ID로 서명하고
Apple 공증까지 완료한 배포본은 아직 없다. 현재 패키지는 지인 테스트에 사용할 수 있는
미공증 후보본이며, 첫 실행에는 사용자 확인이 필요할 수 있다.

## 지인에게 무료로 전달하는 경우

사용자의 배포 목적은 비영리·공익 목적 및 개인 지인 공유다. 소수 지인에게 미공증
DMG/ZIP과 설치 안내를 직접 전달하는 방식으로 시작할 수 있다. 개발자 인증서가 없는
앱의 첫 실행은 macOS가 차단할 수 있으며, 받는 사람이 출처와 파일을 신뢰할 때 앱별로
실행을 허용한다. [Apple 공식 안내](https://support.apple.com/ko-kr/102445)에 따라 앱 실행을
시도한 뒤 시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기를 사용한다.
회사 관리 맥에서는 정책에 따라 이 선택이 제공되지 않을 수 있다.

여러 사람에게 설치 과정이 간편한 파일을 제공하려면 Developer ID 서명·공증을 사용할 수 있다.
이를 포함한 Apple Developer Program은 연 99 USD 또는 지역별 통화 가격이다.
개인이 무료로 배포한다는 이유만으로 가입비가 면제되지는 않는다. 면제는 자격을 갖춘
비영리 법인·교육기관·정부기관 대상이다.
[멤버십 안내](https://developer.apple.com/support/compare-memberships/),
[가입비 면제 조건](https://developer.apple.com/help/account/membership/fee-waivers/).

## 배포 대상과 의존 조건

- 현재 준비한 대상은 Apple Silicon(arm64)이다. Intel 및 Universal 앱은 검증하지 않았다.
- 번들 Node 24.21.0의 Mach-O 최소 OS는 macOS **13.5**다. 지원 표기와 앱의 최소 OS를
  이에 맞춘다. 호스트 Codex/ChatGPT 앱이 요구하는 OS가 더 높으면 그 요구사항을 따른다.
- Python과 Node는 앱에 포함한다. 실행하는 사용자가 Python, Node, npm 또는 개발 도구를
  따로 설치할 필요가 없다. 빌드하는 맥에는 Swift Command Line Tools 등이 필요하다.
- `/Applications` 또는 `~/Applications`에 Codex CLI를 포함한 Codex.app 또는
  ChatGPT.app이 있어야 한다. Codex 메모 자체에 호스트 앱이나 CLI를 재배포하지 않는다.
- 실제 호스트 앱 버전에 따라 디버그 포트 실행 인자와 화면 구조가 달라질 수 있다.
  이 방식의 호환성은 해당 버전을 직접 시험해 확인한다.
- 자동 업데이트는 없다. 새 앱으로 교체해 업데이트하며 개인 데이터는 별도로 보존한다.

## 설치, 첫 실행, 종료

배포 파일을 풀거나 디스크 이미지를 열어 `Codex 메모.app`을 Applications로 복사한다.
앱을 열면 Dock 창 대신 메뉴 막대 아이콘이 생긴다. **메모 모드 시작…**을 선택하면
설치된 호스트 앱을 찾는다. 호스트가 실행 중이면 재시작 전에 사용자 확인을 받는다.
재시작은 진행 중인 Codex 작업을 중단할 수 있으므로 UI의 확인 문구를 유지한다.

호스트 앱을 정상 종료할 때 macOS 자동화 권한 확인이 표시될 수 있다. 사용자가 거부하면
호스트를 직접 종료한 뒤 다시 시작할 수 있어야 한다. 접근성/화면 녹화 권한을 필수로
요청하는 구성은 이 메뉴 앱에서 확인되지 않았다.

앱은 메모 모드에서 호스트의 `127.0.0.1:9233` 디버그 연결을 사용한다. Codex 메모를
종료하면 도우미와 연결을 닫지만 **호스트 앱의 디버그 포트까지 닫지는 않는다**.
일반 모드로 돌아가려면 Codex 메모를 종료하고 호스트 앱도 완전히 종료한 뒤 평소처럼
다시 연다. 배포 문서에서 메모 종료가 디버그 모드 종료를 뜻한다고 설명하지 않는다.

서명·공증을 완료한 릴리스는 다운로드한 원본 파일로 Gatekeeper 첫 실행을 시험한다.
사용자에게 보안 설정을 끄거나 quarantine 속성을 지우라고 안내하는 절차를 정식 설치
경로에 포함하지 않는다. ad-hoc 후보본은 공증된 릴리스로 표시하지 않는다.

## 데이터와 외부 전송

기본 저장 위치는 `~/Library/Application Support/CodexMemo`다. 앱 삭제만으로 이 폴더를
삭제하지 않는다. 업데이트 전에는 앱을 종료하고 이 폴더를 복사해 보관할 수 있다.
메모는 평문 로컬 파일로 저장되므로 앱 자체 암호화 저장소라고 설명하지 않는다.

기존 Codex Labels 데이터가 `~/Documents/ChatGPT/codexlabels/app/labels.json`에 있으면
공통 저장소가 그 위치를 재사용한다. 이 경우 해당 Labels 폴더도 백업 대상이다.
`CODEX_MEMO_DATA`와 같은 개발용 환경 변수로 지정한 경로도 기본 경로와 구분해야 한다.

Python 도우미의 로컬 제어 API는 임의의 loopback 포트와 매번 생성하는 인증 토큰을
사용한다. 토큰은 데이터 폴더의 `control.json`에 기록하며 정상 종료 시 제거한다.
릴리스에는 control.json, 개인 메모, 계정 정보, 로컬 설정, 가상환경 또는 테스트 데이터를
포함하지 않는다. 패키징은 실행 파일 목록을 기준으로 포함하고 결과를 검사한다.

AI 뜻 분석·설명은 사용자가 설치한 Codex CLI와 그 로그인 계정을 이용한다. 분석을
요청하면 선택한 글과 필요한 문맥이 해당 서비스로 전달될 수 있고 구독 사용량을 쓴다.
계정 백업을 실행하거나 자동 백업을 켜면 메모·단어장·라벨·공통 설정을 개인 Space에
저장한다. Google 시트 연결을 켜면 기존 및 새 저장 항목을 사용자의 시트로 전송한다.
시트는 추가 누적 방식이며 앱에서 수정·삭제했다고 기존 시트 행까지 바뀌지 않는다.

## 코드 서명과 공증

서명·공증 배포본을 만들려면 유효한 **Developer ID Application** 인증서와 개인 키가
빌드 머신의 Keychain에 있어야 한다. 인증서 유무는 다음 읽기 전용 명령으로 확인한다.

```sh
security find-identity -v -p codesigning
```

2026-10-08 확인 결과는 `0 valid identities found`다. 서명과 공증에 필요한 계정 자격
증명은 저장소·셸 로그·배포 파일에 넣지 않는다. notarytool용 인증 정보는 Keychain
프로필 등 지정된 비밀 저장소에서 준비한다.

출시 경로는 중첩 실행 파일과 라이브러리를 안쪽부터 Developer ID로 서명하고,
Hardened Runtime과 timestamp를 적용한 다음, 최상위 앱을 서명하는 순서다. 공증 제출이
`Accepted`로 끝난 뒤 티켓을 staple하고 실제 배포 파일을 다시 검사한다. 제출 접수나
서명 명령 완료만으로 공증 성공을 주장하지 않는다.

확인해야 할 결과:

- `codesign --verify --deep --strict --verbose=2` 통과
- 최상위 앱과 중첩 실행 코드의 Developer ID/Team ID 및 Hardened Runtime 확인
- Apple 공증 결과 `Accepted`, staple/validate 성공
- 다운로드한 배포본의 `spctl --assess --type execute --verbose=4` 통과
- 최종 ZIP/DMG와 SHA-256, 버전/빌드 번호, 런타임 목록의 일치

Apple 공식 절차: [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
[Developer ID](https://developer.apple.com/developer-id/).

서명용 인증서와 개인 키를 Keychain에 설치한 뒤 공증 인증 정보를 대화형으로 저장한다.
비밀번호나 API 키를 명령 인자, 저장소 또는 메신저에 붙여 넣지 않는다.

```sh
xcrun notarytool store-credentials "codex-memo"
```

배포 담당자가 다음 명령을 실행한다. identity는 Keychain에
표시된 실제 이름으로 바꾸며 출력 폴더는 새 경로를 사용한다.

```sh
.venv/bin/python macos/release.py \
  --app "$PWD/release/Codex 메모.app" \
  --output "$PWD/release/signed" \
  --identity "Developer ID Application: NAME (TEAMID)" \
  --notary-profile "codex-memo"
```

`release-manifest.json`에서 `distributionReady: true`와 `gatekeeper: accepted-app-and-dmg`를
확인한다. 도중에 실패하면 해당 출력 폴더는 보존되며 새 폴더로 다시 실행한다.
`--preview`는 공증 절차를 생략한 테스트 모드다. 이때 `distributionReady`는 false이며,
이 필드는 Developer ID 서명·공증·Gatekeeper 검증의 완료 여부를 표시한다.

## 라이선스와 출처 확인

번들에 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)와 `licenses/`의 원문을 포함한다.
Node, CPython, websocket-client, PyInstaller 및 수집된 OpenSSL/zstd/liblzma의 출처와
라이선스 텍스트를 기록했다. 이 목록은 실제 번들 런타임 버전이 바뀌면 함께 갱신한다.

빌드 경로에서는 설치된 ChatGPT.app/Codex.app 파일을 앱 안으로 복사하지 않는다.
저장소의 주입 코드와 별도로 설치된 호스트의 사용 조건은 구분한다.

## 릴리스 전 검증 상태

기존 포팅 작업에서 단위/회귀 테스트, 로컬 앱 시작·종료, 호스트 화면 연결과 보관함 열기를
확인했다. 배포 패키지를 다시 만든 뒤에는 그 **최종 파일**로 다음 항목을 기록한다.

- 임시 데이터 폴더를 사용하는 native smoke test와 도우미/Node 종료
- `.app` 내 아키텍처와 최소 OS, 외부 개발 경로에 의존하는 dylib 유무
- 개인 데이터·토큰·개발 가상환경·호스트 앱 코드가 포함되지 않았는지
- ZIP 또는 DMG를 통한 설치와 메모 보관함 열기, 메모 저장 후 앱 재실행
- 새 macOS 사용자 또는 별도 맥에서 개발 도구 없이 첫 실행
- 서명한 최종 결과물의 자동화 권한 허용/거부 처리
- 지원 최소 OS에서 실행; Intel을 표방한다면 Intel에서도 별도 검증

현재 별도 맥/깨끗한 계정, macOS 13.5, Intel, 실제 AI 생성, 계정 백업·복원 및 Google 시트
쓰기의 전체 동작은 검증 완료로 표시하지 않는다. Windows의 BAT/CMD/PS1/EXE/LNK 바로
실행 관리와 Ctrl+Alt+M 전역 단축키는 macOS 배포 기능에 포함하지 않는다.

2026-10-08 공개용 소스에서 준비한 arm64 후보본 `1.12.3-mac.3` / 빌드 `1120303`의 확인 결과:

- npm 타입·빌드 검사 통과, Node 테스트 202개 통과
- macOS에서 실행 가능한 core entry point 9종 통과; Windows 전용 2종은 이유를 기록하고 제외
- 배포 스크립트 단위테스트 19개 통과
- ad-hoc 앱의 중첩 서명 검증, DMG 생성 및 무결성 검증 통과
- DMG를 읽기 전용으로 마운트하고 다른 Applications 경로에 복사한 앱의 시작·종료 통과
- 임시 데이터의 권한 0700, 제어 토큰 파일의 종료 후 제거, 프레임워크 링크 보존 확인
- 별도 데이터와 예약한 미사용 디버그 포트에서 native/helper/Node IPC 확인

이 결과는 로컬 개발 후보본 검증이다. Developer ID 서명, 실제 Apple 공증, 다운로드 후
Gatekeeper 첫 실행 검증은 아직 수행하지 않았다.

배포 담당자는 서명·공증 여부, 지원 OS의 실제 실행 결과, 다운로드
접근 범위가 정리된 시점에 공개 릴리스 여부를 결정한다. 비공개 저장소의 릴리스 첨부물은
저장소 접근 권한 없는 사용자에게 일반 공개 다운로드 경로가 되지 않는다.
