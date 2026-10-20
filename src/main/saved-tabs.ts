/**
 * saved-tabs — the user's SAVED TABS (Settings → Tabs: web pages and native
 * launchers the app library opens as panels), as one write path shared by the
 * Tabs page (apps-ipc) and the agent's tools (relay-handlers → local MCP
 * `panels_add` / `panels_remove`). His order, 2026-09-23: the agent could list
 * and open tabs but not add or remove them, so twenty-five bookmarks meant
 * twenty-five trips through the form.
 */
import * as appsStore from "./apps-store";
import { fetchOrgApps } from "./org-apps";
import { refreshForceWebSlugs } from "./force-web";
import { broadcast } from "./broadcast";

/** The work panels are built in — a tab may neither shadow nor remove them. */
export const BUILTIN_WORKPANELS = new Set(["gpoint", "gdoc", "gsheet", "gdrive"]);
export const WORKPANEL_REFUSAL = "work panels are built in — they cannot be altered or removed";

/** The slug a name yields — the same rule the Tabs page applies. */
export const tabSlugOf = (s: string): string =>
  String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** After any tab change: the force-web guard set, and every renderer (the
 *  wall and the Tabs page hear panel-apps-changed). */
function tabsChanged(): void {
  setTimeout(() => { void refreshForceWebSlugs(); }, 500);
  broadcast("panel-apps-changed");
}

export async function addSavedTab(input: { name?: string; url?: string; slug?: string }): Promise<{ app: string; name: string; url: string }> {
  const name = String(input.name || "").trim();
  const url = String(input.url || "").trim();
  if (!name) throw new Error("a tab needs a name");
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error("a tab needs an http(s) url");
  const slug = tabSlugOf(input.slug || name);
  if (!slug) throw new Error("a tab needs a name that yields a slug (letters or digits)");
  if (BUILTIN_WORKPANELS.has(slug)) throw new Error(WORKPANEL_REFUSAL);
  const existing = await fetchOrgApps().catch(() => []);
  if (existing.some((a) => a.slug === slug)) throw new Error(`a tab named "${slug}" already exists — pick another slug`);
  await appsStore.createEntry({ kind: "web", slug, name, url });
  tabsChanged();
  return { app: slug, name, url };
}

export async function removeSavedTab(ref: string): Promise<{ app: string; removed: true }> {
  const key = String(ref || "").trim().toLowerCase();
  if (!key) throw new Error("panels.remove requires { app }");
  const rows = await fetchOrgApps().catch(() => []);
  const row = rows.find((a) => a.slug === key || a.id === key || a.name.toLowerCase() === key);
  const slug = row?.slug ?? key;
  if (BUILTIN_WORKPANELS.has(slug)) throw new Error(WORKPANEL_REFUSAL);
  if (!row) throw new Error(`no saved tab "${ref}" — panels_available lists them`);
  if (row.system || row.appArchetype === "glyphh-app") throw new Error(`"${slug}" is not a saved tab — an installed app is removed from Settings → Apps`);
  await appsStore.removeEntry(slug);
  tabsChanged();
  return { app: slug, removed: true };
}
