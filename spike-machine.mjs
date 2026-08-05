/**
 * spike-machine.mjs — SPIKE harness: the DESKTOP machine, minimal Electron shell.
 *
 * Runs the REAL desktop panel code under test — panel-host.js (Electron-CDP
 * screencast + input dispatch on a real headful BrowserWindow) and the shared
 * relay-client registry — and attaches to the spike relay on :3099 exactly the
 * way the production attach-client does: outbound WS, `hello` with capabilities,
 * execute `req` via dispatchRelayMethod, and push screencast frames UP as
 * `{t:"push",channel,data}`. The only thing this replaces vs. the shipping app
 * is the socket wiring (so it can point at :3099 with a test token instead of
 * the signed-in user's real server + token). The capture/input path is identical.
 *
 *   electron spike-machine.mjs <token>
 */
import { app } from "electron";
import WebSocket from "ws";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const TOKEN = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) || "spike-user";
const RELAY = process.env.SPIKE_RELAY || "ws://localhost:3099/ws/attach";

// Keep the harness resident after a panel window closes (the desktop app runs a
// tray/background; here we just never auto-quit).
app.on("window-all-closed", () => { /* stay alive */ });

async function main() {
  await app.whenReady();
  // Import the built main modules (the real code under test).
  const relay = await import(pathToFileURL(resolve("dist/main/relay-client.js")).href);
  const panelHost = await import(pathToFileURL(resolve("dist/main/panel-host.js")).href);

  panelHost.installPanelHost();

  let ws;
  const connect = () => {
    ws = new WebSocket(`${RELAY}?token=${encodeURIComponent(TOKEN)}`);
    ws.on("open", () => {
      console.log("[machine] attached to relay");
      ws.send(JSON.stringify({ t: "hello", app: "spike-desktop", version: "spike", capabilities: relay.listRelayMethods() }));
    });
    ws.on("message", (raw) => {
      let f; try { f = JSON.parse(String(raw)); } catch { return; }
      if (f.t !== "req" || typeof f.id !== "string" || typeof f.method !== "string") return;
      console.log("[machine] req", f.method, JSON.stringify(f.params||{}).slice(0,120));
      relay.dispatchRelayMethod(f.method, f.params ?? {})
        .then((result) => { console.log("[machine] res ok", f.method); ws.send(JSON.stringify({ t: "res", id: f.id, ok: true, result })); })
        .catch((err) => { console.log("[machine] res ERR", f.method, err?.message); ws.send(JSON.stringify({ t: "res", id: f.id, ok: false, error: err?.message ?? String(err) })); });
    });
    ws.on("close", () => { console.log("[machine] relay closed, reconnecting"); setTimeout(connect, 1000); });
    ws.on("error", (e) => { console.log("[machine] ws error", e.message); });
  };

  // Wire the panel frame sink to push UP the attach socket.
  panelHost.setPanelPushSink((channel, data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ t: "push", channel, data })); } catch { /* drop */ }
    }
  });

  connect();
  console.log("[machine] ready; capabilities include panel.open/input/close");
}

app.commandLine.appendSwitch("disable-gpu"); // deterministic in headless CI-ish runs; frames still render
main().catch((e) => { console.error(e); process.exit(1); });

// SPIKE proof (money-shot b): the panel uses the machine's PERSISTENT session.
// We seed one cookie into the default session (as a real prior login would have
// left), so a panel opened to a cookie-reflecting page shows it — demonstrating
// that the streamed page carries the user's logged-in state, no re-auth.
import { session } from "electron";
app.whenReady().then(() => {
  session.defaultSession.cookies.set({ url: "https://httpbin.org", name: "spike_logged_in_as", value: "chris@glyphh.ai", expirationDate: Math.floor(Date.now()/1000)+3600 })
    .then(() => console.log("[machine] seeded persistent-session login cookie"))
    .catch((e) => console.log("[machine] cookie seed failed", e.message));
});
