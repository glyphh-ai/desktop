/**
 * App.tsx — the chat, FULL HEIGHT: the welcome card and the transcript scroll
 * in the pane above; the strip (status, a parked approval or a selector, the
 * slash menu, the composer, the footer) is pinned to the bottom. Every frame
 * goes through the line-diff renderer (render/fullscreen.ts), so a frame the
 * size of the terminal costs only the rows that changed — no flicker.
 *
 * A turn is the Glyphh loop itself (loop.ts) running in this process on the
 * user's own Anthropic key: text streams live (batched), tool calls land as collapsible
 * receipts, and a permission ask parks the run on a selector — the same
 * question every agent CLI asks: yes · yes, don't ask again for this · no.
 *
 * The conversation is SHARED WITH THE DESKTOP (sessions.ts): it opens from the
 * same store the Agent panel reads, every answer is written back, and when the
 * desktop launched us the store's current chat follows this one.
 *
 * Keys, the way every agent CLI has them: enter sends; ↑/↓ recall prompts;
 * ←/→ move the cursor (ctrl+a/e, ctrl+w, ctrl+u); shift+tab cycles the
 * permission chip; esc stops the turn; ctrl+o expands tool output; pgup/pgdn
 * scroll; ctrl+c clears the line, twice quits; "/" opens the command menu;
 * "?" on an empty line shows the shortcuts.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from "ink";
import { runLoopTurn, type ApprovalRequest } from "../loop.js";
import { resolveModel } from "../models.js";
import { chatStoreFile, hasProviderKey, NO_KEY_LINES } from "../local.js";
import { readPrefs, writePrefs, rememberPrompt, folderTrusted, trustFolder } from "../prefs.js";
import { DEFAULT_EFFORT, EFFORT_LABEL, type Effort } from "../types.js";
import { LOGO_MARK } from "../banner.js";
import { diag } from "../diag.js";
import { InputBar } from "./InputBar.js";
import { Footer, type FooterSlot } from "./Footer.js";
import { SubFooter } from "./SubFooter.js";
import { SlashMenu } from "./SlashMenu.js";
import { Picker, type PickerSpec } from "./Picker.js";
import { TranscriptLine } from "./TranscriptLine.js";
import { theme, applyTheme } from "../theme.js";
import { runSlash, matchCommands, RELEASE_NOTES, TIPS, type CommandCtx, type SessionCost } from "../commands.js";
import { conversationOf, findChat, listGlyphhChats, newChat, saveChat, titleOf, desktopPermission, type StoredChat } from "../sessions.js";
import { headerLines,
  answerLines,
  commandLines,
  noteLines,
  sectionLines,
  userLines,
  type Line,
} from "../lines.js";
import { PERMISSION_CYCLE, type ChatTurn, type Item, type PermissionMode, type TurnStep } from "../types.js";

/** The rotating work verbs — one pair per turn (✽ Verbing… / ✻ Verbed for Ns). */
const VERBS: Array<{ ing: string; past: string }> = [
  { ing: "Cooking", past: "Cooked" },
  { ing: "Cogitating", past: "Cogitated" },
  { ing: "Crunching", past: "Crunched" },
  { ing: "Brewing", past: "Brewed" },
  { ing: "Noodling", past: "Noodled" },
  { ing: "Simmering", past: "Simmered" },
  { ing: "Churning", past: "Churned" },
];

/** Most recent turns handed to the loop as its seed — bounds the wire, not the transcript. */
const HISTORY_CAP = 40;
/** How much of a thought the strip keeps — one line's worth, never a transcript. */
const THINKING_PREVIEW_MAX = 400;

/** A second ctrl+c within this window quits. */
const QUIT_WINDOW_MS = 2000;

/** A tool receipt label: the loop names each call ("bash npm test"); long titles clip. */
export function toolLabel(name: string, title?: string): string {
  const t = (title ?? "").trim();
  if (!t) return name;
  return t.length > 76 ? `${t.slice(0, 75)}…` : t;
}

/** What the strip is blocked on: a selector (approvals are selectors too). */
type Pending = { kind: "picker"; spec: PickerSpec; selected: number };

/** The approval question, worded like the other CLIs ask it. */
export function approvalSpec(req: ApprovalRequest, answer: (allow: boolean, always: boolean) => void): PickerSpec {
  const noun = req.kind === "command" ? "commands" : req.kind === "edit" ? "edits" : "this tool";
  const detail = req.detail.split("\n").filter(Boolean).slice(0, 3).join(" ");
  return {
    title: `Allow ${req.kind === "command" ? "this command" : req.kind === "edit" ? "this edit" : req.title.split(" ")[0] ?? "this tool"}?`,
    description: `${req.title}${detail && detail !== req.title ? ` · ${detail.length > 140 ? `${detail.slice(0, 139)}…` : detail}` : ""}`,
    options: [
      { id: "yes", label: "Yes", detail: "run it once" },
      { id: "always", label: `Yes, and don't ask again for ${noun}`, detail: "for the rest of this session" },
      { id: "no", label: "No", detail: "tell the loop to do something else (esc)" },
    ],
    enterLabel: "choose",
    onPick: (id) => answer(id !== "no", id === "always"),
    onCancel: () => answer(false, false),
  };
}

/** A governed connection that isn't authorized comes back as a raw tool error —
 *  turn it into the one line that says what to do. */
const CONN_AUTH_RE = /(access|refresh)[\s/]{0,3}(token|credential)|token (is )?(expired|missing|invalid|revoked)|not authori[sz]ed|unauthori[sz]ed|reconnect|connect (your |the )?[\w ]+ account/i;
export function connectionAuthHint(toolName: string, content: string): string | null {
  if (!CONN_AUTH_RE.test(content)) return null;
  const svc = toolName.startsWith("conn__")
    ? (toolName.split("__")[1] || "that connection").replace(/[-_]/g, " ")
    : "that connection";
  return `${svc} isn't connected. Connect it in the Glyphh app (Connections), then retry.`;
}

/** Omit that distributes over a union (plain Omit collapses discriminants). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The composer's text as code points, so the cursor never splits a glyph. */
const cps = (s: string): string[] => [...s];

/** Delete the word before `at` (a ctrl+w / alt+backspace). */
export function deleteWordBefore(value: string, at: number): { value: string; cursor: number } {
  const chars = cps(value);
  let i = Math.min(at, chars.length);
  while (i > 0 && chars[i - 1] === " ") i--;
  while (i > 0 && chars[i - 1] !== " ") i--;
  return { value: [...chars.slice(0, i), ...chars.slice(Math.min(at, chars.length))].join(""), cursor: i };
}

export interface AppProps {
  version: string;
  cwd: string;
  /** `--model`: the model this session runs on (a session pick, not persisted). */
  initialModel?: string;
  /** `--effort`: the dial for this launch (a session pick, not persisted). */
  initialEffort?: Effort;
  /** `--permission`: the chip to start on, for this launch. */
  initialMode?: PermissionMode;
  /** An opening prompt from the command line — sent once, on mount. */
  initialPrompt?: string;
  /** `--resume <id>`: open this chat from the shared store. */
  resumeId?: string;
  /** `--continue`: open the most recent Glyphh-loop chat. */
  continueLast?: boolean;
  /** `--trust`: the folder question is already answered. */
  trusted?: boolean;
}

/** Launched by the desktop's terminal card: the store's current chat follows us. */
const LAUNCHED_BY_DESKTOP = !!process.env.GLYPHH_APP_SESSIONS;
/** THE REAL FOLDER, absolute. The `cwd` prop is for display (HOME collapsed to
 *  "~"); a display path leaked into a stored chat once and the desktop then
 *  ran `cd "~"`, which no shell expands (his report, 2026-09-21). */
const REAL_CWD = process.cwd();

export function App({ version, cwd, initialModel, initialEffort, initialMode, initialPrompt, resumeId, continueLast, trusted }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [cols, setCols] = useState(stdout.columns || 80);
  const [rows, setRows] = useState(stdout.rows || 24);
  /** Is there a key to run on? Re-read on every send — a key saved meanwhile counts. */
  const [keyed, setKeyed] = useState<boolean>(hasProviderKey);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ChatTurn | undefined>(undefined);
  const [verb, setVerb] = useState(VERBS[0]!);
  const [elapsed, setElapsed] = useState(0);
  /** Tool receipts are collapsed by default; ctrl+o toggles them all open. */
  const [expanded, setExpanded] = useState(false);
  /** Lines scrolled up from the tail; 0 = follow mode. */
  const [scroll, setScroll] = useState(0);
  const [chromeH, setChromeH] = useState({ strip: 6 });
  const [mode, setMode] = useState<PermissionMode>(() => initialMode ?? readPrefs().permissionMode ?? "default");
  // THE MODEL: the device's persisted pick (/model), a session pick (--model, s
  // in the selector) over it, and the catalog's default underneath (models.ts).
  const [pickedModel, setPickedModel] = useState<string | null>(() => readPrefs().model ?? null);
  const [sessionModel, setSessionModel] = useState<string | null>(initialModel ?? null);
  // THE EFFORT DIAL, the same two layers: the device's persisted pick (/effort)
  // and a session pick (--effort, s in the selector) over it; medium underneath.
  const [pickedEffort, setPickedEffort] = useState<Effort | null>(() => readPrefs().effort ?? null);
  const [sessionEffort, setSessionEffort] = useState<Effort | null>(initialEffort ?? null);
  /** The model's thinking while a turn works: null = none yet (or the answer started). */
  const [thinking, setThinking] = useState<string | null>(null);
  /** The composer's transient hint (ctrl+c once). */
  const [hint, setHint] = useState<string | null>(null);
  /** Slash menu selection while the line starts with "/". */
  const [slashSel, setSlashSel] = useState(0);
  /** The shared store's chat this transcript IS. */
  const [chat, setChat] = useState<StoredChat>(() => newChat(REAL_CWD, initialMode ?? readPrefs().permissionMode ?? "default"));
  const [, setThemeVersion] = useState(0);

  const nextId = useRef(0);
  const turnStartedAt = useRef(0);
  const turnAbort = useRef<AbortController | null>(null);
  const inputRef = useRef("");
  const cursorRef = useRef(0);
  const stripBox = useRef<DOMElement | null>(null);
  const history = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const prompts = useRef<string[]>(readPrefs().history ?? []);
  const histIdx = useRef<number>(prompts.current.length);
  const stash = useRef("");
  const [pending, setPending] = useState<Pending | null>(null);
  /** Action kinds ("edit", "command", …) the user answered "don't ask again" for. */
  const allowedKinds = useRef<Set<string>>(new Set());
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const modelRef = useRef<{ picked: string | null; session: string | null }>({ picked: pickedModel, session: sessionModel });
  modelRef.current = { picked: pickedModel, session: sessionModel };
  const effortRef = useRef<Effort>(sessionEffort ?? pickedEffort ?? DEFAULT_EFFORT);
  effortRef.current = sessionEffort ?? pickedEffort ?? DEFAULT_EFFORT;
  const cost = useRef<SessionCost>({ turns: 0, tokensUp: 0, tokensDown: 0, durationMs: 0, startedAt: Date.now() });
  const lastCtrlC = useRef(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionsFile = useMemo(chatStoreFile, []);

  useEffect(() => {
    const onResize = () => {
      setCols(stdout.columns || 80);
      setRows(stdout.rows || 24);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useEffect(() => {
    applyTheme(readPrefs().theme);
    setThemeVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setElapsed((Date.now() - turnStartedAt.current) / 1000), 250);
    return () => clearInterval(t);
  }, [busy]);

  // Real chrome heights each frame — the viewport height is exact, not guessed.
  useEffect(() => {
    const strip = stripBox.current ? measureElement(stripBox.current).height : chromeH.strip;
    if (strip !== chromeH.strip) setChromeH({ strip });
  });

  const push = useCallback((item: DistributiveOmit<Item, "id">): string => {
    const id = `i${++nextId.current}`;
    setItems((l) => [...l, { ...item, id } as Item]);
    return id;
  }, []);

  const patchItem = useCallback((id: string, fn: (item: Item) => Item) => {
    setItems((l) => l.map((it) => (it.id === id ? fn(it) : it)));
  }, []);

  const setLine = useCallback((value: string, at?: number) => {
    inputRef.current = value;
    cursorRef.current = Math.max(0, Math.min(at ?? cps(value).length, cps(value).length));
    setInput(value);
    setCursor(cursorRef.current);
    setSlashSel(0);
  }, []);

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), QUIT_WINDOW_MS);
  }, []);

  const setModel = useCallback((id: string | null, opts: { session?: boolean } = {}) => {
    if (opts.session) {
      setSessionModel(id);
      return;
    }
    setSessionModel(null);
    setPickedModel(id);
    writePrefs({ model: id ?? null });
  }, []);

  const setEffort = useCallback((effort: Effort, opts: { session?: boolean } = {}) => {
    if (opts.session) {
      setSessionEffort(effort);
      return;
    }
    setSessionEffort(null);
    setPickedEffort(effort);
    writePrefs({ effort });
  }, []);

  const setPermission = useCallback((next: PermissionMode) => {
    setMode(next);
    writePrefs({ permissionMode: next });
  }, []);

  const setTheme = useCallback((name: string) => {
    applyTheme(name);
    writePrefs({ theme: name });
    setThemeVersion((v) => v + 1);
  }, []);

  /** Show a stored chat: transcript + the loop's seed. */
  const showChat = useCallback((c: StoredChat) => {
    const convo = conversationOf(c);
    history.current = convo.map((m) => ({ role: m.role, content: m.text }));
    setItems(convo.map((m, i) => (m.role === "user" ? { id: `s${i}`, kind: "user", text: m.text } : { id: `s${i}`, kind: "answer", text: m.text })));
    setExpanded(false);
    setScroll(0);
    setLast(undefined);
    setChat(c);
    chatRef.current = c;
    if (LAUNCHED_BY_DESKTOP) saveChat(sessionsFile, c, { current: true });
  }, [sessionsFile]);

  /** /resume <id> and --resume: the chat from the shared store, or why not. */
  const resumeChat = useCallback(async (id: string): Promise<string[]> => {
    const c = findChat(sessionsFile, id);
    if (!c) return [`no conversation ${id} on this machine`];
    showChat(c);
    return [`resumed "${c.title}" · ${c.messages.length} message${c.messages.length === 1 ? "" : "s"}`];
  }, [sessionsFile, showChat]);

  // --resume / --continue, once, on mount.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const target = resumeId ? findChat(sessionsFile, resumeId) : continueLast ? listGlyphhChats(sessionsFile, 1)[0] ?? null : null;
    diag("resume", { resumeId: resumeId ?? null, continueLast: !!continueLast, found: !!target, store: sessionsFile });
    if (target) showChat(target);
    else if (resumeId) push({ kind: "note", text: `no conversation ${resumeId} on this machine — starting fresh` });
  }, [sessionsFile, resumeId, continueLast, showChat, push]);

  const openPicker = useCallback((spec: PickerSpec) => {
    const cur = Math.max(0, spec.options.findIndex((o) => o.current));
    setPending({ kind: "picker", spec, selected: cur });
  }, []);

  // THE FOLDER QUESTION (his order, 2026-09-21: "do what the others do"): the
  // loop's tools read, write and run in this folder, so the first visit asks.
  // The desktop's terminal card passes --trust (the folder was chosen in-app).
  const askedTrust = useRef(false);
  useEffect(() => {
    if (askedTrust.current || trusted || folderTrusted(REAL_CWD)) return;
    askedTrust.current = true;
    openPicker({
      title: "Do you trust the files in this folder?",
      description: `${REAL_CWD} — the Glyphh loop can read, edit and run what is here. Trust only folders whose contents you know.`,
      options: [
        { id: "yes", label: "Yes, and remember this folder", detail: "no question next time here" },
        { id: "once", label: "Yes, this session only" },
        { id: "no", label: "No, exit", detail: "esc" },
      ],
      enterLabel: "choose",
      onPick: (id) => {
        if (id === "yes") trustFolder(REAL_CWD);
        else if (id === "no") exit();
      },
      onCancel: () => exit(),
    });
  }, [trusted, openPicker, exit]);

  const runTurn = useCallback(
    async (prompt: string) => {
      const startedAt = Date.now();
      turnStartedAt.current = startedAt;
      diag("turn-start", { chatId: chatRef.current.id, permission: modeRef.current });
      setElapsed(0);
      setScroll(0); // a new turn follows the tail
      const v = VERBS[nextId.current % VERBS.length]!;
      setVerb(v);
      push({ kind: "user", text: prompt });
      const turn: ChatTurn = { id: `t${nextId.current}`, text: "", status: "running", tokensUp: 0, tokensDown: 0 };
      setLast({ ...turn });
      setBusy(true);
      const abort = new AbortController();
      turnAbort.current = abort;
      try {
        const model = resolveModel(modelRef.current.session, modelRef.current.picked);
        let segId: string | null = null;
        let segText = "";
        let text = "";
        const toolItems = new Map<string, string[]>();
        // Deltas paint in BATCHES (~25 fps): a frame per token is a redraw per token.
        let pendingDelta = "";
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        // THINKING: one dim line in the strip, grown from the deltas (batched
        // like the answer), gone the moment the answer or a tool starts.
        let thought = "";
        let thinkTimer: ReturnType<typeof setTimeout> | null = null;
        const flushThinking = (): void => {
          thinkTimer = null;
          if (thought) setThinking(thought);
        };
        const endThinking = (): void => {
          if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
          if (thought) { thought = ""; setThinking(null); }
        };
        const flushDelta = (): void => {
          flushTimer = null;
          const t = pendingDelta;
          pendingDelta = "";
          if (!t) return;
          endThinking();
          if (!segId) {
            segText = t.replace(/^\s+/, "");
            if (!segText) return;
            segId = push({ kind: "answer", text: segText });
            return;
          }
          segText += t;
          const id = segId;
          patchItem(id, (it) => ({ ...it, text: segText }) as Item);
        };
        const sink = {
          delta: (t: string) => {
            text += t;
            pendingDelta += t;
            if (!flushTimer) flushTimer = setTimeout(flushDelta, 40);
          },
          thinking: (t: string) => {
            if (segId || pendingDelta) return; // the answer has begun — the thought is over
            thought += t;
            if (thought.length > THINKING_PREVIEW_MAX) thought = thought.slice(0, THINKING_PREVIEW_MAX);
            if (!thinkTimer) thinkTimer = setTimeout(flushThinking, 80);
          },
          toolStart: (name: string, title?: string) => {
            if (flushTimer) { clearTimeout(flushTimer); flushDelta(); }
            endThinking();
            segId = null;
            const id = push({ kind: "section", step: { label: toolLabel(name, title), ok: true, details: [] } });
            const queue = toolItems.get(name) ?? [];
            queue.push(id);
            toolItems.set(name, queue);
          },
          toolDone: (name: string, r: { failed: boolean; denied: boolean; preview: string }) => {
            segId = null;
            const authHint = r.failed ? connectionAuthHint(name, r.preview) : null;
            if (authHint) push({ kind: "note", text: authHint });
            const details = r.preview ? r.preview.split("\n").slice(0, 200) : [];
            const error = r.denied ? "denied" : r.failed ? "tool error" : undefined;
            const id = toolItems.get(name)?.shift();
            if (id) {
              patchItem(id, (it) => {
                const step = (it as { step: TurnStep }).step;
                return { ...it, step: { ...step, ok: !r.failed, details, ...(error ? { error } : {}) } } as Item;
              });
              return;
            }
            push({ kind: "section", step: { label: `${name} → ${r.failed ? "error" : "result"}`, ok: !r.failed, details, ...(error ? { error } : {}) } });
          },
          progress: (up: number, down: number) => {
            turn.tokensUp = up;
            turn.tokensDown = down;
            setLast({ ...turn });
          },
        };

        const result = await runLoopTurn(
          {
            model,
            chatId: chatRef.current.id,
            history: history.current.slice(-HISTORY_CAP),
            prompt,
            cwd: process.cwd(),
            permission: modeRef.current,
            effort: effortRef.current,
            signal: abort.signal,
          },
          {
            onDelta: sink.delta,
            onThinking: sink.thinking,
            onToolStart: sink.toolStart,
            onToolDone: sink.toolDone,
            onProgress: sink.progress,
            // The loop PARKED the run: the question is a selector, the way
            // every agent CLI asks it, and `answer` resumes the loop.
            onApproval: (req, answer) => {
              if (allowedKinds.current.has(req.kind)) {
                answer(true);
                return;
              }
              openPicker(approvalSpec(req, (allow, always) => {
                if (always) allowedKinds.current.add(req.kind);
                answer(allow);
              }));
            },
            onNote: (note) => push({ kind: "note", text: note }),
          },
        );
        if (flushTimer) { clearTimeout(flushTimer); flushDelta(); }
        endThinking();
        text = result.text || text;
        turn.text = text;
        const stopped = result.stopped || abort.signal.aborted;
        if (result.error) {
          turn.status = "error";
          push({ kind: "note", text: result.error });
        }
        if (stopped) push({ kind: "note", text: "⏹ Stopped." });
        else if (!result.error && !text.trim()) push({ kind: "note", text: "(no answer text — the run ended after tool calls)" });
        history.current.push({ role: "user", content: prompt });
        history.current.push({ role: "assistant", content: text || "…" });
        if (turn.status !== "error") turn.status = stopped ? "stopped" : "done";
        // THE SHARED STORE: this turn lands in the same file the desktop reads,
        // so its rail and Agent panel show it and can pick the chat up.
        const c = chatRef.current;
        const now = Date.now();
        const next: StoredChat = {
          ...c,
          title: c.messages.length ? c.title : titleOf(prompt),
          messages: [...c.messages, { role: "user", text: prompt, at: startedAt }, { role: "assistant", text: text || "…", at: now }],
          updatedAt: now,
          workdir: c.workdir ?? REAL_CWD,
          permission: desktopPermission(modeRef.current),
        };
        setChat(next);
        chatRef.current = next;
        saveChat(sessionsFile, next, { current: LAUNCHED_BY_DESKTOP });
        turn.durationMs = Date.now() - startedAt;
        diag("turn-end", { status: turn.status, ms: turn.durationMs, up: turn.tokensUp, down: turn.tokensDown });
        setLast({ ...turn });
        cost.current.turns++;
        cost.current.tokensUp += turn.tokensUp;
        cost.current.tokensDown += turn.tokensDown;
        cost.current.durationMs += turn.durationMs;
      } catch (err) {
        turn.status = "error";
        turn.text = `Glyphh loop unavailable — ${(err as Error).message}`;
        turn.durationMs = Date.now() - startedAt;
        push({ kind: "note", text: turn.text });
        setLast({ ...turn });
      } finally {
        turnAbort.current = null;
        setPending(null); // a parked approval dies with its run
        setThinking(null);
        setBusy(false);
      }
    },
    [patchItem, push, sessionsFile, openPicker],
  );

  const stopTurn = useCallback(() => {
    turnAbort.current?.abort();
  }, []);

  const runCommand = useCallback(
    async (line: string) => {
      const id = push({ kind: "command", text: line });
      const ctx: CommandCtx = {
        version,
        cwd,
        keyed: hasProviderKey(),
        model: sessionModel ?? pickedModel,
        permission: mode,
        effort: sessionEffort ?? pickedEffort ?? DEFAULT_EFFORT,
        chatId: chatRef.current.id,
        cost: cost.current,
        setModel,
        setPermission,
        setEffort,
        setTheme,
        clearChat: () => {
          history.current = [];
          const fresh = newChat(REAL_CWD, modeRef.current);
          setChat(fresh);
          chatRef.current = fresh;
          setItems([]);
          setExpanded(false);
          setScroll(0);
          setLast(undefined);
        },
        quit: () => exit(),
        emit: (lines) => patchItem(id, (it) => ({ ...it, result: lines }) as Item),
        note: (text) => { push({ kind: "note", text }); },
        openPicker,
        sessionsFile,
        resumeChat,
      };
      const result = await runSlash(ctx, line);
      patchItem(id, (it) => ({ ...it, result }) as Item);
    },
    [cwd, exit, mode, patchItem, push, setModel, setPermission, setEffort, setTheme, version, sessionModel, pickedModel, sessionEffort, pickedEffort, openPicker, sessionsFile, resumeChat],
  );

  /** A prompt for the loop — or, with no key to run it on, where to put one. */
  const send = useCallback((prompt: string) => {
    const hasKey = hasProviderKey();
    setKeyed(hasKey);
    if (hasKey) return void runTurn(prompt);
    push({ kind: "user", text: prompt });
    for (const text of NO_KEY_LINES) push({ kind: "note", text });
  }, [push, runTurn]);

  const submit = useCallback(() => {
    const raw = inputRef.current.trim();
    if (!raw || busy) return;
    setLine("");
    prompts.current = rememberPrompt(raw);
    histIdx.current = prompts.current.length;
    if (raw.startsWith("/")) return void runCommand(raw);
    send(raw);
  }, [busy, runCommand, send, setLine]);

  const openingSent = useRef(false);
  useEffect(() => {
    if (!initialPrompt || openingSent.current) return;
    openingSent.current = true;
    send(initialPrompt);
  }, [initialPrompt, send]);

  // ── The line model — regenerated from items, so a fold toggle is retroactive. ──
  const width = Math.max(20, cols - 4);
  const effectiveModel = resolveModel(sessionModel, pickedModel);
  const lines = useMemo(() => {
    const out: Line[] = [];
    out.push(...headerLines(width, LOGO_MARK, {
      version,
      cwd,
      model: effectiveModel,
      keyed,
      tips: items.length ? [] : TIPS,
      notes: RELEASE_NOTES,
    }));
    for (const item of items) {
      if (item.kind === "user") out.push(...userLines(item.text, width));
      else if (item.kind === "command") out.push(...commandLines(item.text, item.result, width));
      else if (item.kind === "section") out.push(...sectionLines(item.step, expanded));
      else if (item.kind === "answer") out.push(...answerLines(item.text, width));
      else if (item.kind === "note") out.push(...noteLines(item.text));
    }
    return out;
  }, [items, expanded, width, version, keyed, cwd, effectiveModel]);

  // FULL HEIGHT. The renderer (render/fullscreen.ts) repaints only changed rows,
  // so a frame the size of the terminal is fine; the last row stays free for
  // Ink's trailing newline.
  const frameH = Math.max(6, rows - 1);
  const paneH = Math.max(3, frameH - chromeH.strip);
  const maxScroll = Math.max(0, lines.length - paneH);
  const clampedScroll = Math.min(scroll, maxScroll);
  const start = Math.max(0, lines.length - paneH - clampedScroll);
  const visible = lines.slice(start, start + paneH);

  const scrollBy = useCallback(
    (d: number) => setScroll((s) => Math.max(0, Math.min(Math.max(0, lines.length - paneH), s + d))),
    [lines.length, paneH],
  );

  const slashPrefix = /^\/(\S*)$/.exec(input)?.[1];
  const slashItems = slashPrefix !== undefined && !busy && !pending ? matchCommands(slashPrefix) : [];
  const slashOpen = slashItems.length > 0;
  const slashSelected = Math.min(slashSel, Math.max(0, slashItems.length - 1));

  const recall = useCallback((dir: -1 | 1) => {
    const list = prompts.current;
    if (!list.length) return;
    if (histIdx.current === list.length) stash.current = inputRef.current;
    const next = Math.max(0, Math.min(list.length, histIdx.current + dir));
    if (next === histIdx.current) return;
    histIdx.current = next;
    setLine(next === list.length ? stash.current : (list[next] ?? ""));
  }, [setLine]);

  useInput((ch, key) => {
    // A selector owns the keyboard (approvals included): ↑/↓, a digit jumps,
    // enter picks, the secondary key picks for the session, esc cancels.
    if (pending) {
      const { spec } = pending;
      const n = spec.options.length;
      const pick = (secondary: boolean): void => {
        const o = spec.options[pending.selected];
        setPending(null);
        if (o) spec.onPick(o.id, secondary);
      };
      if (key.upArrow) setPending({ ...pending, selected: (pending.selected + n - 1) % n });
      else if (key.downArrow) setPending({ ...pending, selected: (pending.selected + 1) % n });
      else if (/^[1-9]$/.test(ch) && Number(ch) <= n) setPending({ ...pending, selected: Number(ch) - 1 });
      else if (key.return) pick(false);
      else if (spec.secondary && ch === spec.secondary.key) pick(true);
      else if (key.escape || (key.ctrl && ch === "c")) { setPending(null); spec.onCancel?.(); }
      return;
    }
    if (key.ctrl && ch === "c") {
      const now = Date.now();
      if (busy) { stopTurn(); return; }
      if (inputRef.current) { setLine(""); return; }
      if (now - lastCtrlC.current < QUIT_WINDOW_MS) { exit(); return; }
      lastCtrlC.current = now;
      showHint("press ctrl+c again to quit");
      return;
    }
    if (key.escape) {
      if (busy) stopTurn();
      else if (inputRef.current) setLine("");
      return;
    }
    if (key.ctrl && ch === "o") {
      setExpanded((e) => !e);
      return;
    }
    if ((key.tab && key.shift) || ch === "[Z") {
      const i = PERMISSION_CYCLE.indexOf(mode);
      setPermission(PERMISSION_CYCLE[(i + 1) % PERMISSION_CYCLE.length]!);
      return;
    }
    if (slashOpen) {
      if (key.upArrow) { setSlashSel((s) => (s + slashItems.length - 1) % slashItems.length); return; }
      if (key.downArrow) { setSlashSel((s) => (s + 1) % slashItems.length); return; }
      if (key.tab) { setLine(`/${slashItems[slashSelected]!.name} `); return; }
      if (key.return) {
        const picked = slashItems[slashSelected]!;
        if (`/${picked.name}` !== inputRef.current.trim()) setLine(`/${picked.name}`);
        submit();
        return;
      }
    }
    if (key.tab) return;
    if (key.upArrow) { recall(-1); return; }
    if (key.downArrow) { recall(1); return; }
    if (key.pageUp) { scrollBy(paneH - 1); return; }
    if (key.pageDown) { scrollBy(-(paneH - 1)); return; }
    if (key.leftArrow) { setLine(inputRef.current, cursorRef.current - 1); return; }
    if (key.rightArrow) { setLine(inputRef.current, cursorRef.current + 1); return; }
    if (key.ctrl && ch === "a") { setLine(inputRef.current, 0); return; }
    if (key.ctrl && ch === "e") { setLine(inputRef.current); return; }
    if (key.ctrl && ch === "u") { setLine(""); return; }
    if ((key.ctrl && ch === "w") || (key.meta && (key.backspace || key.delete))) {
      const r = deleteWordBefore(inputRef.current, cursorRef.current);
      setLine(r.value, r.cursor);
      return;
    }
    if (key.return) {
      submit();
      return;
    }
    if (key.backspace || key.delete) {
      const chars = cps(inputRef.current);
      const at = cursorRef.current;
      if (at === 0) return;
      setLine([...chars.slice(0, at - 1), ...chars.slice(at)].join(""), at - 1);
      return;
    }
    // "?" on an empty line: the shortcuts, the way the other CLIs answer it.
    if (ch === "?" && !inputRef.current && !busy) { void runCommand("/help"); return; }
    if (ch && !key.ctrl && !key.meta) {
      const nl = ch.search(/[\r\n]/);
      const insert = (s: string): void => {
        const chars = cps(inputRef.current);
        const at = cursorRef.current;
        setLine([...chars.slice(0, at), s, ...chars.slice(at)].join(""), at + cps(s).length);
      };
      if (nl >= 0) {
        const before = ch.slice(0, nl);
        if (before) insert(before);
        submit();
        return;
      }
      if (ch >= " ") { insert(ch); histIdx.current = prompts.current.length; }
    }
  });

  const slots: FooterSlot[] = [{ label: "model", model: effectiveModel }];
  const effortLabel = EFFORT_LABEL[sessionEffort ?? pickedEffort ?? DEFAULT_EFFORT];

  return (
    <Box flexDirection="column" width={cols} height={frameH}>
      {/* THE PANE: the card and the transcript, following the tail unless scrolled. */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} paddingX={1} overflow="hidden">
        {visible.map((l, i) => <TranscriptLine key={`${start + i}`} line={l} />)}
      </Box>
      {clampedScroll > 0 ? (
        <Text color={theme.faint}>{`  ↓ ${clampedScroll} lines below · pgup/pgdn scrolls`}</Text>
      ) : null}
      {/* THE STRIP, pinned to the bottom. */}
      <Box flexDirection="column" flexShrink={0} ref={stripBox}>
        <SubFooter width={cols} busy={busy} elapsed={elapsed} last={last} verb={verb} {...(thinking !== null ? { thinking } : {})} />
        {pending ? <Picker width={cols} spec={pending.spec} selected={pending.selected} /> : null}
        {slashOpen ? <SlashMenu width={cols} items={slashItems} selected={slashSelected} /> : null}
        <InputBar width={cols} value={input} cursor={cursor} busy={busy} {...(hint ? { hint } : {})} />
        <Footer width={cols} permissionMode={mode} loop="glyphh" slots={slots} effort={effortLabel} />
      </Box>
    </Box>
  );
}
