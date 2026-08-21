/**
 * agent-dock-helper — tracking-only sibling of the retired glyphh-window-helper
 * (see 8745927b^:native/mac-window-helper/main.swift). Emits NDJSON events on
 * stdout describing the frontmost non-Glyphh window so the agent pill can
 * anchor to it. It never manipulates other apps' windows — enumeration is
 * CGWindowList only, which needs NO permission (no AX, no Screen Recording;
 * titles are deliberately not read for that reason).
 *
 * Events:
 *   {"event":"front","pid":N,"cgid":N,"proc":"Safari","x":..,"y":..,"width":..,"height":..}
 *     — emitted whenever the tracked window's identity or bounds change.
 *   {"event":"gone"}
 *     — the tracked window left the screen (closed / minimized / hidden /
 *       other Space) or its app quit.
 *
 * The pids passed via --exclude-pid (Glyphh's own Electron process) never
 * become the target: focusing the pill or the main window keeps the previous
 * attachment instead of re-anchoring to Glyphh itself.
 *
 * Exits when stdin closes (parent died) — no orphan pollers.
 */

import AppKit
import Foundation

let excludeCgids: Set<CGWindowID> = {
  var ids: Set<CGWindowID> = []
  let args = CommandLine.arguments
  var i = 1
  while i < args.count - 1 {
    if args[i] == "--exclude-cgid", let w = CGWindowID(args[i + 1]) { ids.insert(w); i += 2 } else { i += 1 }
  }
  return ids
}()

struct Front: Equatable {
  var pid: pid_t
  var cgid: CGWindowID
  var proc: String
  var x: Int
  var y: Int
  var width: Int
  var height: Int
}

/// Frontmost layer-0 window of a pid — CGWindowList is front-to-back, so the
/// first match is the app's top window. Windows too small to host the pill
/// (palettes, slivers) are skipped.
func frontWindow(of pid: pid_t) -> Front? {
  guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }
  for w in raw {
    guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
          let owner = w[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
          let cgid = w[kCGWindowNumber as String] as? CGWindowID, !excludeCgids.contains(cgid),
          let bounds = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
    let width = Int(bounds["Width"] ?? 0)
    let height = Int(bounds["Height"] ?? 0)
    if width < 320 || height < 200 { continue }
    let proc = (w[kCGWindowOwnerName as String] as? String) ?? ""
    return Front(pid: owner, cgid: cgid, proc: proc,
                 x: Int(bounds["X"] ?? 0), y: Int(bounds["Y"] ?? 0),
                 width: width, height: height)
  }
  return nil
}

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
  fflush(stdout)
}

setbuf(stdout, nil)

var targetPid: pid_t?
var last: Front?
var gone = true

let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: .milliseconds(33))
timer.setEventHandler {
  // Follow the frontmost REGULAR app, except Glyphh itself — focusing the
  // pill must not steal the anchor from the app it is attached to.
  if let app = NSWorkspace.shared.frontmostApplication, app.activationPolicy == .regular {
    targetPid = app.processIdentifier
  }
  guard let pid = targetPid,
        let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
    if !gone { gone = true; last = nil; emit(["event": "gone"]) }
    return
  }
  if let front = frontWindow(of: pid) {
    if gone || front != last {
      gone = false
      last = front
      emit([
        "event": "front", "pid": Int(front.pid), "cgid": Int(front.cgid), "proc": front.proc,
        "x": front.x, "y": front.y, "width": front.width, "height": front.height,
      ])
    }
  } else if !gone {
    gone = true
    last = nil
    emit(["event": "gone"])
  }
}
timer.resume()

DispatchQueue.global().async {
  while readLine() != nil {}
  exit(0)
}

RunLoop.main.run()
