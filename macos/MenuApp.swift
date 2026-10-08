import AppKit

final class MemoApp: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!
    var process: Process?
    let input = Pipe()
    let output = Pipe()
    var buffer = Data()
    var pending: [Int: (Any?) -> Void] = [:]
    var sequence = 0
    var connected = false
    var running = false
    var quitting = false
    var automatic = false
    var loadedStatus = false
    var reportedFatal = false
    let smoke = CommandLine.arguments.contains("--smoke-test")
    var smokeReady = false
    var stateItem: NSMenuItem!
    var automaticItem: NSMenuItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "note.text", accessibilityDescription: "Codex 메모")
        item.button?.toolTip = "Codex 메모"
        let menu = NSMenu()
        stateItem = add(menu, "Codex 메모 · 연결 준비 중", nil)
        stateItem.isEnabled = false
        menu.addItem(.separator())
        add(menu, "메모 보관함 열기", #selector(memos), key: "m")
        add(menu, "단어장 열기", #selector(vocabulary), key: "v")
        add(menu, "메모 모드 시작…", #selector(start))
        add(menu, "Codex 화면 새로 고침…", #selector(reload))
        menu.addItem(.separator())
        add(menu, "지금 계정에 백업…", #selector(backup))
        add(menu, "계정 백업에서 복원…", #selector(restore))
        automaticItem = add(menu, "자동 백업", #selector(toggleAutomatic))
        add(menu, "Google 시트 연결…", #selector(sheets))
        add(menu, "다음 할 일 추천 설정…", #selector(petSettings))
        menu.addItem(.separator())
        add(menu, "메모 데이터 폴더 열기", #selector(folder))
        add(menu, "Codex 메모 정보", #selector(about))
        add(menu, "종료", #selector(quit), key: "q")
        item.menu = menu
        startHelper()
        if smoke {
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                if self.process?.isRunning == true { self.process?.terminate() }
                exit(2)
            }
        } else if !UserDefaults.standard.bool(forKey: "hasSeenWelcome") {
            UserDefaults.standard.set(true, forKey: "hasSeenWelcome")
            DispatchQueue.main.async {
                self.alert("Codex 메모 시작하기", "메뉴 막대의 메모 아이콘에서 ‘메모 모드 시작…’을 선택하세요. 실행 중인 Codex는 확인 후 다시 시작합니다.\n\n메모는 이 맥에 저장됩니다. 계정 백업과 Google 시트 전송은 메뉴에서 직접 켤 수 있습니다. 이 앱은 비공식 도우미입니다.")
            }
        }
    }

    @discardableResult func add(_ menu: NSMenu, _ title: String, _ action: Selector?, key: String = "") -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self
        menu.addItem(entry)
        return entry
    }

    func startHelper() {
        guard let resources = Bundle.main.resourceURL else { return }
        let helper = resources.appendingPathComponent("runtime/CodexMemoHelper/CodexMemoHelper")
        let child = Process()
        child.executableURL = helper
        child.standardInput = input
        child.standardOutput = output
        var environment = ProcessInfo.processInfo.environment
        environment["CODEX_MEMO_NODE"] = resources.appendingPathComponent("node/bin/node").path
        environment["PATH"] = resources.appendingPathComponent("node/bin").path + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        child.environment = environment
        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            DispatchQueue.main.async { self.consume(data) }
        }
        child.terminationHandler = { child in
            DispatchQueue.main.async {
                self.output.fileHandleForReading.readabilityHandler = nil
                if !self.quitting && !self.reportedFatal {
                    self.stateItem.title = "Codex 메모 · 도우미 종료됨"
                    self.pending.removeAll()
                    self.alert("도우미를 실행하지 못했습니다", "메모 연결 도우미가 종료됐습니다. 앱을 다시 열어 주세요.")
                    if self.smoke { exit(3) }
                }
            }
        }
        do {
            try child.run()
            process = child
        } catch {
            alert("실행 오류", error.localizedDescription)
            if smoke { exit(4) }
        }
    }

    func consume(_ data: Data) {
        buffer.append(data)
        while let end = buffer.firstIndex(of: 10) {
            let line = buffer.subdata(in: 0..<end)
            buffer.removeSubrange(0...end)
            guard let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
            if let id = message["id"] as? Int, let done = pending.removeValue(forKey: id) {
                if message["ok"] as? Bool == true { done(message["value"]) }
                else {
                    alert("요청을 완료하지 못했습니다", message["error"] as? String ?? "연결 오류")
                    if smoke { process?.terminate(); exit(7) }
                }
            } else if let event = message["event"] as? String {
                switch event {
                case "status":
                    connected = message["connected"] as? Bool ?? false
                    running = message["running"] as? Bool ?? false
                    let version = message["version"] as? String ?? ""
                    stateItem.title = "Codex 메모 v\(version) · " + (connected ? "연결됨" : "연결 대기")
                    item.button?.toolTip = stateItem.title
                    if !smoke && !loadedStatus {
                        loadedStatus = true
                        call("backupStatus") { value in
                            self.automatic = (value as? [String: Any])?["automatic"] as? Bool ?? false
                            self.automaticItem.state = self.automatic ? .on : .off
                        }
                    }
                    if smoke && !smokeReady {
                        smokeReady = true
                        call("backupStatus") { value in
                            guard value is [String: Any] else { exit(5) }
                            print("NATIVE_APP_SMOKE_OK")
                            self.quit()
                        }
                    }
                case "petSettings": petSettings()
                case "error", "fatal":
                    if event == "fatal" { reportedFatal = true; stateItem.title = "Codex 메모 · 실행 오류" }
                    if smoke { fputs("HELPER_ERROR\n", stderr); exit(6) }
                    alert("Codex 메모", message["message"] as? String ?? "연결 오류")
                default: break
                }
            }
        }
    }

    func call(_ method: String, _ args: [Any] = [], done: @escaping (Any?) -> Void = { _ in }) {
        guard process?.isRunning == true else { alert("연결 대기", "도우미가 실행 중인지 확인해 주세요."); return }
        sequence += 1
        let id = sequence
        pending[id] = done
        do {
            var data = try JSONSerialization.data(withJSONObject: ["id": id, "method": method, "args": args])
            data.append(10)
            try input.fileHandleForWriting.write(contentsOf: data)
        } catch {
            pending.removeValue(forKey: id)
            alert("연결 오류", error.localizedDescription)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 190) {
            if self.pending.removeValue(forKey: id) != nil {
                self.alert("응답 대기 시간이 지났습니다", "연결 상태를 확인하고 다시 시도해 주세요.")
            }
        }
    }

    func alert(_ title: String, _ text: String) {
        guard !smoke else { fputs((title + ": " + text + "\n"), stderr); return }
        NSApp.activate(ignoringOtherApps: true)
        let box = NSAlert()
        box.messageText = title
        box.informativeText = text
        box.runModal()
    }

    func confirm(_ title: String, _ text: String) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let box = NSAlert()
        box.messageText = title
        box.informativeText = text
        box.addButton(withTitle: "계속")
        box.addButton(withTitle: "취소")
        return box.runModal() == .alertFirstButtonReturn
    }

    @objc func memos() { call("library", ["memo"]) }
    @objc func vocabulary() { call("library", ["word"]) }
    @objc func start() {
        if connected { memos(); return }
        let text = running ? "실행 중인 Codex를 종료하고 메모 모드로 다시 엽니다. 진행 중인 작업이 끊길 수 있습니다."
                           : "Codex를 메모 연결 포트가 열린 상태로 실행합니다."
        if confirm("메모 모드를 시작할까요?", text) { call(running ? "restart" : "start") }
    }
    @objc func reload() {
        if confirm("Codex 화면을 새로 고칠까요?", "작성 중인 메시지를 먼저 저장하거나 보내 주세요.") { call("reload") }
    }
    @objc func backup() {
        if confirm("계정에 백업할까요?", "메모·단어장·라벨·공통 설정을 현재 계정의 개인 Space 페이지에 저장합니다.") {
            call("backupCreate") { _ in self.alert("백업 완료", "계정 백업에서 복원 메뉴에서 저장된 백업을 확인할 수 있습니다.") }
        }
    }
    @objc func restore() {
        call("backupList", [true]) { value in
            guard let result = value as? [String: Any], let entries = result["items"] as? [[String: Any]], !entries.isEmpty else {
                self.alert("계정 백업", "저장된 백업이 없습니다."); return
            }
            NSApp.activate(ignoringOtherApps: true)
            let box = NSAlert()
            box.messageText = "복원할 백업을 선택하세요"
            box.informativeText = "현재 데이터를 교체합니다. 교체 전 데이터는 별도로 보관합니다."
            let picker = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 420, height: 30))
            picker.addItems(withTitles: entries.map { ($0["createdAt"] as? String ?? "") + " · " + ($0["deviceId"] as? String ?? "") })
            box.accessoryView = picker
            box.addButton(withTitle: "선택한 백업 복원")
            box.addButton(withTitle: "취소")
            if box.runModal() == .alertFirstButtonReturn, let page = entries[picker.indexOfSelectedItem]["pageId"] as? String {
                self.call("backupRestore", [page]) { value in
                    let result = value as? [String: Any]
                    self.alert("복원 완료", "이전 데이터: " + (result?["localBackup"] as? String ?? "") + "\n" + (result?["warning"] as? String ?? ""))
                }
            }
        }
    }
    @objc func toggleAutomatic() {
        call("backupStatus") { value in
            let enabled = (value as? [String: Any])?["automatic"] as? Bool ?? false
            if !enabled && !self.confirm("자동 백업을 켤까요?", "데이터가 바뀌면 5분 간격으로 현재 계정의 개인 Space에 백업합니다.") { return }
            self.call("backupConfigure", [!enabled]) { _ in
                self.automatic = !enabled
                self.automaticItem.state = !enabled ? .on : .off
            }
        }
    }
    @objc func sheets() {
        call("sheetsStatus") { value in
            if let url = (value as? [String: Any])?["url"] as? String, let target = URL(string: url) {
                NSWorkspace.shared.open(target); return
            }
            if self.confirm("Google 시트를 연결할까요?", "단어·메모를 내 Google Drive 시트에 채우고 새 저장 항목을 자동으로 추가합니다. Google Drive 연결이 필요합니다.") {
                self.call("sheetsConnect") { value in
                    if let url = (value as? [String: Any])?["url"] as? String, let target = URL(string: url) { NSWorkspace.shared.open(target) }
                }
            }
        }
    }
    @objc func petSettings() {
        call("taskPetSettings") { value in
            guard let settings = value as? [String: Any] else { return }
            self.call("vocabularyModels") { value in
                let models = value as? [[String: Any]] ?? []
                NSApp.activate(ignoringOtherApps: true)
                let box = NSAlert()
                box.messageText = "다음 할 일 추천 설정"
                box.informativeText = "모델 설명을 켜면 현재 Codex 구독 사용량을 사용합니다."
                let view = NSView(frame: NSRect(x: 0, y: 0, width: 430, height: 330))
                let enabled = NSButton(checkboxWithTitle: "모델로 다음 행동 설명하기", target: nil, action: nil)
                enabled.frame = NSRect(x: 0, y: 295, width: 400, height: 24)
                enabled.state = settings["enabled"] as? Bool == true ? .on : .off
                view.addSubview(enabled)
                func label(_ text: String, _ y: CGFloat) {
                    let field = NSTextField(labelWithString: text)
                    field.frame = NSRect(x: 0, y: y, width: 130, height: 24)
                    view.addSubview(field)
                }
                label("모델", 258)
                let model = NSPopUpButton(frame: NSRect(x: 135, y: 255, width: 290, height: 28))
                let current = settings["model"] as? String ?? "gpt-6-luna"
                let ids = models.compactMap { $0["id"] as? String }
                model.addItems(withTitles: ids.contains(current) ? ids : [current] + ids)
                model.selectItem(withTitle: current)
                view.addSubview(model)
                label("추론 강도", 220)
                let effort = NSPopUpButton(frame: NSRect(x: 135, y: 217, width: 290, height: 28))
                effort.addItems(withTitles: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
                effort.selectItem(withTitle: settings["effort"] as? String ?? "high")
                view.addSubview(effort)
                label("확신도 % / 개수", 182)
                let threshold = NSTextField(string: String(Int((settings["threshold"] as? Double ?? 0.8) * 100)))
                threshold.frame = NSRect(x: 135, y: 180, width: 100, height: 25)
                let count = NSTextField(string: String(settings["count"] as? Int ?? 3))
                count.frame = NSRect(x: 250, y: 180, width: 100, height: 25)
                view.addSubview(threshold); view.addSubview(count)
                label("작성 지침", 145)
                let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 425, height: 140))
                let guide = NSTextView(frame: scroll.bounds)
                guide.isRichText = false
                guide.font = .systemFont(ofSize: 13)
                guide.string = settings["guide"] as? String ?? ""
                scroll.documentView = guide; scroll.hasVerticalScroller = true
                view.addSubview(scroll)
                box.accessoryView = view
                box.addButton(withTitle: "저장"); box.addButton(withTitle: "취소")
                if box.runModal() == .alertFirstButtonReturn {
                    self.call("taskPetSettingsSet", [["enabled": enabled.state == .on,
                        "model": model.titleOfSelectedItem ?? current, "effort": effort.titleOfSelectedItem ?? "high",
                        "threshold": threshold.doubleValue / 100, "count": count.integerValue, "guide": guide.string]])
                }
            }
        }
    }
    @objc func folder() {
        let path = ProcessInfo.processInfo.environment["CODEX_MEMO_DATA"] ?? NSHomeDirectory() + "/Library/Application Support/CodexMemo"
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }
    @objc func about() {
        alert("Codex 메모 · macOS", "메모·형광펜·단어장·대화 라벨을 더하는 비공식 도우미입니다.\n\n메뉴에서 메모 모드를 시작한 뒤 대화 글을 드래그하세요. 공통 설정은 보관함의 설정 버튼에서 변경할 수 있습니다.\n\n데이터는 이 맥에 저장됩니다. Codex 업데이트로 화면 구조가 바뀌면 연결 기능을 조정해야 할 수 있습니다.")
    }
    @objc func quit() {
        guard !quitting else { return }
        quitting = true
        if process?.isRunning == true {
            try? input.fileHandleForWriting.write(contentsOf: Data("{\"method\":\"quit\"}\n".utf8))
            try? input.fileHandleForWriting.close()
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                if self.process?.isRunning == true { self.process?.terminate() }
                NSApp.terminate(nil)
            }
            process?.terminationHandler = { _ in DispatchQueue.main.async { NSApp.terminate(nil) } }
        } else { NSApp.terminate(nil) }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if !quitting { quit(); return .terminateCancel }
        return .terminateNow
    }
}

let app = NSApplication.shared
let delegate = MemoApp()
app.delegate = delegate
app.run()
