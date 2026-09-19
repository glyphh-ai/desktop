/**
 * Settings → Memory (his order, 2026-09-19): the policy a user accepts before
 * Glyphh remembers anything, the preferences that shape it, the org's
 * overrides on top, and the door to clear it all.
 *
 * Effective = accepted AND (org says on → on; org says off → off; else the
 * user's own toggle). Main reads the same preferences and the same gates, so
 * what this page shows is what the bridge does.
 */
import { loadEmbeddingsSettings } from "./settings-loops.js";
import { planGates, invalidatePlanGates } from "./plan-gate.js";
import { confirmAction } from "./shared.js";
import { toastOk } from "./toast.js";

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const notice = (msg: string): void => { toastOk(msg); };

type Rule = "member" | "on" | "off";
interface MemoryPolicy { inject?: Rule; capture?: Rule; sensitive?: Rule }

const PREFS = { inject: "memoryInject", capture: "memoryCapture", sensitive: "memorySensitive" } as const;
const DEFAULTS: Record<keyof typeof PREFS, boolean> = { inject: true, capture: true, sensitive: false };

export async function loadMemorySettings(): Promise<void> {
  const g = window.glyphh as unknown as {
    getPreference?: (k: string, d: unknown) => Promise<unknown>;
    setPreference?: (k: string, v: unknown) => void;
    memoryStats?: () => Promise<{ ok: boolean; turns?: number; chunks?: number; facts?: number }>;
    memoryClear?: () => Promise<{ ok: boolean; deleted?: number; error?: string }>;
  };
  invalidatePlanGates();
  const gates = await planGates() as unknown as { memoryPolicy?: MemoryPolicy };
  const policy: MemoryPolicy = gates.memoryPolicy ?? {};
  const accepted = !!(await g.getPreference?.("memoryPolicyAcceptedAt", ""));

  const acceptBox = el<HTMLInputElement>("toggle-memory-policy");
  const acceptDesc = el("memory-policy-desc");
  if (acceptBox) {
    acceptBox.checked = accepted;
    if (acceptDesc) acceptDesc.textContent = accepted ? "Accepted. Memory follows the preferences below." : "Memory stays off until you accept.";
    acceptBox.onchange = () => {
      g.setPreference?.("memoryPolicyAcceptedAt", acceptBox.checked ? new Date().toISOString() : "");
      void loadMemorySettings();
    };
  }

  el("memory-accept-note")?.classList.toggle("hidden", accepted);
  const note = el("memory-org-note");
  const forced = (Object.entries(policy) as Array<[keyof typeof PREFS, Rule]>).filter(([, r]) => r === "on" || r === "off");
  if (note) {
    note.classList.toggle("hidden", forced.length === 0);
    if (forced.length) note.textContent = "Your organization sets: " + forced.map(([k, r]) => `${LABEL[k]} ${r}`).join(", ") + ". Those rows follow the org.";
  }

  for (const key of Object.keys(PREFS) as Array<keyof typeof PREFS>) {
    const box = el<HTMLInputElement>(`toggle-memory-${key}`);
    if (!box) continue;
    const rule = policy[key] ?? "member";
    const own = await g.getPreference?.(PREFS[key], DEFAULTS[key]);
    const value = rule === "on" ? true : rule === "off" ? false : own !== false && (own === true || DEFAULTS[key]);
    box.checked = value;
    box.disabled = !accepted || rule !== "member";
    box.onchange = () => { g.setPreference?.(PREFS[key], box.checked); };
  }

  await loadEmbeddingsSettings();

  const stats = el("memory-stats");
  if (stats) {
    const r = await g.memoryStats?.().catch(() => null);
    stats.textContent = r?.ok
      ? `${r.turns ?? 0} turns in ${r.chunks ?? 0} pieces on this machine${r.facts ? `, ${r.facts} saved facts` : ""}.`
      : "Nothing yet.";
  }
  const clearBtn = el<HTMLButtonElement>("memory-clear-btn");
  if (clearBtn) {
    clearBtn.onclick = async () => {
      const sure = await confirmAction({ title: "Clear memory?", body: "Every remembered turn on this machine is deleted. Saved facts stay.", confirmLabel: "Clear", danger: true });
      if (!sure) return;
      const r = await g.memoryClear?.();
      if (r?.ok) { notice("Memory cleared"); void loadMemorySettings(); }
      else notice(r?.error || "Couldn't clear memory.");
    };
  }
}

const LABEL: Record<keyof typeof PREFS, string> = { inject: "search past sessions", capture: "generate memory", sensitive: "sensitive topics" };
