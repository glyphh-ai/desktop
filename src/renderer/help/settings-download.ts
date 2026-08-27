/**
 * settings-download.ts — the platform's Download page (his spec, 2026-08-27):
 * the latest desktop build front and center, a table of previous releases
 * beneath it. Pulls straight from the PUBLIC glyphh-releases repo — the same
 * source the marketing site's /api/download proxies — no server seam needed:
 * the repo is public and every asset carries a public browser_download_url.
 */

import { escapeHtml, paginate, renderPaginationBar } from "./shared.js";

const RELEASES_API = "https://api.github.com/repos/glyphh-ai/glyphh-releases/releases?per_page=30";

interface GhAsset { name: string; browser_download_url: string; size: number }
interface GhRelease { tag_name: string; published_at: string | null; body?: string | null; assets: GhAsset[] }

/** The download targets, in display order. `asset` is the exact CI artifact name. */
const TARGETS: ReadonlyArray<{ key: string; label: string; asset: string }> = [
  { key: "mac-arm64", label: "macOS — Apple Silicon", asset: "Glyphh-arm64.dmg" },
  { key: "mac-x64",   label: "macOS — Intel",         asset: "Glyphh-x64.dmg" },
  { key: "win",       label: "Windows",               asset: "Glyphh-Setup.exe" },
  { key: "linux",     label: "Linux — AppImage",      asset: "Glyphh-x86_64.AppImage" },
];

/** Best guess at the visitor's platform, for the primary button. */
function detectTarget(): string {
  const p = (navigator.platform || "") + " " + navigator.userAgent;
  if (/Win/i.test(p)) return "win";
  if (/Linux/i.test(p) && !/Mac/i.test(p)) return "linux";
  // Apple Silicon vs Intel is not reliably detectable from a browser — the
  // arm64 default matches every Mac Apple has sold since 2020.
  return "mac-arm64";
}

function fmtSize(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

let releases: GhRelease[] = [];
let page = 1;

export async function loadDownload(): Promise<void> {
  const latestEl = document.getElementById("dl-latest");
  const listEl = document.getElementById("dl-list");
  const errEl = document.getElementById("dl-error");
  if (!latestEl || !listEl) return;
  errEl?.classList.add("hidden");
  if (!releases.length) latestEl.innerHTML = `<div class="crud-empty">Loading releases…</div>`;
  try {
    const res = await fetch(RELEASES_API, { cache: "no-store" });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    releases = (await res.json()) as GhRelease[];
    // GitHub orders by row-creation, and mirror-released rows can be created
    // out of publish order (v1.1.0-beta.16 sat below beta.2 in the raw list).
    releases.sort((a, b) => (b.published_at || "").localeCompare(a.published_at || ""));
  } catch (e) {
    if (errEl) { errEl.textContent = `Couldn't load releases — ${(e as Error).message}`; errEl.classList.remove("hidden"); }
    if (!releases.length) latestEl.innerHTML = "";
    return;
  }
  render();
}

function assetFor(r: GhRelease, name: string): GhAsset | undefined {
  return r.assets.find((a) => a.name === name);
}

function render(): void {
  const latestEl = document.getElementById("dl-latest")!;
  const listEl = document.getElementById("dl-list")!;
  const latest = releases[0];
  if (!latest) { latestEl.innerHTML = `<div class="crud-empty">No releases yet.</div>`; listEl.innerHTML = ""; return; }

  // ── The latest build: the visitor's platform leads, the rest beside it ──
  const mine = detectTarget();
  const rows = TARGETS.map((t) => ({ t, a: assetFor(latest, t.asset) })).filter((x) => x.a);
  latestEl.innerHTML = `
    <div class="dl-hero">
      <div class="dl-hero-head">
        <span class="dl-hero-ver">${escapeHtml(latest.tag_name)}</span>
        <span class="dl-hero-date">${escapeHtml(fmtDay(latest.published_at))} · latest</span>
      </div>
      <div class="dl-hero-btns"></div>
    </div>`;
  const btns = latestEl.querySelector(".dl-hero-btns")!;
  for (const { t, a } of rows) {
    const link = document.createElement("a");
    link.className = "action-btn" + (t.key === mine ? " primary" : "");
    link.href = a!.browser_download_url;
    link.textContent = `${t.label}${a!.size ? ` · ${fmtSize(a!.size)}` : ""}`;
    btns.appendChild(link);
  }

  // ── Previous releases — the standard table, header always standing ──
  const prior = releases.slice(1);
  const { items, state } = paginate(prior, page);
  page = state.page;
  listEl.innerHTML = "";
  const table = document.createElement("table");
  table.className = "lib-table mbr-table";
  table.innerHTML = `<thead><tr><th>Version</th><th>Released</th><th>Downloads</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="color:var(--text-3);padding:14px 12px;">No previous releases.</td></tr>`;
  }
  for (const r of items) {
    const tr = document.createElement("tr");
    const links = TARGETS.map((t) => ({ t, a: assetFor(r, t.asset) })).filter((x) => x.a)
      .map(({ t, a }) => `<a class="dl-asset-link" href="${escapeHtml(a!.browser_download_url)}">${escapeHtml(t.label.split(" — ")[0]! + (t.key === "mac-x64" ? " Intel" : t.key === "mac-arm64" ? " Silicon" : ""))}</a>`)
      .join(" · ");
    tr.innerHTML = `
      <td class="lib-table-name">${escapeHtml(r.tag_name)}</td>
      <td class="lib-table-dim">${escapeHtml(fmtDay(r.published_at))}</td>
      <td class="lib-table-dim">${links || "—"}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  listEl.appendChild(table);
  listEl.appendChild(renderPaginationBar(state, (p) => { page = p; render(); }));
}
