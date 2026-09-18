/**
 * settings-download.ts — the platform's Download page (his spec, 2026-08-27):
 * the latest desktop build front and center, a table of previous releases
 * beneath it. The releases repo is PRIVATE (his order, 2026-09-18), so this
 * asks the server, which reads GitHub with the token and signs each download.
 * Those URLs expire, which is why one is fetched on the click rather than
 * rendered into a page somebody may leave open.
 */

import { escapeHtml, paginate, renderPaginationBar } from "./shared.js";

interface GhAsset { name: string; size: number }
interface GhRelease { tag_name: string; published_at: string | null; assets: GhAsset[] }

type Bridge = {
  releasesList?: () => Promise<{ ok: boolean; releases?: Array<{ tag: string; publishedAt: string | null; assets: GhAsset[] }>; error?: string }>;
  releasesAssetUrl?: (tag: string, name: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
};

function bridge(): Bridge {
  return (window as unknown as { glyphh?: Bridge }).glyphh ?? {};
}

async function startDownload(tag: string, asset: string): Promise<void> {
  const r = await bridge().releasesAssetUrl?.(tag, asset);
  if (!r?.ok || !r.url) throw new Error(r?.error || "could not start that download");
  window.open(r.url, "_blank");
}

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
let query = "";

let searchWired = false;
export async function loadDownload(): Promise<void> {
  const search = document.getElementById("dl-search") as HTMLInputElement | null;
  if (search && !searchWired) {
    searchWired = true;
    search.addEventListener("input", () => { query = search.value; page = 1; render(); });
  }
  const latestEl = document.getElementById("dl-latest");
  const listEl = document.getElementById("dl-list");
  const errEl = document.getElementById("dl-error");
  if (!latestEl || !listEl) return;
  errEl?.classList.add("hidden");
  if (!releases.length) latestEl.innerHTML = `<div class="crud-empty">Loading releases…</div>`;
  try {
    const r = await bridge().releasesList?.();
    if (!r?.ok || !r.releases) throw new Error(r?.error || "the server could not read the release list");
    // The server already orders by publish date, which row-creation order does
    // not match (v1.1.0-beta.16 once sat below beta.2 in GitHub's raw list).
    releases = r.releases.map((x) => ({ tag_name: x.tag, published_at: x.publishedAt, assets: x.assets }));
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
    const link = document.createElement("button");
    link.className = "action-btn" + (t.key === mine ? " primary" : "");
    link.textContent = `${t.label}${a!.size ? ` · ${fmtSize(a!.size)}` : ""}`;
    link.addEventListener("click", () => {
      void startDownload(latest.tag_name, t.asset).catch((err: Error) => {
        const errEl = document.getElementById("dl-error");
        if (errEl) { errEl.textContent = err.message; errEl.classList.remove("hidden"); }
      });
    });
    btns.appendChild(link);
  }

  // ── Previous releases — the standard table, header always standing ──
  const q = query.trim().toLowerCase();
  const prior = releases.slice(1).filter((r) => !q || r.tag_name.toLowerCase().includes(q));
  const { items, state } = paginate(prior, page);
  page = state.page;
  listEl.innerHTML = "";
  const table = document.createElement("table");
  table.className = "lib-table mbr-table";
  table.innerHTML = `<thead><tr><th>Version</th><th>Released</th><th>Downloads</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="color:var(--text-3);padding:14px 12px;">${q ? `Nothing matching “${escapeHtml(query.trim())}”` : "No previous releases."}</td></tr>`;
  }
  for (const r of items) {
    const tr = document.createElement("tr");
    const links = TARGETS.map((t) => ({ t, a: assetFor(r, t.asset) })).filter((x) => x.a)
      .map(({ t }) => `<button class="dl-asset-link" data-tag="${escapeHtml(r.tag_name)}" data-asset="${escapeHtml(t.asset)}">${escapeHtml(t.label.split(" — ")[0]! + (t.key === "mac-x64" ? " Intel" : t.key === "mac-arm64" ? " Silicon" : ""))}</button>`)
      .join(" · ");
    tr.innerHTML = `
      <td class="lib-table-name">${escapeHtml(r.tag_name)}</td>
      <td class="lib-table-dim">${escapeHtml(fmtDay(r.published_at))}</td>
      <td class="lib-table-dim">${links || "—"}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  for (const el of Array.from(tbody.querySelectorAll<HTMLButtonElement>(".dl-asset-link"))) {
    el.addEventListener("click", () => {
      void startDownload(el.dataset.tag || "", el.dataset.asset || "").catch((err: Error) => {
        const errEl = document.getElementById("dl-error");
        if (errEl) { errEl.textContent = err.message; errEl.classList.remove("hidden"); }
      });
    });
  }
  listEl.appendChild(table);
  listEl.appendChild(renderPaginationBar(state, (p) => { page = p; render(); }));
}
