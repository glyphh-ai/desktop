/**
 * Ada workspace indexer — mirrors the workspace catalog into fact memory.
 *
 * Everything nameable becomes a structured fact via tell_raw (no LLM —
 * shapes are known): library apps, saved layouts, connected accounts,
 * connector tools, installed Glyphh-app tools, drips. Facts are KEYED
 * (`tool:gmail:gmail-find-email`, `app:gmail`, …) and tell_raw is
 * idempotent on identical content, so syncing is safe at any frequency —
 * real changes version, everything else no-ops.
 *
 * Sync triggers: delayed boot pass, a 15-minute heartbeat, and
 * opportunistic indexing whenever connector tools are fetched anyway.
 * Sources of truth stay the server/OS; Ada is the fast queryable mirror:
 *   who {entity.kind: tool, relational.object: gmail}  → gmail's tools
 *   ada_recall("find email")                           → ranked matches
 */

import { adaTellRaw } from "./store";
import { fetchOrgApps } from "../org-apps";
import { fetchServerLayouts } from "../layout-manager";
import { getClient } from "../glyphh-client";
import { connectorTools } from "../glyphh-app-services";
import { listInstalledAppTools } from "../glyphh-app-host";
import { BUILTIN_EFFECTS, getDripManagerInstance } from "../drip-manager";

const norm = (s: unknown) => String(s ?? "").trim();

function tellCatalog(key: string, content: string, facts: Record<string, Record<string, string>>): number {
  try { return adaTellRaw(content, facts, { key, speaker: "indexer" }).slots; } catch { return 0; }
}

export function indexConnectorTools(connector: string, tools: Array<{ name: string; description?: string }>): void {
  for (const t of tools) {
    const name = norm(t.name);
    if (!name) continue;
    tellCatalog(
      `tool:${connector}:${name}`,
      `${name} — ${connector} connector tool: ${norm(t.description) || "(no description)"}`,
      {
        entity: { name, kind: "tool", subkind: "connector" },
        relational: { subject: name, predicate: "belongs_to", object: connector },
        epistemic: { source: "pipedream" },
      },
    );
  }
}

export async function syncWorkspaceFacts(): Promise<{ facts: number }> {
  let facts = 0;

  // Library apps
  try {
    const apps = await fetchOrgApps();
    for (const a of apps) {
      const slug = norm(a.slug) || norm(a.name).toLowerCase();
      facts += tellCatalog(
        `app:${slug}`,
        `${a.name} (${slug}) — ${a.isBrowser === false ? "native app" : "web app"}${a.url ? ` at ${a.url}` : ""}${a.execPath ? ` (${a.execPath})` : ""}; open with open_app("${slug}")`,
        {
          entity: { name: slug, kind: "app", subkind: a.isBrowser === false ? "native" : "web" },
          relational: { subject: slug, predicate: "opens_with", object: "open_app" },
        },
      );
    }
  } catch { /* signed out / offline */ }

  // Saved layouts
  try {
    const layouts = await fetchServerLayouts();
    for (const l of layouts) {
      const name = norm(l.name);
      facts += tellCatalog(
        `layout:${name.toLowerCase()}`,
        `${name} — saved layout (${l.cells?.length ?? 0} cells); open with open_layout("${name}")`,
        {
          entity: { name: name.toLowerCase(), kind: "layout" },
          relational: { subject: name.toLowerCase(), predicate: "opens_with", object: "open_layout" },
          quantitative: { count: String(l.cells?.length ?? 0) },
        },
      );
    }
  } catch { /* offline */ }

  // Connected accounts + their connector tools
  try {
    const connections = await getClient().connections.list();
    const slugs = new Set(connections.map((c) => norm(c.slug)).filter(Boolean));
    for (const c of connections) {
      const slug = norm(c.slug);
      if (!slug) continue;
      facts += tellCatalog(
        `connection:${slug}`,
        `${c.name || slug} (${slug}) — connected account${c.enabled ? "" : " (disabled)"}; its API tools are first-class agent tools`,
        {
          entity: { name: slug, kind: "connection" },
          epistemic: { source: c.kind, certainty: c.enabled ? "healthy" : "disabled" },
        },
      );
    }
    for (const slug of slugs) {
      try {
        const tools = await connectorTools(slugs, { connector: slug });
        indexConnectorTools(slug, tools);
        facts += tools.length;
      } catch { /* connector catalog unavailable */ }
    }
  } catch { /* signed out */ }

  // Installed Glyphh-app tools
  try {
    for (const app of await listInstalledAppTools()) {
      for (const t of app.tools || []) {
        facts += tellCatalog(
          `tool:${app.app}:${t.name}`,
          `${t.name} — ${app.app} app tool: ${norm(t.description) || "(no description)"}; run with app_call_tool`,
          {
            entity: { name: t.name, kind: "tool", subkind: "glyphh-app" },
            relational: { subject: t.name, predicate: "belongs_to", object: app.app },
          },
        );
      }
    }
  } catch { /* host not ready */ }

  // Drips
  try {
    const customs = getDripManagerInstance()?.listCustoms() ?? [];
    for (const name of [...BUILTIN_EFFECTS, ...customs.map((c) => c.name)]) {
      facts += tellCatalog(
        `drip:${name}`,
        `${name} — drip effect; play with run_drip("${name}")`,
        { entity: { name, kind: "drip" }, relational: { subject: name, predicate: "opens_with", object: "run_drip" } },
      );
    }
  } catch { /* drips not up yet */ }

  return { facts };
}

let syncTimer: ReturnType<typeof setInterval> | null = null;

/** Boot registration: first pass after auth settles, then a heartbeat.
 *  Idempotent writes make the frequency free. */
export function registerAdaSync(): void {
  setTimeout(() => { void syncWorkspaceFacts(); }, 10_000);
  if (!syncTimer) {
    syncTimer = setInterval(() => { void syncWorkspaceFacts(); }, 15 * 60_000);
  }
}
