# 모델이 Codex 메모 관리하기 (codex_memo MCP 서버)

Codex 대화에서 "이 대화들 완료로 바꿔줘", "개발 카테고리 대화를 쇼핑몰통합솔루션 프로젝트로 옮겨줘",
"방금 메모 지운 거 되돌려줘"처럼 말하면 모델이 Codex 메모의 라벨·메모·단어장·대화 위치를 직접 바꾼다.

## 구조

```
Codex 대화의 모델 ──MCP(stdio)──▶ labels/memo-mcp.cjs ──HTTP 127.0.0.1──▶ control_server.py (도우미 안)
                                                                              └▶ agent_tools.py
                                                                                   ├ 라벨·단어장: labels/backend.cjs
                                                                                   ├ 메모: memo_store.py
                                                                                   └ 옮기기·목록 필터: Codex 화면의 labels/thread-actions.js · sidebar-filter.js
```

- 실제 일은 실행 중인 **Codex 메모 도우미**가 한다. 도우미가 꺼져 있으면 도구는 "실행 중이 아닙니다"를 돌려준다.
- 제어 서버는 127.0.0.1 의 빈 포트에서만 듣고, 도우미를 켤 때마다 새로 만든 열쇠를 요구한다.
  포트·열쇠는 `%LOCALAPPDATA%\CodexMemo\control.json` 에 있다. 브라우저에서 온 요청(Origin 헤더)은 받지 않는다.
- 대화 옮기기와 목록 필터 도구는 Codex 화면이 켜져 있어야 한다(필터는 화면에 저장된다). 옮기기는 또 그 대화가 왼쪽 목록에 보여야 한다(접힌 폴더 안 대화는 펼쳐야 함).

## 도구

| 도구 | 하는 일 |
|---|---|
| `status` | 도우미·Codex 화면 연결 상태 |
| `labels_list` | 진행 상태·카테고리 라벨 종류 |
| `threads_list` | 대화 목록과 라벨(상태·카테고리·글자로 거르기) |
| `labels_assign` | 여러 대화의 진행 상태·카테고리 한꺼번에 지정(`"none"` 은 지우기) |
| `label_define` | 라벨 종류 만들기·고치기·끄기(라벨은 지울 수 없음) |
| `memos_list` · `memo_add` · `memo_update` · `memo_delete` | 메모 |
| `vocabulary_list` · `vocabulary_add` · `vocabulary_update` · `vocabulary_delete` | 단어장 |
| `move_destinations` · `threads_move` | 대화를 프로젝트·섹션으로 옮기기 |
| `filters_list` · `filter_set` · `filter_save` · `filter_rename` · `filter_delete` | 왼쪽 목록 필터(숨길 진행 상태·카테고리)와 저장한 필터 보기·쓰기·저장·이름 바꾸기·지우기 |
| `history` · `undo` | 바꾼 내역 보기·되돌리기 |

- 바꾸는 도구는 모두 `changeId` 를 돌려주고, 바꾸기 전 상태를 `%LOCALAPPDATA%\CodexMemo\agent-history.json` 에 최근 100개까지 남긴다.
  `undo` 는 changeId 를 빼면 가장 최근 변경을 되돌린다. 새로 만든 라벨은 지울 수 없어 되돌리면 꺼진다.
- `memo_delete`·`vocabulary_delete`·`filter_delete` 는 `confirm: true` 일 때만 실행한다. 모델에게는 사용자가 분명히 지우라고 했을 때만 쓰라고 안내한다.

## Codex 연결

`~/.codex/config.toml` 에 넣는다(설치 경로가 기본값일 때).

```toml
[mcp_servers.codex_memo]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Users\<사용자>\AppData\Local\Programs\CodexMemo\labels\memo-mcp.cjs']
```

연결 후 Codex 에서 새 대화를 열면 도구가 보인다. 도우미를 다시 시작해도 MCP 서버는 매 호출마다 control.json 을 다시 읽으므로 다시 연결할 필요가 없다.

## 확인

```powershell
python tests/test_agent_tools.py    # 가짜 백엔드·가짜 화면으로 도구·제어 서버·MCP 서버 전체
python tests/test_sidebar_filter.py # 화면 쪽 옮기기·위치 확인·되돌리기
```
