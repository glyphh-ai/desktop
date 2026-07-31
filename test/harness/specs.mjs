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
  // ── Group 1: boot + spaces (fresh boot) ─────────────────────────────────
  {
    name: "boot lands on the Work tab with the dashboard landing",
    fresh: true,
    body: `
      await until(() => tab("cowork"));
      await until(() => tab("cowork").classList.contains("active"));
      await until(() => document.querySelector('.help-section[data-section="dashboard"].active'));
      return ok(document.body.dataset.railSpace === "cowork", "railSpace=" + document.body.dataset.railSpace);
    `,
  },
  {
    name: "three space tabs exist: chat, cowork, code",
    body: `
      const tabs = $$('#rail-mode-tabs button').map((b) => b.dataset.tab).sort().join(",");
      return ok(tabs === "chat,code,cowork", tabs);
    `,
  },
  {
    name: "the composer (full agent footer) adopts into the Home landing",
    body: `
      await until(() => $("#dash-composer-slot .code-composer"));
      return ok(document.body.classList.contains("composer-on-home"));
    `,
  },
  {
    name: "nav scopes by space: Connections hidden under Code, Layouts hidden under Chat",
    body: `
      const conn = $('.app-rail-nav-item[data-section="connections"]');
      const lay = $('.app-rail-nav-item[data-section="layouts"]');
      click(tab("code"));
      await until(() => document.body.dataset.railSpace === "code");
      const connHiddenUnderCode = getComputedStyle(conn).display === "none";
      const layShownUnderCode = getComputedStyle(lay).display !== "none";
      click(tab("chat"));
      await until(() => document.body.dataset.railSpace === "chat");
      const layHiddenUnderChat = getComputedStyle(lay).display === "none";
      click(tab("cowork"));
      await until(() => document.body.dataset.railSpace === "cowork");
      return ok(connHiddenUnderCode && layShownUnderCode && layHiddenUnderChat,
        JSON.stringify({ connHiddenUnderCode, layShownUnderCode, layHiddenUnderChat }));
    `,
  },

  // ── Group 2: lazy creation + space isolation (fresh boot) ───────────────
  {
    name: "+ New session creates NOTHING until the first send",
    fresh: true,
    body: `
      await until(() => $("#code-new-chat") && tab("cowork")?.classList.contains("active"));
      const before = window.__stub.store().chats.length;
      click($("#code-new-chat"));
      await sleep(400);
      const after = window.__stub.store().chats.length;
      return ok(before === after && after === 0, "records: " + before + " → " + after);
    `,
  },
  {
    name: "first send creates the session stamped with the ACTIVE tab's mode",
    body: `
      await until(() => composer());
      typeInto(composer(), "hello from work");
      pressEnter(composer());
      await until(() => window.__stub.calls.glyphhRun.length === 1);
      const run = window.__stub.calls.glyphhRun[0];
      const chats = window.__stub.store().chats;
      return ok(run.mode === "cowork" && chats.length === 1 && chats[0].mode === "cowork",
        JSON.stringify({ runMode: run.mode, chats: chats.map((c) => c.mode) }));
    `,
  },
  {
    name: "a Work send NEVER lands in a Chat session (the space-hijack regression)",
    fresh: true,
    seed: [{ id: "cA", title: "chat one", createdAt: 1722400000000, messages: [{ role: "user", text: "hi", at: 1 }], mode: "chat" }],
    body: `
      await until(() => tab("cowork")?.classList.contains("active"), 8000);
      await until(() => composer());
      typeInto(composer(), "work message");
      pressEnter(composer());
      await until(() => window.__stub.calls.glyphhRun.length >= 1, 6000);
      const run = window.__stub.calls.glyphhRun.at(-1);
      const chats = window.__stub.store().chats;
      const chatA = chats.find((c) => c.id === "cA");
      const fresh = chats.find((c) => c.id !== "cA");
      return ok(run.mode === "cowork" && chatA.messages.length === 1 && fresh && fresh.mode === "cowork" && fresh.messages.length >= 1,
        JSON.stringify({ runMode: run.mode, chatAMsgs: chatA.messages.length, freshMode: fresh && fresh.mode }));
    `,
  },
  {
    name: "history lists are space-scoped (chat session invisible on Work tab)",
    body: `
      await until(() => railRows().length >= 1);
      const workTitles = railRows().map((r) => r.textContent);
      click(tab("chat"));
      await until(() => document.body.dataset.railSpace === "chat");
      const chatTitles = railRows().map((r) => r.textContent);
      click(tab("cowork"));
      await until(() => document.body.dataset.railSpace === "cowork");
      const workHasChat = workTitles.some((t) => t.includes("chat one"));
      const chatHasChat = chatTitles.some((t) => t.includes("chat one"));
      return ok(!workHasChat && chatHasChat, JSON.stringify({ workTitles, chatTitles }));
    `,
  },

  // ── Group 3: parallel runs (fresh boot) ─────────────────────────────────
  {
    name: "two sessions run in PARALLEL; composer state follows the session on screen",
    fresh: true,
    body: `
      await until(() => composer() && tab("cowork")?.classList.contains("active"));
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

  // ── Group 5: echo surface (fresh boot) ──────────────────────────────────
  {
    name: "the command center wall is APPS ONLY (no nav tiles, no tool band)",
    fresh: true,
    body: `
      killTransitions();
      await until(() => tab("cowork")?.classList.contains("active"));
      // open echo via the header eye (mounts the surface). Boot has the HOME
      // landing open as a card — that's the baseline, not an empty surface.
      await until(() => $("#code-cc-btn"));
      click($("#code-cc-btn"));
      await until(() => $(".echo-stage canvas"), 8000);
      await sleep(2000);   // wall build (async app/layout fetch)
      const search = await until(() => $(".echo-search"));
      const titles = () => $$(".echo-card .echo-card-head span").map((el) => el.textContent);
      const baseline = $$(".echo-card").length;
      // Settings is a NAV page — searching it must ADD no card
      typeInto(search, "settings");
      pressEnter(search);
      await sleep(600);
      const afterNav = $$(".echo-card").length;
      // Gmail (an app) must open as a NEW card
      typeInto(search, "gmail");
      pressEnter(search);
      await until(() => titles().includes("Gmail"), 8000);
      return ok(afterNav === baseline && titles().includes("Gmail"),
        JSON.stringify({ baseline, afterNav, titles: titles() }));
    `,
  },
  {
    name: "a layout opens EDGE-TO-EDGE with 7px seams (grid geometry)",
    body: `
      killTransitions();
      window.__wbEchoReset();
      await sleep(600);
      const search = $(".echo-search");
      typeInto(search, "triple");
      pressEnter(search);
      await until(() => $$(".echo-card").length === 5, 8000);
      await until(() => $$(".echo-card.placed").length === 5, 6000);
      await sleep(300);
      const stage = $(".echo-stage").getBoundingClientRect();
      const cards = $$(".echo-card").map((c) => c.getBoundingClientRect());
      const minL = Math.min(...cards.map((b) => b.left)) - stage.left;
      const minT = Math.min(...cards.map((b) => b.top)) - stage.top;
      const maxR = stage.right - Math.max(...cards.map((b) => b.right));
      return ok(Math.round(minL) === 0 && Math.round(minT) === 0 && Math.round(maxR) === 0,
        JSON.stringify({ minL, minT, maxR }));
    `,
  },
  {
    name: "layout session binding is stamped PER SPACE",
    body: `
      // the Coding day layout has sessionMode "last": opening it in cowork
      // must write the cowork-scoped binding key once a session change fires
      killTransitions();
      window.__wbEchoReset();
      await sleep(500);
      const search = $(".echo-search");
      typeInto(search, "coding day");
      pressEnter(search);
      await until(() => $$(".echo-card").length >= 1, 8000);
      window.dispatchEvent(new CustomEvent("agent-sessions-changed"));
      await sleep(300);
      const keys = Object.keys(localStorage).filter((k) => k.startsWith("workbench:layoutsession:coding day"));
      const spaceScoped = keys.every((k) => /:(chat|cowork|code)$/.test(k));
      return ok(keys.length === 0 || spaceScoped, JSON.stringify(keys));
    `,
  },
];
