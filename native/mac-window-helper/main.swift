/**
 * glyphh-window-helper — long-running macOS window-control helper.
 *
 * Speaks NDJSON over stdio: one JSON request per line in, one JSON response
 * per line out ({"id":N,...} → {"id":N,"ok":true,"data":...} | {"id":N,
 * "ok":false,"error":"..."}). Spawned once by Glyphh's Electron main process
 * (src/main/native-windows/mac-helper-backend.ts) and kept alive — every
 * window operation is an in-process API call (~1-5ms), replacing the old
 * per-call `osascript` + System Events full enumeration (~seconds).
 *
 * Mechanisms (the same stack yabai / Rectangle / AeroSpace use):
 *   - enumeration  → CGWindowListCopyWindowInfo (no permission needed)
 *   - manipulation → AXUIElement position/size/minimize/raise (needs the
 *     Accessibility permission Glyphh already requests; TCC attributes this
 *     helper to the parent .app, so the existing grant covers it)
 *   - titles       → kAXTitleAttribute (NOT kCGWindowName, which would drag
 *     in the Screen Recording permission)
 *
 * CGWindowID ↔ AXUIElement mapping uses the private _AXUIElementGetWindow —
 * fine under Developer ID notarization (AeroSpace ships it signed), only a
 * blocker for Mac App Store distribution.
 *
 * AX handles are cached per window key ("pid:cgid") because CGWindowList is
 * on-screen-only: a minimized window disappears from enumeration, so restore
 * must go through the cached handle.
 *
 * Build: scripts/build-mac-helper.sh (universal arm64+x86_64 via swiftc+lipo).
 */

import AppKit
import ApplicationServices
import Foundation

// Private API: resolve the CGWindowID behind an AX window element.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ identifier: inout CGWindowID) -> AXError

// Private SkyLight APIs (the yabai focus mechanism): public activation is
// "cooperative" on modern macOS and refuses to move focus away from the app
// the user is actively using. _SLPSSetFrontProcessWithOptions with
// kCPSUserGenerated makes WindowServer treat the switch as user-generated,
// and the two SLPSPostEventRecordTo packets designate the key window.
//
// These live in the private SkyLight framework — resolved at runtime via
// dlsym (no link-time dependency on a private framework, so the build stays
// clean and a future symbol rename degrades gracefully to the AX fallback).
typealias GetProcessForPIDFn = @convention(c) (pid_t, UnsafeMutablePointer<ProcessSerialNumber>) -> OSStatus
typealias SetFrontFn = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>, UInt32, UInt32) -> CGError
typealias PostEventFn = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>, UnsafeMutablePointer<UInt8>) -> CGError

let kCPSUserGenerated: UInt32 = 0x200

let skyLight: (get: GetProcessForPIDFn, setFront: SetFrontFn, post: PostEventFn)? = {
  // The SLPS symbols are already in-process via AppKit's SkyLight dependency;
  // GetProcessForPID (deprecated Process Manager) only lives in Carbon, which
  // isn't loaded by default — dlopen it explicitly.
  let RTLD_DEFAULT = UnsafeMutableRawPointer(bitPattern: -2)
  guard let carbon = dlopen("/System/Library/Frameworks/Carbon.framework/Carbon", RTLD_LAZY),
        let g = dlsym(carbon, "GetProcessForPID"),
        let s = dlsym(RTLD_DEFAULT, "_SLPSSetFrontProcessWithOptions"),
        let p = dlsym(RTLD_DEFAULT, "SLPSPostEventRecordTo") else { return nil }
  return (unsafeBitCast(g, to: GetProcessForPIDFn.self),
          unsafeBitCast(s, to: SetFrontFn.self),
          unsafeBitCast(p, to: PostEventFn.self))
}()

/// Focus a specific window across apps the way yabai does. Returns true when
/// the SkyLight path was applied (best-effort — no error surface beyond CGError).
func skyLightFocus(pid: pid_t, wid: CGWindowID) -> Bool {
  guard let sl = skyLight else { return false }
  var psn = ProcessSerialNumber()
  guard sl.get(pid, &psn) == noErr else { return false }
  guard sl.setFront(&psn, UInt32(wid), kCPSUserGenerated) == .success else { return false }
  // "Make key window" packets (see yabai window_manager_make_key_window).
  var bytes = [UInt8](repeating: 0, count: 0xf8)
  bytes[0x04] = 0xf8
  bytes[0x3a] = 0x10
  var w = UInt32(wid)
  withUnsafeBytes(of: &w) { raw in
    for i in 0..<4 { bytes[0x3c + i] = raw[i] }
  }
  bytes[0x08] = 0x01
  _ = bytes.withUnsafeMutableBufferPointer { sl.post(&psn, $0.baseAddress!) }
  bytes[0x08] = 0x02
  _ = bytes.withUnsafeMutableBufferPointer { sl.post(&psn, $0.baseAddress!) }
  return true
}

// ── AX handle cache ─────────────────────────────────────────────────────

/// "pid:cgid" → AX window element. Populated on every list; consulted by
/// bounds/minimize/restore so operations survive the window leaving the
/// on-screen CGWindowList (minimized / other Space).
var axCache: [String: AXUIElement] = [:]
/// pid → AX application element (cheap to keep; invalid ones just error).
var axApps: [pid_t: AXUIElement] = [:]

func axApp(_ pid: pid_t) -> AXUIElement {
  if let cached = axApps[pid] { return cached }
  let el = AXUIElementCreateApplication(pid)
  axApps[pid] = el
  return el
}

/// All AX windows of a pid, keyed by CGWindowID.
func axWindows(of pid: pid_t) -> [CGWindowID: AXUIElement] {
  var out: [CGWindowID: AXUIElement] = [:]
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(axApp(pid), kAXWindowsAttribute as CFString, &value) == .success,
        let list = value as? [AXUIElement] else { return out }
  for el in list {
    var wid: CGWindowID = 0
    if _AXUIElementGetWindow(el, &wid) == .success, wid != 0 {
      out[wid] = el
      axCache["\(pid):\(wid)"] = el
    }
  }
  return out
}

/// Resolve a window key ("pid:cgid") to its AX element — cache first, then a
/// fresh scan of the pid's windows (covers post-restart / evicted entries).
func resolveWindow(_ key: String) -> AXUIElement? {
  if let cached = axCache[key] { return cached }
  let parts = key.split(separator: ":")
  guard parts.count == 2, let pid = pid_t(parts[0]), let cgid = CGWindowID(parts[1]) else { return nil }
  return axWindows(of: pid)[cgid]
}

func axTitle(_ el: AXUIElement) -> String {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &value) == .success,
        let s = value as? String else { return "" }
  return s
}

func axSetBounds(_ el: AXUIElement, x: Double, y: Double, width: Double, height: Double) -> AXError {
  var origin = CGPoint(x: x, y: y)
  var size = CGSize(width: width, height: height)
  guard let posVal = AXValueCreate(.cgPoint, &origin), let sizeVal = AXValueCreate(.cgSize, &size) else {
    return .failure
  }
  // Position first, then size — then position again: some apps clamp their
  // size at the old position (e.g. when the target rect crosses displays).
  let posErr = AXUIElementSetAttributeValue(el, kAXPositionAttribute as CFString, posVal)
  let sizeErr = AXUIElementSetAttributeValue(el, kAXSizeAttribute as CFString, sizeVal)
  _ = AXUIElementSetAttributeValue(el, kAXPositionAttribute as CFString, posVal)
  return posErr == .success && sizeErr == .success ? .success : .failure
}

func axSetMinimized(_ el: AXUIElement, _ minimized: Bool) -> AXError {
  AXUIElementSetAttributeValue(el, kAXMinimizedAttribute as CFString, minimized as CFTypeRef)
}

// ── enumeration ─────────────────────────────────────────────────────────

struct WinInfo {
  let pid: pid_t
  let cgid: CGWindowID
  let proc: String
  let bounds: CGRect
}

/// On-screen, layer-0 (normal) windows via CGWindowList — millisecond-fast,
/// no permission required.
func cgList() -> [WinInfo] {
  guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    return []
  }
  var out: [WinInfo] = []
  for w in raw {
    guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
          let pid = w[kCGWindowOwnerPID as String] as? pid_t,
          let cgid = w[kCGWindowNumber as String] as? CGWindowID,
          let boundsDict = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
    let rect = CGRect(
      x: boundsDict["X"] ?? 0, y: boundsDict["Y"] ?? 0,
      width: boundsDict["Width"] ?? 0, height: boundsDict["Height"] ?? 0)
    if rect.width < 40 || rect.height < 40 { continue } // ignore slivers/overlays
    let proc = (w[kCGWindowOwnerName as String] as? String) ?? ""
    out.append(WinInfo(pid: pid, cgid: cgid, proc: proc, bounds: rect))
  }
  return out
}

/// Full window list with AX-sourced titles + refreshed AX cache. Titles are
/// fetched per unique pid (one kAXWindowsAttribute copy per app).
func listWindows() -> [[String: Any]] {
  let wins = cgList()
  var axByPid: [pid_t: [CGWindowID: AXUIElement]] = [:]
  let trusted = AXIsProcessTrusted()
  var out: [[String: Any]] = []
  for w in wins {
    var title = ""
    if trusted {
      if axByPid[w.pid] == nil { axByPid[w.pid] = axWindows(of: w.pid) }
      if let el = axByPid[w.pid]?[w.cgid] { title = axTitle(el) }
    }
    out.append([
      "id": "\(w.pid):\(w.cgid)",
      "pid": Int(w.pid),
      "proc": w.proc,
      "title": title,
      "x": Int(w.bounds.origin.x),
      "y": Int(w.bounds.origin.y),
      "width": Int(w.bounds.width),
      "height": Int(w.bounds.height),
    ])
  }
  return out
}

// ── command handlers ────────────────────────────────────────────────────

func handle(_ req: [String: Any]) -> (ok: Bool, data: Any?, error: String?) {
  guard let cmd = req["cmd"] as? String else { return (false, nil, "missing cmd") }

  switch cmd {

  case "perms":
    let prompt = (req["prompt"] as? Bool) ?? false
    let trusted: Bool
    if prompt {
      let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      trusted = AXIsProcessTrustedWithOptions(opts)
    } else {
      trusted = AXIsProcessTrusted()
    }
    return (true, ["trusted": trusted], nil)

  case "list":
    return (true, listWindows(), nil)

  // Batch move/resize: [{win:"pid:cgid", x, y, width, height}]
  case "bounds":
    guard let items = req["items"] as? [[String: Any]] else { return (false, nil, "missing items") }
    var applied = 0
    for item in items {
      guard let key = item["win"] as? String,
            let x = num(item["x"]), let y = num(item["y"]),
            let width = num(item["width"]), let height = num(item["height"]),
            let el = resolveWindow(key) else { continue }
      // Unminimize first — a minimized window silently ignores bounds.
      _ = axSetMinimized(el, false)
      if axSetBounds(el, x: x, y: y, width: width, height: height) == .success { applied += 1 }
    }
    return (true, ["applied": applied], nil)

  case "minimize":
    guard let key = req["win"] as? String, let el = resolveWindow(key) else { return (false, nil, "window not found") }
    return axSetMinimized(el, true) == .success ? (true, nil, nil) : (false, nil, "AX minimize failed")

  case "restore":
    guard let key = req["win"] as? String, let el = resolveWindow(key) else { return (false, nil, "window not found") }
    return axSetMinimized(el, false) == .success ? (true, nil, nil) : (false, nil, "AX restore failed")

  // Minimize a specific set of windows (grid overflow): {wins: ["pid:cgid"]}
  case "minimizeWins":
    guard let keys = req["wins"] as? [String] else { return (false, nil, "missing wins") }
    var n = 0
    for key in keys {
      if let el = resolveWindow(key), axSetMinimized(el, true) == .success { n += 1 }
    }
    return (true, ["minimized": n], nil)

  // Minimize every window of every regular app.
  case "minimizeAll":
    var n = 0
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
      for (_, el) in axWindows(of: app.processIdentifier) {
        if axSetMinimized(el, true) == .success { n += 1 }
      }
    }
    return (true, ["minimized": n], nil)

  // Frontmost app's focused window.
  case "front":
    guard let app = NSWorkspace.shared.frontmostApplication else { return (false, nil, "no frontmost app") }
    let pid = app.processIdentifier
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp(pid), kAXFocusedWindowAttribute as CFString, &value) == .success else {
      return (false, nil, "no focused window")
    }
    let el = value as! AXUIElement
    var wid: CGWindowID = 0
    _ = _AXUIElementGetWindow(el, &wid)
    axCache["\(pid):\(wid)"] = el
    var posRef: CFTypeRef?, sizeRef: CFTypeRef?
    var origin = CGPoint.zero, size = CGSize.zero
    if AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success {
      AXValueGetValue(posRef as! AXValue, .cgPoint, &origin)
    }
    if AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success {
      AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
    }
    return (true, [
      "id": "\(pid):\(wid)",
      "pid": Int(pid),
      "proc": app.localizedName ?? "",
      "title": axTitle(el),
      "x": Int(origin.x), "y": Int(origin.y),
      "width": Int(size.width), "height": Int(size.height),
    ], nil)

  // Bring one SPECIFIC window to front (unminimize + make main + raise +
  // activate its app). Disambiguates apps that share a process — e.g. two
  // Glyphh Terminal configs each tracking their own window.
  case "focusWin":
    guard let key = req["win"] as? String, let el = resolveWindow(key) else { return (false, nil, "window not found") }
    let parts = key.split(separator: ":")
    guard parts.count == 2, let pid = pid_t(parts[0]), let wid = CGWindowID(parts[1]) else { return (false, nil, "bad window key") }
    // yabai's field-proven order: unminimize (only when actually minimized),
    // AX raise, then the SkyLight steal (setFront + make-key packets — these
    // work even when another app is active, where public cooperative
    // activation refuses). AX frontmost + activate only as fallback when the
    // SkyLight symbols are unavailable. Note: nothing beats live user input —
    // if the user is actively typing in another app the OS re-asserts it,
    // which is correct; the real flow steals from Glyphh's own palette.
    var minRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXMinimizedAttribute as CFString, &minRef) == .success,
       (minRef as? Bool) == true {
      _ = axSetMinimized(el, false)
    }
    let raised = AXUIElementPerformAction(el, kAXRaiseAction as CFString)
    let sky = skyLightFocus(pid: pid, wid: wid)
    var fmErr = AXError.success
    if !sky {
      fmErr = AXUIElementSetAttributeValue(axApp(pid), kAXFrontmostAttribute as CFString, true as CFTypeRef)
      NSRunningApplication(processIdentifier: pid)?.activate()
    }
    if sky || raised == .success || fmErr == .success { return (true, nil, nil) }
    return (false, nil, "focus failed (raise=\(raised.rawValue) frontmost=\(fmErr.rawValue))")

  // Bring an app to front by name (case-insensitive contains) or pid,
  // restoring its first window if minimized.
  case "focusApp":
    var target: NSRunningApplication?
    if let pid = req["pid"] as? Int {
      target = NSRunningApplication(processIdentifier: pid_t(pid))
    } else if let name = (req["name"] as? String)?.lowercased(), !name.isEmpty {
      target = NSWorkspace.shared.runningApplications.first {
        $0.activationPolicy == .regular && ($0.localizedName ?? "").lowercased().contains(name)
      }
    }
    guard let app = target else { return (false, nil, "app not found") }
    let wins = axWindows(of: app.processIdentifier)
    if let first = wins.values.first { _ = axSetMinimized(first, false) }
    _ = AXUIElementSetAttributeValue(axApp(app.processIdentifier), kAXFrontmostAttribute as CFString, true as CFTypeRef)
    app.activate(options: [.activateIgnoringOtherApps])
    return (true, ["pid": Int(app.processIdentifier)], nil)

  // Running regular apps (for the command overlay's "Running apps" section).
  case "apps":
    var out: [[String: Any]] = []
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
      out.append([
        "proc": app.localizedName ?? "",
        "path": app.bundleURL?.path ?? "",
        "pid": Int(app.processIdentifier),
      ])
    }
    return (true, out, nil)

  case "ping":
    return (true, ["pong": true, "trusted": AXIsProcessTrusted()], nil)

  default:
    return (false, nil, "unknown cmd: \(cmd)")
  }
}

func num(_ v: Any?) -> Double? {
  if let d = v as? Double { return d }
  if let i = v as? Int { return Double(i) }
  return nil
}

// ── stdio loop ──────────────────────────────────────────────────────────

func respond(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
  fflush(stdout)
}

setbuf(stdout, nil)

while let line = readLine(strippingNewline: true) {
  guard !line.isEmpty else { continue }
  guard let data = line.data(using: .utf8),
        let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
    respond(["id": -1, "ok": false, "error": "bad json"])
    continue
  }
  let id = req["id"] ?? -1
  let result = handle(req)
  var res: [String: Any] = ["id": id, "ok": result.ok]
  if let d = result.data { res["data"] = d }
  if let e = result.error { res["error"] = e }
  respond(res)
}
