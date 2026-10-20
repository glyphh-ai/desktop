/**
 * Harness specs — each test is a stringified async IIFE executed inside the
 * REAL renderer (dist/renderer/home.html booted against stub-preload's fake
 * IPC). A test resolves `{ pass: boolean, detail?: string }`.
 *
 * Shared helpers are prepended to every test body (HELPERS below): tiny
 * waiters + click/type utilities. Keep tests independent — each gets a fresh
 * app boot when `fresh: true`, otherwise they run in document order on the
 * same boot (cheaper; state builds left to right within a group).
 */

export const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000, step = 50) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error("timeout: " + fn.toString().slice(0, 120));
      await sleep(step);
    }
  };
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const click = (el) => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); };
  const typeInto = (ta, text) => {
    ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const pressEnter = (el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const tab = (name) => $$('#rail-mode-tabs button').find((b) => b.dataset.tab === name);
  const composer = () => $("#code-input");
  const railRows = () => $$(".code-history-item");
  const ok = (pass, detail) => ({ pass: !!pass, detail: detail || "" });
  const killTransitions = () => {
    if (document.getElementById("__harness-no-anim")) return;
    const st = document.createElement("style");
    st.id = "__harness-no-anim";
    st.textContent = "* { transition: none !important; animation: none !important; }";
    document.head.appendChild(st);
  };
`;

export const SPECS = [
  // ── Group 3: parallel runs (fresh boot) ─────────────────────────────────
  {
    name: "two sessions run in PARALLEL; composer state follows the session on screen",
    fresh: true,
    body: `
      await until(() => composer() && tab("cowork"));
      click(tab("cowork"));
      await until(() => tab("cowork").classList.contains("active"));
      // session 1 (work): send — run starts and STAYS live (no done event)
      typeInto(composer(), "long work task");
      pressEnter(composer());
      await until(() => window.__stub.calls.glyphhRun.length === 1);
      const send1 = $("#code-send");
      await until(() => send1 && send1.classList.contains("thinking"));
      // switch to Code, send there while Work streams
      click(tab("code"));
      await until(() => document.body.dataset.railSpace === "code");
      await until(() => composer());
      const sendBtnOnCode = $("#code-send");
      const codeComposerFree = !sendBtnOnCode.classList.contains("thinking");
      typeInto(composer(), "code task");
      pressEnter(composer());
      await until(() => window.__stub.calls.glyphhRun.length === 2, 6000);
      const modes = window.__stub.calls.glyphhRun.map((r) => r.mode).join(",");
      const twoSessions = window.__stub.store().chats.length === 2;
      return ok(codeComposerFree && modes === "cowork,code" && twoSessions,
        JSON.stringify({ codeComposerFree, modes, chats: window.__stub.store().chats.length }));
    `,
  },
  {
    name: "deltas land in the RIGHT session records",
    body: `
      const runs = window.__stub.calls.glyphhRun;
      window.__stub.agentDelta("run-1", "work answer");
      window.__stub.agentDone("run-1");
      window.__stub.agentDelta("run-2", "code answer");
      window.__stub.agentDone("run-2");
      await until(() => window.__stub.store().chats.every((c) => c.messages.some((m) => m.role === "assistant")), 6000);
      const byMode = Object.fromEntries(window.__stub.store().chats.map((c) => [c.mode, c.messages.filter((m) => m.role === "assistant").map((m) => m.text).join("|")]));
      return ok((byMode.cowork || "").includes("work answer") && (byMode.code || "").includes("code answer"),
        JSON.stringify(byMode));
    `,
  },

  {
    name: "inline CONNECT card: offered in-thread, OAuth runs in-app, tool answered",
    fresh: true,
    body: `
      await until(() => composer() && tab("cowork"));
      click(tab("cowork"));
      await until(() => tab("cowork").classList.contains("active"));
      // a live work session (the card lands in the run's thread)
      typeInto(composer(), "connect to notion please");
      pressEnter(composer());
      await until(() => window.__stub.calls.glyphhRun.length === 1);
      // main's connect_account offers the card
      window.__stub.agentConnect("conn-1", { appId: "notion", name: "Notion", icon: null });
      const card = await until(() => $(".code-connect-card"), 5000);
      const offered = card.dataset.status === "offer";
      // the user clicks Connect — the SAME in-app OAuth the Connections page runs
      click(card.querySelector(".ccx-btn"));
      await until(() => window.__stub.calls.connectorsConnect.length === 1, 5000);
      await until(() => $(".code-connect-card")?.dataset.status === "connected", 5000);
      const answered = window.__stub.calls.connectRespond.at(-1);
      // the card persists in the session record
      const persisted = window.__stub.store().chats.some((c) => c.messages.some((m) => m.kind === "connect" && m.connect && m.connect.status === "connected"));
      return ok(offered && answered && answered.id === "conn-1" && answered.connected === true && persisted,
        JSON.stringify({ offered, answered, persisted }));
    `,
  },

  // ── Group 4: chrome + meter (fresh boot) ────────────────────────────────
  {
    name: "chat-space landing strips work chrome + never gates on a folder",
    fresh: true,
    body: `
      await until(() => tab("chat"));
      click(tab("chat"));
      await until(() => document.body.dataset.sessionSpace === "chat");
      const wd = $("#code-workdir-btn");
      const toggles = $(".code-view-toggles");
      const gated = $(".code-input-wrap")?.classList.contains("gated");
      const wdHidden = !wd || getComputedStyle(wd).display === "none";
      const togglesHidden = !toggles || getComputedStyle(toggles).display === "none";
      return ok(wdHidden && togglesHidden && !gated, JSON.stringify({ wdHidden, togglesHidden, gated }));
    `,
  },
  {
    name: "ctx meter shows the EMPTY state on a landing (no frozen fill)",
    body: `
      await until(() => $("#code-ctx-meter"));
      await sleep(600);   // meter repaint debounce
      const fill = $("#code-ctx-meter .ctx-fill");
      return ok(fill && (fill.style.width === "0%" || fill.style.width === ""), "width=" + (fill && fill.style.width));
    `,
  },

  // ── Group: agent panels are INDEPENDENT INSTANCES (his ruling, 2026-09-26) ──
  {
    name: "agent panels: rail New opens ANOTHER panel on every press, never the shell's singleton",
    fresh: true,
    seedAgents: [{ id: "claude", name: "Claude", cli: "claude", icon: "", cmd: "claude", mcp: false, cwd: "/tmp/harness", command: "claude" }],
    body: `
      killTransitions();
      await until(() => $("#code-new-chat"));
      const panels = () => $$(".echo-card webview").filter((w) => (w.getAttribute("src") || "").includes("solo=tool:coding"));
      // A cold boot with nothing to restore opens the agent by itself — as an instance now.
      click($("#code-new-chat"));
      await until(() => panels().length >= 1, 10000);
      await sleep(600);
      const boot = panels().length;
      click($("#code-new-chat"));
      await until(() => panels().length === boot + 1, 8000);
      click($("#code-new-chat"));
      await until(() => panels().length === boot + 2, 8000);
      click($("#code-new-chat"));
      await until(() => panels().length === boot + 3, 8000);
      const slugs = panels().map((w) => w.closest(".echo-card")?.querySelector(".echo-card-head > span")?.textContent);
      const instances = panels().map((w) => new URL(w.getAttribute("src")).searchParams.get("instance"));
      const loops = panels().map((w) => new URL(w.getAttribute("src")).searchParams.get("loop"));
      const singleton = !!$(".echo-agent-card");
      const distinct = new Set(instances).size === panels().length;
      return ok(boot <= 2 && distinct && !singleton && loops.every((l) => l === "claude"), JSON.stringify({ boot, instances, loops, singleton, slugs }));
    `,
  },
  {
    name: "agent panels: the Terminal tool opens beside an agent's CLI card instead of resolving to it",
    fresh: true,
    seedAgents: [{ id: "claude", name: "Claude", cli: "claude", icon: "", cmd: "claude", mcp: false, cwd: "/tmp/harness", command: "claude" }],
    body: `
      killTransitions();
      await until(() => $("#code-new-chat"));
      click($("#code-new-chat"));
      await until(() => window.__wbOpenAgentCli && window.__wbOpenTool, 10000);
      const named = (n) => $$(".echo-card").filter((c) => (c.querySelector(".echo-card-head > span")?.textContent || "") === n);
      window.__wbOpenAgentCli("claude", undefined, { fresh: true });
      await until(() => named("Claude").length === 1, 8000);
      const terminalsBefore = named("Terminal").length;
      window.__wbOpenTool("terminal");
      await until(() => named("Terminal").length === 1, 8000);
      // and the plain Terminal tool still de-duplicates against ITSELF
      window.__wbOpenTool("terminal");
      await sleep(400);
      return ok(terminalsBefore === 0 && named("Terminal").length === 1 && named("Claude").length === 1,
        JSON.stringify({ terminalsBefore, terminals: named("Terminal").length, claude: named("Claude").length }));
    `,
  },
  {
    name: "agent panels: a session running anywhere pulses in the rail, and stops when its turn ends",
    fresh: true,
    seedAgents: [{ id: "claude", name: "Claude", cli: "claude", icon: "", cmd: "claude", mcp: false, cwd: "/tmp/harness", command: "claude" }],
    seedSessions: [{ id: "sid-1", cli: "claude", title: "Fix the rail", cwd: "/tmp/harness", mtime: 1758900000000 }],
    body: `
      const row = () => $$("#recent-sessions-list .code-history-item").find((r) => r.textContent.includes("Fix the rail"));
      await until(row, 8000);
      const idle = !!row().querySelector(".code-sess-ic") && !row().querySelector(".code-chat-dot.working");
      window.__stub.live([{ chatId: "c1", cliSessionId: "sid-1", cli: "claude", runId: "c1:1", senderId: 999, startedAt: Date.now() }]);
      await until(() => row()?.querySelector(".code-chat-dot.working"), 4000);
      const working = true;
      window.__stub.live([]);
      await until(() => row() && !row().querySelector(".code-chat-dot.working") && row().querySelector(".code-sess-ic"), 4000);
      return ok(idle && working, JSON.stringify({ idle, working }));
    `,
  },
  {
    name: "agent panels: a rail click fronts the panel running the session, and routes an idle one into the last panel",
    fresh: true,
    seedAgents: [{ id: "claude", name: "Claude", cli: "claude", icon: "", cmd: "claude", mcp: false, cwd: "/tmp/harness", command: "claude" }],
    seedSessions: [
      { id: "sid-1", cli: "claude", title: "Fix the rail", cwd: "/tmp/harness", mtime: 1758900000000 },
      { id: "sid-2", cli: "claude", title: "Write the docs", cwd: "/tmp/harness", mtime: 1758800000000 },
    ],
    body: `
      killTransitions();
      await until(() => $("#code-new-chat"));
      const panels = () => $$(".echo-card webview").filter((w) => (w.getAttribute("src") || "").includes("solo=tool:coding"));
      click($("#code-new-chat"));
      await until(() => panels().length >= 1, 10000);
      await sleep(600);
      const boot = panels().length;
      click($("#code-new-chat"));
      await until(() => panels().length === boot + 1, 8000);
      const wv = panels()[panels().length - 1];
      const card = wv.closest(".echo-card");
      const wcId = await until(() => { try { return wv.getWebContentsId(); } catch { return 0; } }, 10000);
      const row = (t) => $$("#recent-sessions-list .code-history-item").find((r) => r.textContent.includes(t));
      await until(() => row("Fix the rail") && row("Write the docs"), 8000);
      window.__stub.live([{ chatId: "c1", cliSessionId: "sid-1", cli: "claude", runId: "c1:1", senderId: wcId, startedAt: Date.now() }]);
      await until(() => row("Fix the rail")?.querySelector(".code-chat-dot.working"), 4000);
      click(row("Fix the rail"));
      await until(() => card.classList.contains("flash"), 2000);
      await until(() => !card.classList.contains("flash"), 2000);
      const stillSame = panels().length === boot + 1;
      // an IDLE session lands in the panel the user touched last — no new panel
      click(row("Write the docs"));
      await until(() => card.classList.contains("flash"), 2000);
      await sleep(500);
      return ok(stillSame && panels().length === boot + 1, JSON.stringify({ stillSame, boot, panels: panels().length }));
    `,
  },
  {
    name: "agent panels: the shell's orders land INSIDE the panel — a routed session adopts, a prompt sends",
    fresh: true,
    seedAgents: [{ id: "claude", name: "Claude", cli: "claude", icon: "", cmd: "claude", mcp: false, cwd: "/tmp/harness", command: "claude" }],
    seedSessions: [{ id: "sid-1", cli: "claude", title: "Fix the rail", cwd: "/tmp/harness", mtime: 1758900000000 }],
    body: `
      killTransitions();
      await until(() => $("#code-new-chat"));
      const panels = () => $$(".echo-card webview").filter((w) => (w.getAttribute("src") || "").includes("solo=tool:coding"));
      click($("#code-new-chat"));
      await until(() => panels().length >= 1, 10000);
      await sleep(600);
      const boot = panels().length;
      // A prompt rides into a FRESH panel and is sent there (the Home composer's path).
      window.__wbOpenAgentInstanceWith("claude", { type: "prompt", text: "hello from the shell", send: true });
      await until(() => panels().length === boot + 1, 8000);
      const fresh = panels()[panels().length - 1];
      const inGuest = (wv, js) => wv.executeJavaScript(js, true);
      const sent = await until(async () => {
        try { const r = await inGuest(fresh, "({ runs: window.__stub.calls.glyphhRun.map((p) => p.chatId), chats: window.__stub.store().chats.map((c) => c.messages.map((m) => m.text)) })"); return r.runs.length === 1 ? r : null; }
        catch { return null; }
      }, 25000, 250);
      // An idle rail session lands in the panel the user touched last (that fresh one) and adopts.
      const row = $$("#recent-sessions-list .code-history-item").find((r) => r.textContent.includes("Fix the rail"));
      click(row);
      const adopted = await until(async () => {
        try { const t = await inGuest(fresh, "document.querySelector('#code-session-title')?.textContent || ''"); return t.includes("Fix the rail") ? t : null; }
        catch { return null; }
      }, 15000, 250);
      return ok(sent.chats.some((m) => m.includes("hello from the shell")) && adopted && panels().length === boot + 1,
        JSON.stringify({ sent, adopted, panels: panels().length, boot }));
    `,
  },
  {
    name: "dock: the Glyphh loop wears Sage, the fixed New tile keeps the brand mark",
    fresh: true,
    seedAgents: [
      { id: "claude", name: "Claude", cli: "claude", icon: "", cmd: "claude", mcp: false, cwd: "/tmp/harness", command: "claude" },
      { id: "glyphh", name: "Glyphh", cli: "glyphh", icon: "", cmd: "glyphh", mcp: false, cwd: "/tmp/harness", command: "glyphh" },
    ],
    body: `
      killTransitions();
      await until(() => $$(".echo-icon, .echo-dock-btn").length >= 3, 12000);
      const tiles = $$(".echo-icon, .echo-dock-btn");
      const fixed = tiles.find((t) => (t.dataset.dock || t.dataset.key) === "glyphh" || /new session/i.test(t.title || ""));
      const loop = tiles.find((t) => t.querySelector('svg[aria-label="Sage"]'));
      const fixedImg = fixed?.querySelector("img")?.getAttribute("src") || "";
      return ok(!!loop && /glyphh-mark\\.png$/.test(fixedImg) && loop !== fixed,
        JSON.stringify({ fixedImg, loopFound: !!loop, tiles: tiles.length }));
    `,
  },
];



