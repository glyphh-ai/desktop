// keytap.swift — the yo OS overlay (protocol v3). Intercepts ".yo …" (and the other
// dot-commands) typed in ANY text field anywhere, keys off Enter, erases the typed
// command, and shows an INLINE braille spinner at the caret while the Electron main
// process works. No HUD window, no words — a single rotating braille glyph typed in
// place (type glyph; each tick backspace 1 + type next glyph). Electron then replies
// over stdin telling us what to do: paste a result inline, paste an ephemeral
// confirmation and auto-delete it, do nothing (a slide-out panel is shown), or paste
// back text the panel produced.
//
// Protocol v3 (newline-delimited JSON):
//   helper -> main (stdout):  {"type":"run","trigger":".yo","query":"…","x":<int>,"y":<int>,"app":"<bundleId>"}
//   main -> helper (stdin):   {"type":"result","text":"…"}                  → clear spinner, paste text
//                             {"type":"ephemeral","text":"…","ms":2000}     → clear spinner, paste, then delete after ms
//                             {"type":"done"}                               → clear spinner, nothing
//                             {"type":"panel"}                              → clear spinner, nothing (Electron shows panel)
//                             {"type":"paste","text":"…","app":"<bundleId>"}→ re-activate app + paste (panel's Insert)
//
// Coords are Quartz / global top-left (what caretRect returns). x = caret minX,
// y = caret maxY. stdout is RESERVED for the protocol — never print to it.
// Debug -> /tmp/yo-keytap.log. Built by `npm run build:overlay`. Needs Accessibility.
import Cocoa
import ApplicationServices

// Active triggers come from YO_OVERLAY_TRIGGERS (comma-separated), set by the
// Electron main process from a flag. Default: only ".drip" until the agent
// overlay (.yo/.sup/.dip) is ready to ship.
let TRIGGERS: [String] = {
    let raw = ProcessInfo.processInfo.environment["YO_OVERLAY_TRIGGERS"] ?? ".drip"
    let list = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    return list.isEmpty ? [".drip"] : list
}()
let MAGIC: Int64 = 0x796F   // 'yo' — stamped on our own synthetic events so we ignore them

// Single-glyph braille spinner frames. We only ever show ONE glyph at a time.
let TRAIL_CHARS = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]

var line = ""
var tapRef: CFMachPort?
let esrc = CGEventSource(stateID: .combinedSessionState)

let LOG = "/tmp/yo-keytap.log"
func log(_ s: String) {
    let l = s + "\n"
    if let h = FileHandle(forWritingAtPath: LOG) { h.seekToEndOfFile(); h.write(l.data(using: .utf8)!); h.closeFile() }
    else { try? l.write(toFile: LOG, atomically: true, encoding: .utf8) }
}

func mark(_ e: CGEvent?) { e?.setIntegerValueField(.eventSourceUserData, value: MAGIC) }

func backspaceN(_ n: Int) {
    guard n > 0 else { return }
    for _ in 0..<n {
        let d = CGEvent(keyboardEventSource: esrc, virtualKey: 51, keyDown: true); mark(d); d?.post(tap: .cgSessionEventTap)
        let u = CGEvent(keyboardEventSource: esrc, virtualKey: 51, keyDown: false); mark(u); u?.post(tap: .cgSessionEventTap)
    }
}

func pasteText(_ s: String) {
    let pb = NSPasteboard.general
    let saved = pb.string(forType: .string)
    pb.clearContents(); pb.setString(s, forType: .string)
    let down = CGEvent(keyboardEventSource: esrc, virtualKey: 9, keyDown: true); down?.flags = .maskCommand; mark(down)
    let up   = CGEvent(keyboardEventSource: esrc, virtualKey: 9, keyDown: false); up?.flags = .maskCommand; mark(up)
    down?.post(tap: .cgSessionEventTap); up?.post(tap: .cgSessionEventTap)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        pb.clearContents(); if let saved = saved { pb.setString(saved, forType: .string) }
    }
}

// Type a literal string at the caret via the pasteboard (used for the spinner glyph).
// Synchronous-ish paste: restore clipboard shortly after.
func typeText(_ s: String) {
    guard !s.isEmpty else { return }
    pasteText(s)
}

// ── inline braille spinner ──────────────────────────────────────────────────
// We type exactly ONE glyph and, every tick, backspace 1 + type the next glyph.
// glyphCount tracks how many spinner graphemes are currently on screen (0 or 1)
// so a reply can erase the spinner before doing its own thing.
var spinnerTimer: Timer?
var spinnerFrame = 0
var glyphCount = 0

func startSpinner() {
    stopSpinner()   // defensive: never stack spinners
    spinnerFrame = 0
    typeText(TRAIL_CHARS[spinnerFrame])
    glyphCount = 1
    // Give the first glyph's paste time to land before ticking.
    let t = Timer(timeInterval: 0.1, repeats: true) { _ in
        spinnerFrame = (spinnerFrame + 1) % TRAIL_CHARS.count
        backspaceN(1)
        typeText(TRAIL_CHARS[spinnerFrame])
        glyphCount = 1
    }
    spinnerTimer = t
    RunLoop.main.add(t, forMode: .common)
}

func stopSpinner() {
    spinnerTimer?.invalidate()
    spinnerTimer = nil
    if glyphCount > 0 { backspaceN(glyphCount); glyphCount = 0 }
}

// ── geometry: where the caret is (Quartz top-left / global coords) ──
func caretRect() -> CGRect? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var focused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
          CFGetTypeID(focused!) == AXUIElementGetTypeID() else { return nil }
    let elem = focused as! AXUIElement
    var rangeVal: CFTypeRef?
    guard AXUIElementCopyAttributeValue(elem, kAXSelectedTextRangeAttribute as CFString, &rangeVal) == .success else { return nil }
    var range = CFRange()
    AXValueGetValue(rangeVal as! AXValue, .cfRange, &range)
    var caret = CFRange(location: range.location, length: max(range.length, 1))
    guard let crv = AXValueCreate(.cfRange, &caret) else { return nil }
    var boundsVal: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(elem, kAXBoundsForRangeParameterizedAttribute as CFString, crv, &boundsVal) == .success,
          CFGetTypeID(boundsVal!) == AXValueGetTypeID() else { return nil }
    var r = CGRect.zero
    AXValueGetValue(boundsVal as! AXValue, .cgRect, &r)
    if r.height < 1 || r.width.isNaN || r.height.isNaN { return nil }
    return r
}
// Frame of the focused window of the frontmost app (fallback anchor).
func focusedWindowRect() -> CGRect? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var winVal: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &winVal) == .success,
          CFGetTypeID(winVal!) == AXUIElementGetTypeID() else { return nil }
    let win = winVal as! AXUIElement
    var pv: CFTypeRef?, sv: CFTypeRef?
    guard AXUIElementCopyAttributeValue(win, kAXPositionAttribute as CFString, &pv) == .success,
          AXUIElementCopyAttributeValue(win, kAXSizeAttribute as CFString, &sv) == .success else { return nil }
    var pos = CGPoint.zero, size = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &pos); AXValueGetValue(sv as! AXValue, .cgSize, &size)
    if size.width < 1 || size.height < 1 { return nil }
    return CGRect(origin: pos, size: size)
}

// ── stdio bridge to the Electron main process ──
// Emit a "run" event: caret screen coords (Quartz top-left) + frontmost bundle id.
func sendRun(_ trigger: String, _ query: String) {
    var x = 0, y = 0
    if let c = caretRect() {                 // caret minX / maxY (bottom of the line)
        x = Int(c.minX); y = Int(c.maxY)
    } else if let r = focusedWindowRect() {  // fallback: focused window origin
        x = Int(r.minX); y = Int(r.minY)
    }
    let bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
    let obj: [String: Any] = ["type": "run", "trigger": trigger, "query": query,
                              "x": x, "y": y, "app": bundleId]
    if let data = try? JSONSerialization.data(withJSONObject: obj), var s = String(data: data, encoding: .utf8) {
        s += "\n"
        FileHandle.standardOutput.write(s.data(using: .utf8)!)
    }
    log("run \(trigger) \(query) @(\(x),\(y)) app=\(bundleId)")
}

// Re-activate the origin app by bundle id, then paste the chosen text into its field.
func activateAndPaste(app bundleId: String, text: String) {
    if !bundleId.isEmpty {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
        if let target = running.first {
            target.activate(options: [])
        } else {
            let src = "tell application id \"\(bundleId)\" to activate"
            if let s = NSAppleScript(source: src) { var err: NSDictionary?; s.executeAndReturnError(&err) }
        }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
        if !text.isEmpty { pasteText(text) }
        log("paste len=\(text.count) app=\(bundleId)")
    }
}

func handle(_ event: CGEvent) -> Bool {   // true = swallow
    if event.getIntegerValueField(.eventSourceUserData) == MAGIC { return false }
    // Only act when yo is NOT frontmost (the helper's parent pid is the yo app).
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == getppid() { return false }
    let keycode = event.getIntegerValueField(.keyboardEventKeycode)

    if keycode == 36 || keycode == 76 {   // Enter / Return
        let cmd = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let n = line.count
        if let trig = TRIGGERS.first(where: { cmd == $0 || cmd.hasPrefix($0 + " ") }) {
            let query = String(cmd.dropFirst(trig.count)).trimmingCharacters(in: .whitespacesAndNewlines)
            line = ""
            log("match \(trig)")
            DispatchQueue.main.async {
                // Erase the typed command, report it to Electron, then start the
                // inline spinner at the caret while Electron works.
                backspaceN(n)
                sendRun(trig, query)
                startSpinner()
            }
            return true   // swallow the Enter
        }
        line = ""; return false
    }
    if keycode == 53 { line = ""; return false }                              // Esc
    if keycode == 51 { if !line.isEmpty { line.removeLast() }; return false }  // user backspace
    if (123...126).contains(keycode) { line = ""; return false }              // arrows

    let flags = event.flags
    if flags.contains(.maskCommand) || flags.contains(.maskControl) || flags.contains(.maskAlternate) { return false }

    var len = 0; var chars = [UniChar](repeating: 0, count: 4)
    event.keyboardGetUnicodeString(maxStringLength: 4, actualStringLength: &len, unicodeString: &chars)
    let s = len > 0 ? String(utf16CodeUnits: chars, count: len) : ""
    if !s.isEmpty { line += s; if line.count > 200 { line = String(line.suffix(200)) } }
    return false
}

// Read newline-delimited JSON messages from Electron on a background thread.
// Every reply first stops the inline spinner, then does its thing.
func startStdinReader() {
    DispatchQueue.global(qos: .userInitiated).async {
        while let raw = readLine(strippingNewline: true) {
            guard let data = raw.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let type = obj["type"] as? String ?? ""
            switch type {
            case "result":
                let text = obj["text"] as? String ?? ""
                DispatchQueue.main.async {
                    stopSpinner()
                    if !text.isEmpty { pasteText(text) }
                    log("result len=\(text.count)")
                }
            case "ephemeral":
                let text = obj["text"] as? String ?? ""
                let ms = obj["ms"] as? Int ?? 2000
                DispatchQueue.main.async {
                    stopSpinner()
                    pasteText(text)
                    // Delete the confirmation after `ms` — count graphemes, not UTF-16.
                    let count = text.count
                    DispatchQueue.main.asyncAfter(deadline: .now() + Double(ms) / 1000.0) {
                        backspaceN(count)
                    }
                    log("ephemeral len=\(text.count) ms=\(ms)")
                }
            case "done":
                DispatchQueue.main.async { stopSpinner(); log("done") }
            case "panel":
                DispatchQueue.main.async { stopSpinner(); log("panel") }
            case "paste":
                let text = obj["text"] as? String ?? ""
                let app = obj["app"] as? String ?? ""
                DispatchQueue.main.async { stopSpinner(); activateAndPaste(app: app, text: text) }
            default:
                break
            }
        }
        // stdin closed → parent gone; exit.
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
    eventsOfInterest: mask,
    callback: { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let t = tapRef { CGEvent.tapEnable(tap: t, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        return handle(event) ? nil : Unmanaged.passUnretained(event)
    }, userInfo: nil
) else {
    FileHandle.standardError.write("yo-overlay: could not create event tap — grant Accessibility permission.\n".data(using: .utf8)!)
    exit(1)
}
tapRef = tap
let runSrc = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetMain(), runSrc, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
startStdinReader()
FileHandle.standardError.write("yo-overlay: listening (.yo … then Enter, anywhere)\n".data(using: .utf8)!)
app.run()
