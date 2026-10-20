/**
 * slides/layouts.ts — the LAYOUT REGISTRY.
 *
 * Each layout is a pure `(content, ctx) => innerHTML` function that renders
 * typed content into the inside of a `<section class="slide">`, using the
 * shared base classes + theme vars. The agent supplies STRUCTURED CONTENT and
 * picks a layout; it never authors HTML or CSS. Build-step reveals use the
 * shell's `.frag` mechanism (elements marked `frag` appear on advance).
 */

import type { FieldSchema, LayoutFn, LayoutSpec, RenderCtx, SlideSpec } from "./types.js";
import { esc, s, list, rows, hasMedia } from "./util.js";
import { renderSlideChart, type SlideChartType } from "./chart-svg.js";

// ── small emit helpers ───────────────────────────────────────────────────────
const eyebrow = (v: unknown): string => (s(v) ? `<p class="gp-eyebrow">${esc(v)}</p>` : "");
const rule = (): string => `<div class="gp-rule"></div>`;

/** The motion vocabulary — every name has matching CSS in base-css.ts. */
export const MOTION_FX = ["fade", "up", "down", "left", "right", "zoom", "zoom-out", "blur", "rise", "wipe", "pop"] as const;
const FX = new Set<string>(MOTION_FX);

/** The slide-entrance class for a spec's universal `enter` field. */
const enterCls = (c: SlideSpec): string => {
  const e = s(c.enter);
  return e && FX.has(e) ? ` gp-enter-${e}` : "";
};
/** The fragment effect from the first valid candidate (per-item fx → spec fx). */
const fxOf = (...vals: unknown[]): string | undefined => {
  for (const v of vals) { const f = s(v); if (f && FX.has(f)) return f; }
  return undefined;
};

/** Reveal-on-advance wrapper (build step i, optional per-fragment effect).
 *  Injects into the first real tag — merging with an existing class attribute
 *  and tolerating leading whitespace. (The old regex required the string to
 *  START with `<`, so indented fragments — cards, team, timeline — silently
 *  never became build steps, and an existing class attr was shadowed.) */
const frag = (i: number, html: string, fx?: string): string => {
  const fxAttr = fx && FX.has(fx) ? ` data-fx="${fx}"` : "";
  return html.replace(/^(\s*)<(\w+)((?:[^>"']|"[^"]*"|'[^']*')*?)>/, (_m, ws: string, tag: string, attrs: string) => {
    const withClass = /class="/.test(attrs) ? attrs.replace(/class="/, `class="frag `) : `${attrs} class="frag"`;
    return `${ws}<${tag}${withClass} data-step="${i}"${fxAttr}>`;
  });
};

// ── layouts ──────────────────────────────────────────────────────────────────

const title: LayoutFn = (c, ctx) => {
  const logo = ctx.media(c.logo);
  return `${bgFill(c, ctx)}
<div class="gp-frame center${enterCls(c)}">
  ${logo ? `<img class="gp-logoimg" src="${logo}" alt="" />` : ""}
  ${eyebrow(c.eyebrow)}
  <h1 class="gp-title lg">${esc(c.title)}</h1>
  ${s(c.subtitle) ? `<p class="gp-sub frag" data-step="1">${esc(c.subtitle)}</p>` : ""}
</div>`;
};

const sectionDivider: LayoutFn = (c) => `
<div class="gp-frame${enterCls(c)}">
  ${s(c.number) ? `<p class="gp-kicker">${esc(c.number)}</p>` : ""}
  ${rule()}
  <h1 class="gp-title">${esc(c.title)}</h1>
  ${s(c.subtitle) ? `<p class="gp-sub">${esc(c.subtitle)}</p>` : ""}
</div>`;

const bullets: LayoutFn = (c) => {
  const fx = fxOf(c.fx);
  const pts = list(c.points);
  const items = pts.map((p, i) => frag(i + 1, `<li>${inline(p)}</li>`, fx)).join("");
  const fit = pts.length >= 8 ? ` style="--n:${pts.length}"` : "";   // count-based shrink past 7 (see base-css)
  return `
<div class="gp-frame top${enterCls(c)}" style="justify-content:center">
  ${eyebrow(c.eyebrow)}
  <h2 class="gp-title sm">${esc(c.title)}</h2>
  <ul class="gp-bullets ${c.style === "check" ? "check" : ""}"${fit}>${items}</ul>
</div>`;
};

const twoColumn: LayoutFn = (c) => {
  const col = (head: unknown, body: unknown): string => `
    <div class="gp-col">
      ${s(head) ? `<p class="gp-colhead">${esc(head)}</p>` : ""}
      ${colBody(body)}
    </div>`;
  return `
<div class="gp-frame top${enterCls(c)}" style="justify-content:center">
  ${eyebrow(c.eyebrow)}
  ${s(c.title) ? `<h2 class="gp-title sm" style="margin-bottom:20px">${esc(c.title)}</h2>` : ""}
  <div class="gp-grid2">
    ${col((c.left as Record<string, unknown>)?.heading ?? c.leftHeading, (c.left as Record<string, unknown>)?.body ?? c.leftBody ?? c.left)}
    ${col((c.right as Record<string, unknown>)?.heading ?? c.rightHeading, (c.right as Record<string, unknown>)?.body ?? c.rightBody ?? c.right)}
  </div>
</div>`;
};

const imageSide = (side: "left" | "right"): LayoutFn => (c, ctx) => {
  const media = mediaBox(c.media ?? c.image, ctx);
  const text = `
    <div class="gp-col">
      ${eyebrow(c.eyebrow)}
      <h2 class="gp-title sm">${esc(c.title)}</h2>
      ${colBody(c.body ?? c.points)}
    </div>`;
  const order = side === "left" ? [media, text] : [text, media];
  return `
<div class="gp-frame${enterCls(c)}" style="padding-block:var(--slide-pad)">
  <div class="gp-grid2 media">${order.join("")}</div>
</div>`;
};

const quote: LayoutFn = (c) => `
<div class="gp-frame${enterCls(c)}">
  <blockquote class="gp-quote"><span class="mark">“</span>${esc(c.quote ?? c.text)}<span class="mark">”</span></blockquote>
  ${s(c.attribution ?? c.author) ? `<p class="gp-cite">— <b>${esc(c.attribution ?? c.author)}</b>${s(c.role) ? `, ${esc(c.role)}` : ""}</p>` : ""}
</div>`;

const bigStat: LayoutFn = (c) => {
  const many = rows(c.stats);
  if (many.length > 1) {
    const cells = many.slice(0, 4).map((st) => `
      <div>
        <p class="gp-stat">${esc(st.stat ?? st.value)}</p>
        <p class="gp-statlabel">${esc(st.label)}</p>
      </div>`).join("");
    return `
<div class="gp-frame${enterCls(c)}">
  ${s(c.title) ? `<h2 class="gp-title sm" style="margin-bottom:20px">${esc(c.title)}</h2>` : ""}
  <div class="gp-stats-row">${cells}</div>
</div>`;
  }
  return `
<div class="gp-frame center${enterCls(c)}">
  <p class="gp-stat">${esc(c.stat ?? c.value)}</p>
  <p class="gp-statlabel">${esc(c.label)}</p>
  ${s(c.caption) ? `<p class="gp-statcap">${esc(c.caption)}</p>` : ""}
</div>`;
};

const cards: LayoutFn = (c) => {
  const items = rows(c.cards ?? c.items);
  const fx = fxOf(c.fx) ?? "up";
  const wide = items.length <= 2 && items.length > 0 ? "gp-grid2c" : "gp-grid3";
  const cells = items.slice(0, 6).map((it, i) => frag(i + 1, `
    <div class="gp-card">
      ${s(it.label ?? it.number) ? `<p class="gp-cardnum">${esc(it.label ?? it.number)}</p>` : ""}
      <h3>${esc(it.title ?? it.heading)}</h3>
      ${s(it.body ?? it.text) ? `<p>${esc(it.body ?? it.text)}</p>` : ""}
    </div>`, fxOf(it.fx) ?? fx)).join("");
  return `
<div class="gp-frame top${enterCls(c)}" style="justify-content:center">
  ${eyebrow(c.eyebrow)}
  ${s(c.title) ? `<h2 class="gp-title sm" style="margin-bottom:44px">${esc(c.title)}</h2>` : ""}
  <div class="${wide}">${cells}</div>
</div>`;
};

const comparison: LayoutFn = (c) => {
  const side = (col: unknown, fallbackHead: unknown, fallbackPts: unknown): string => {
    const o = (col ?? {}) as Record<string, unknown>;
    const head = o.heading ?? o.title ?? fallbackHead;
    const points = o.points ?? o.body ?? fallbackPts;
    const li = list(points).map((p) => `<li>${inline(p)}</li>`).join("");
    return `
      <div class="gp-card" style="gap:26px">
        <h3>${esc(head)}</h3>
        <ul class="gp-bullets" style="margin-top:8px;gap:22px">${li}</ul>
      </div>`;
  };
  return `
<div class="gp-frame top${enterCls(c)}" style="justify-content:center">
  ${eyebrow(c.eyebrow)}
  ${s(c.title) ? `<h2 class="gp-title sm" style="margin-bottom:40px">${esc(c.title)}</h2>` : ""}
  <div class="gp-grid2c">
    ${side(c.left, c.leftHeading, c.leftPoints)}
    ${side(c.right, c.rightHeading, c.rightPoints)}
  </div>
</div>`;
};

const timeline: LayoutFn = (c) => {
  const items = rows(c.items ?? c.milestones).slice(0, 5);
  const fx = fxOf(c.fx) ?? "left";
  const cells = items.map((it, i) => frag(i + 1, `
    <div class="gp-tl">
      <p class="date">${esc(it.date ?? it.when)}</p>
      <p class="label">${esc(it.label ?? it.title)}</p>
      ${s(it.note ?? it.body) ? `<p class="note">${esc(it.note ?? it.body)}</p>` : ""}
    </div>`, fxOf(it.fx) ?? fx)).join("");
  return `
<div class="gp-frame top${enterCls(c)}" style="justify-content:center">
  ${eyebrow(c.eyebrow)}
  <h2 class="gp-title sm">${esc(c.title)}</h2>
  <div class="gp-timeline">${cells}</div>
</div>`;
};

const agenda: LayoutFn = (c) => {
  const items = list(c.items ?? c.points);
  const li = items.map((it, i) => {
    const parts = it.split(/\s+—\s+|\s+-\s+/);
    const main = parts[0] ?? it;
    const sub = parts.slice(1).join(" — ");
    return frag(i + 1, `<li>${esc(main)}${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</li>`, fxOf(c.fx));
  }).join("");
  // Auto-fit: at 7+ entries the fixed row size overran the 1080px frame and
  // clipped top/bottom (his report — the agent rebuilt the agenda as `custom`
  // to escape it). `--n` drives a count-based shrink in base-css; emitted ONLY
  // past the threshold, so shorter agendas render byte-identically as before.
  const fit = items.length >= 7 ? ` style="--n:${items.length}"` : "";
  return `
<div class="gp-frame top${enterCls(c)}" style="justify-content:center">
  ${eyebrow(c.eyebrow ?? "Agenda")}
  ${s(c.title) ? `<h2 class="gp-title sm">${esc(c.title)}</h2>` : ""}
  <ol class="gp-agenda"${fit}>${li}</ol>
</div>`;
};

const chart: LayoutFn = (c) => {
  const type = (["bar", "line", "area", "pie"].includes(String(c.chartType)) ? c.chartType : "bar") as SlideChartType;
  const svg = renderSlideChart(type, c.series ?? c.data ?? c.points);
  return `
<div class="gp-frame top${enterCls(c)}" style="justify-content:center">
  ${eyebrow(c.eyebrow)}
  <h2 class="gp-title sm">${esc(c.title)}</h2>
  <div class="gp-chart">${svg || `<p class="gp-sub">No data.</p>`}</div>
  ${s(c.caption) ? `<p class="gp-codecap">${esc(c.caption)}</p>` : ""}
</div>`;
};

const code: LayoutFn = (c) => `
<div class="gp-frame top${enterCls(c)}" style="justify-content:center">
  ${eyebrow(c.eyebrow ?? (s(c.language) ? String(c.language) : ""))}
  ${s(c.title) ? `<h2 class="gp-title sm">${esc(c.title)}</h2>` : ""}
  <pre class="gp-code">${esc(c.code ?? c.body)}</pre>
  ${s(c.caption) ? `<p class="gp-codecap">${esc(c.caption)}</p>` : ""}
</div>`;

const fullBleedImage: LayoutFn = (c, ctx) => {
  const bg = ctx.media(c.media ?? c.image);
  const logo = ctx.media(c.logo);
  const fill = bg ? `background-image:url(${bg})` : "";
  const hasText = !!(s(c.title) || s(c.subtitle) || s(c.eyebrow) || logo);
  // No text → no scrim, no frame: the artwork carries the slide bare.
  // scrim:false forces the scrim off even with text (readable art).
  const scrim = hasText && c.scrim !== false ? `<div class="gp-scrim"></div>` : "";
  const kb = c.kenburns ? " gp-kenburns" : "";
  // align:"center" centers the overlay stack (logo + line over art — the
  // closing-slide shape an agent once had to BAKE INTO the artwork because
  // no layout composed it; 2026-09-08).
  const center = c.align === "center" ? " center" : "";
  return `
<div class="gp-fill${kb}" style="${fill}"></div>
${scrim}
${hasText ? `<div class="gp-frame${center}${enterCls(c)}">
  ${logo ? `<img class="gp-logoimg" src="${logo}" alt="" />` : ""}
  ${eyebrow(c.eyebrow)}
  ${s(c.title) ? `<h1 class="gp-title">${esc(c.title)}</h1>` : ""}
  ${s(c.subtitle) ? `<p class="gp-sub">${esc(c.subtitle)}</p>` : ""}
</div>` : ""}`;
};

// ── the GO-BIG layouts ───────────────────────────────────────────────────────

/** The marquee: edge-bleed media one side, content the other (his ask:
 *  "image left, text right for the hero"). Optional logo + CTA chip. */
const hero: LayoutFn = (c, ctx) => {
  const side = c.side === "right" ? "right" : "left";
  const bg = ctx.media(c.media ?? c.image);
  const logo = ctx.media(c.logo);
  return `
<div class="gp-heromedia ${side}${c.kenburns ? " gp-kenburns" : ""}" style="${bg ? `background-image:url(${bg})` : ""}"></div>
<div class="gp-frame gp-hero media-${side}${enterCls(c)}">
  ${logo ? `<img class="gp-logoimg" src="${logo}" alt="" />` : ""}
  ${eyebrow(c.eyebrow)}
  <h1 class="gp-title">${esc(c.title)}</h1>
  ${s(c.subtitle) ? `<p class="gp-sub">${esc(c.subtitle)}</p>` : ""}
  ${s(c.cta) ? `<span class="gp-cta frag" data-step="1">${esc(c.cta)}</span>` : ""}
</div>`;
};

/** A bare contained image, scaled to fit — logos, diagrams, screenshots.
 *  The whole-artwork slide the deck engine never had. */
const image: LayoutFn = (c, ctx) => {
  const src = ctx.media(c.media ?? c.image);
  const framed = c.framed ? " framed" : "";
  return `
<div class="gp-frame${enterCls(c)}">
  ${s(c.title) ? `${eyebrow(c.eyebrow)}<h2 class="gp-title sm" style="margin-bottom:36px">${esc(c.title)}</h2>` : ""}
  <div class="gp-imagewrap${framed}">${src ? `<img src="${src}" alt="" />` : `<div class="gp-mediabox"></div>`}</div>
  ${s(c.caption) ? `<p class="gp-caption">${esc(c.caption)}</p>` : ""}
</div>`;
};

/** A grid of shots with optional captions (2–6 images). */
const gallery: LayoutFn = (c, ctx) => {
  const shots = rows(c.images ?? c.items).slice(0, 6);
  const cols = Math.min(Math.max(Number(c.columns) || (shots.length <= 2 ? shots.length : shots.length <= 4 ? 2 : 3), 1), 3);
  const fx = fxOf(c.fx) ?? "zoom";
  const cells = shots.map((it, i) => {
    const url = ctx.media(it.media ?? it.image);
    return frag(i + 1, `
    <div class="gp-shot">
      <div class="gp-mediabox" style="${url ? `background-image:url(${url})` : ""}"></div>
      ${s(it.caption) ? `<p>${esc(it.caption)}</p>` : ""}
    </div>`, fxOf(it.fx) ?? fx);
  }).join("");
  return `
<div class="gp-frame top${enterCls(c)}" style="justify-content:center">
  ${eyebrow(c.eyebrow)}
  ${s(c.title) ? `<h2 class="gp-title sm">${esc(c.title)}</h2>` : ""}
  <div class="gp-gallery" style="grid-template-columns:repeat(${cols},1fr)">${cells}</div>
</div>`;
};

/** A "trusted by" wall of logo tiles (up to 12). */
const logoWall: LayoutFn = (c, ctx) => {
  const logos = list(c.logos).slice(0, 12);
  const fx = fxOf(c.fx) ?? "pop";
  const cells = logos.map((id, i) => {
    const url = ctx.media(id);
    return frag(i + 1, `<div class="cell">${url ? `<img src="${url}" alt="" />` : ""}</div>`, fx);
  }).join("");
  return `
<div class="gp-frame top${enterCls(c)}" style="justify-content:center">
  ${eyebrow(c.eyebrow)}
  ${s(c.title) ? `<h2 class="gp-title sm">${esc(c.title)}</h2>` : ""}
  <div class="gp-logos">${cells}</div>
</div>`;
};

/** Two color-blocked half-panes — a statement side vs a content side. */
const split: LayoutFn = (c, ctx) => {
  const pane = (v: unknown, sideCls: string): string => {
    const o = (v ?? {}) as Record<string, unknown>;
    const tone = o.tone === "accent" ? " tone-accent" : o.tone === "surface" ? " tone-surface" : "";
    const media = ctx.media(o.media ?? o.image);
    if (media) return `<div class="gp-splitpane ${sideCls}"><div class="gp-splitmedia" style="background-image:url(${media})"></div></div>`;
    return `
    <div class="gp-splitpane ${sideCls}${tone}">
      ${s(o.heading) ? `<h2 class="gp-title sm" style="margin-bottom:26px">${esc(o.heading)}</h2>` : ""}
      ${colBody(o.body ?? o.points)}
    </div>`;
  };
  return `${pane(c.left, `left${enterCls(c) ? " gp-enter-left" : ""}`)}${pane(c.right, `right${enterCls(c) ? " gp-enter-right" : ""}`)}`;
};

/** One massive line. `**word**` renders in the accent color. */
const statement: LayoutFn = (c) => {
  const text = esc(c.text ?? c.title).replace(/\*\*([^*]+)\*\*/g, `<span class="gp-accent">$1</span>`);
  return `
<div class="gp-frame${c.align === "center" ? " center" : ""}${enterCls(c)}">
  ${eyebrow(c.eyebrow)}
  <p class="gp-statement">${text}</p>
  ${s(c.subtitle) ? `<p class="gp-sub">${esc(c.subtitle)}</p>` : ""}
</div>`;
};

/** FULLY CUSTOM: raw HTML + optional CSS, with the whole animation contract
 *  open. The structure lock scopes the CSS to this slide and passes
 *  @keyframes through verbatim, so anything authored here keeps the deck safe. */
const custom: LayoutFn = (c) => {
  // A </style> in the css would break out of the tag — neutralize it.
  const css = s(c.css).replace(/<\s*\/\s*style/gi, "");
  return `${css ? `<style>${css}</style>` : ""}${s(c.html) || `<div class="gp-frame center"><p class="gp-sub">Empty slide.</p></div>`}`;
};

const team: LayoutFn = (c) => {
  const people = rows(c.members ?? c.people).slice(0, 8);
  const fx = fxOf(c.fx) ?? "pop";
  const cells = people.map((m, i) => {
    const av = m.photo ?? m.avatar ?? m.media;
    // ctx isn't threaded into map easily; use token directly via hasMedia guard
    const bg = hasMedia(av) ? `background-image:url({{MEDIA:${s(av)}}})` : "";
    return frag(i + 1, `
    <div class="gp-member">
      <div class="gp-avatar" style="${bg}"></div>
      <p class="name">${esc(m.name)}</p>
      <p class="role">${esc(m.role ?? m.title)}</p>
    </div>`, fxOf(m.fx) ?? fx);
  }).join("");
  return `
<div class="gp-frame top${enterCls(c)}" style="justify-content:center">
  ${eyebrow(c.eyebrow)}
  <h2 class="gp-title sm">${esc(c.title)}</h2>
  <div class="gp-team">${cells}</div>
</div>`;
};

/** Optional full-bleed background for the centered layouts (title/closing):
 *  the art fills the frame, a scrim keeps the type readable (scrim:false to
 *  run it bare). Empty string when the spec carries no media. */
const bgFill = (c: Record<string, unknown>, ctx: RenderCtx): string => {
  const bg = ctx.media(c.media ?? c.image);
  if (!bg) return "";
  const kb = c.kenburns ? " gp-kenburns" : "";
  return `<div class="gp-fill${kb}" style="background-image:url(${bg})"></div>`
    + (c.scrim !== false ? `<div class="gp-scrim"></div>` : "");
};

const closing: LayoutFn = (c, ctx) => {
  const logo = ctx.media(c.logo);
  return `${bgFill(c, ctx)}
<div class="gp-frame center${enterCls(c)}">
  ${logo ? `<img class="gp-logoimg" src="${logo}" alt="" />` : rule()}
  <h1 class="gp-title lg">${esc(c.title ?? "Thank you")}</h1>
  ${s(c.subtitle ?? c.contact) ? `<p class="gp-sub">${esc(c.subtitle ?? c.contact)}</p>` : ""}
</div>`;
};

/** Escape hatch: raw content. Still passes through the structure lock. */
const blank: LayoutFn = (c) => s(c.html) || `<div class="gp-frame center"><p class="gp-sub">Empty slide.</p></div>`;

// ── shared content helpers ───────────────────────────────────────────────────
/** Bold/italic inline markdown → safe HTML (escaped first). */
function inline(v: unknown): string {
  return esc(v)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>");
}

/** A body that may be prose or a bullet list. */
function colBody(v: unknown): string {
  const items = list(v);
  if (Array.isArray(v) && items.length) {
    return `<ul class="gp-bullets" style="margin-top:8px">${items.map((p) => `<li>${inline(p)}</li>`).join("")}</ul>`;
  }
  return s(v) ? `<p class="gp-body gp-lead">${inline(v)}</p>` : "";
}

/** A media box (image element that fills its cell); falls back to a themed
 *  surface when no media is supplied. */
function mediaBox(ref: unknown, ctx: RenderCtx): string {
  const url = ctx.media(ref);
  return url
    ? `<div class="gp-mediabox" style="background-image:url(${url})"></div>`
    : `<div class="gp-mediabox"></div>`;
}

// ── the registry ─────────────────────────────────────────────────────────────
function f(key: string, type: FieldSchema["type"], doc: string, required = false): FieldSchema {
  return { key, type, required, doc };
}

/** Universal fields honoured by EVERY layout (documented once, appended to
 *  each catalog entry by layoutCatalog). */
export const UNIVERSAL_FIELDS: FieldSchema[] = [
  f("enter", "text", `Slide-entrance animation, replays each time the slide shows: ${MOTION_FX.join(" | ")}.`),
  f("fx", "text", `Reveal effect for this slide's build-step fragments (bullets/cards/etc; per-item "fx" overrides): ${MOTION_FX.join(" | ")}.`),
  f("footer", "text", "Footer line for this slide (left text + auto page number right). Omit for chrome-free slides."),
  f("notes", "text", "Speaker notes (presenter view only)."),
];

export const SLIDE_LAYOUTS: Record<string, LayoutSpec> = {
  title: {
    name: "title", summary: "Opening / cover slide: big centered title, optional logo, eyebrow + subtitle. Optional full-bleed background art behind it all.",
    render: title,
    schema: [f("title", "text", "The deck's headline.", true), f("subtitle", "text", "One supporting line."), f("eyebrow", "text", "Small label above the title (e.g. company or date)."), f("logo", "media", "Media-library asset id for a logo above the title, scaled to fit."), f("media", "media", "Optional asset id for a full-bleed background image (a scrim keeps the type readable)."), f("scrim", "boolean", "false disables the background scrim."), f("kenburns", "boolean", "Slow Ken-Burns zoom on the background.")],
    sample: { layout: "title", eyebrow: "Q3 REVIEW", title: "Building the future of work", subtitle: "How we tripled activation in 90 days", enter: "rise" },
  },
  hero: {
    name: "hero", summary: "The marquee: edge-bleed image one side, big title + subtitle (+logo, +CTA chip) the other.",
    render: hero,
    schema: [f("title", "text", "The headline.", true), f("media", "media", "Media-library asset id for the bleed image."), f("side", "text", "'left' (default) or 'right' — which side the image bleeds on."), f("subtitle", "text", "Supporting line."), f("eyebrow", "text", "Small label."), f("logo", "media", "Logo asset id shown above the title."), f("cta", "text", "A call-to-action chip (revealed on advance)."), f("kenburns", "boolean", "Slow Ken-Burns zoom on the image.")],
    sample: { layout: "hero", media: "asset_123", side: "left", title: "What's your superpower?", subtitle: "Direct every model and tool you've got.", cta: "glyphh.ai", enter: "up" },
  },
  image: {
    name: "image", summary: "One image scaled to FIT (contained, never cropped) — logos, diagrams, screenshots. Optional title/caption; nothing else on the slide.",
    render: image,
    schema: [f("media", "media", "Media-library asset id.", true), f("title", "text", "Optional heading above."), f("caption", "text", "Optional line under the image."), f("eyebrow", "text", "Small label."), f("framed", "boolean", "Rounded corners + shadow around the image.")],
    sample: { layout: "image", media: "asset_logo", enter: "zoom" },
  },
  gallery: {
    name: "gallery", summary: "A grid of 2–6 images with optional captions, revealed in sequence.",
    render: gallery,
    schema: [f("images", "items", "[{media, caption?, fx?}] — up to 6.", true), f("title", "text", "Optional heading."), f("columns", "number", "Force a column count (1–3)."), f("eyebrow", "text", "Small label.")],
    sample: { layout: "gallery", title: "In the wild", images: [{ media: "asset_1", caption: "Desktop" }, { media: "asset_2", caption: "Mobile" }] },
  },
  "logo-wall": {
    name: "logo-wall", summary: "A 'trusted by' wall of logo tiles (up to 12), popping in one by one.",
    render: logoWall,
    schema: [f("logos", "list", "Media-library asset ids (array), up to 12.", true), f("title", "text", "Optional heading."), f("eyebrow", "text", "Small label (e.g. 'TRUSTED BY').")],
    sample: { layout: "logo-wall", eyebrow: "TRUSTED BY", logos: ["asset_a", "asset_b", "asset_c"] },
  },
  split: {
    name: "split", summary: "Two color-blocked half-panes: each is {heading?, body?, tone?: 'accent'|'surface'} or {media} for a full-bleed image half.",
    render: split,
    schema: [f("left", "text", "{heading?, body?|points?, tone?} or {media} for the left half.", true), f("right", "text", "Same shape for the right half.", true)],
    sample: { layout: "split", left: { heading: "Before", body: ["Manual", "Fragile"], tone: "surface" }, right: { heading: "After", body: ["Automated", "Governed"], tone: "accent" } },
  },
  statement: {
    name: "statement", summary: "One massive line — a manifesto beat. **word** renders in the accent color.",
    render: statement,
    schema: [f("text", "text", "The line. **bold** spans take the accent color.", true), f("subtitle", "text", "A quieter follow-on line."), f("eyebrow", "text", "Small label."), f("align", "text", "'center' centers it (default left).")],
    sample: { layout: "statement", text: "We put the **human** back in intelligence.", enter: "blur" },
  },
  "section-divider": {
    name: "section-divider", summary: "Chapter break: accent rule, big title, optional number + subtitle.",
    render: sectionDivider,
    schema: [f("title", "text", "The section name.", true), f("number", "text", "e.g. '01' or 'Part Two'."), f("subtitle", "text", "One line of context.")],
    sample: { layout: "section-divider", number: "01", title: "The problem", subtitle: "Why the old way breaks down" },
  },
  bullets: {
    name: "bullets", summary: "Title + a list of points that reveal one at a time (auto-fits up to ~10; more should split across slides). **bold**/*italic* allowed.",
    render: bullets,
    schema: [f("title", "text", "Slide heading.", true), f("points", "list", "The bullet points (array of strings).", true), f("eyebrow", "text", "Small label above the title."), f("style", "text", "'check' for checkmark bullets.")],
    sample: { layout: "bullets", title: "What changed", points: ["**Onboarding** cut to 3 steps", "Live preview on every edit", "One-click publish"] },
  },
  "two-column": {
    name: "two-column", summary: "Two side-by-side columns of prose or bullets, each with an optional heading.",
    render: twoColumn,
    schema: [f("title", "text", "Optional slide heading."), f("left", "text", "Left column: {heading?, body} where body is a string or array of bullets."), f("right", "text", "Right column: {heading?, body}.")],
    sample: { layout: "two-column", title: "Before & after", left: { heading: "Before", body: ["Manual exports", "No previews"] }, right: { heading: "After", body: ["Automated", "Live previews"] } },
  },
  "image-left": {
    name: "image-left", summary: "Media on the left, title + body/bullets on the right.",
    render: imageSide("left"),
    schema: [f("title", "text", "Heading.", true), f("body", "text", "Prose or an array of bullets."), f("media", "media", "Media-library asset id for the image."), f("eyebrow", "text", "Small label.")],
    sample: { layout: "image-left", title: "See it in motion", body: "The panel updates the instant an agent writes.", media: "asset_123" },
  },
  "image-right": {
    name: "image-right", summary: "Title + body/bullets on the left, media on the right.",
    render: imageSide("right"),
    schema: [f("title", "text", "Heading.", true), f("body", "text", "Prose or an array of bullets."), f("media", "media", "Media-library asset id."), f("eyebrow", "text", "Small label.")],
    sample: { layout: "image-right", title: "One workspace", body: ["Docs", "Sheets", "Slides"], media: "asset_123" },
  },
  quote: {
    name: "quote", summary: "A large pull-quote with attribution.",
    render: quote,
    schema: [f("quote", "text", "The quotation (no surrounding quotes needed).", true), f("attribution", "text", "Who said it."), f("role", "text", "Their title/company.")],
    sample: { layout: "quote", quote: "This is the tool I didn't know I needed.", attribution: "A happy user", role: "Head of Design" },
  },
  "big-stat": {
    name: "big-stat", summary: "One giant number + label (+caption), OR a row of up to 4 stats.",
    render: bigStat,
    schema: [f("stat", "text", "The headline figure, e.g. '3.4×'."), f("label", "text", "What it measures."), f("caption", "text", "Optional supporting line."), f("stats", "items", "For a row: [{stat, label}] (up to 4).")],
    sample: { layout: "big-stat", stat: "3.4×", label: "faster activation", caption: "Median across 1,200 new teams" },
  },
  cards: {
    name: "cards", summary: "A grid of 2–6 titled cards (feature/step tiles) that reveal in sequence.",
    render: cards,
    schema: [f("title", "text", "Optional heading."), f("cards", "items", "[{label?, title, body?}] — up to 6.", true), f("eyebrow", "text", "Small label.")],
    sample: { layout: "cards", title: "How it works", cards: [{ label: "01", title: "Connect", body: "Link your data" }, { label: "02", title: "Compose", body: "Agents build it" }, { label: "03", title: "Ship", body: "One click" }] },
  },
  comparison: {
    name: "comparison", summary: "Two labelled cards of bullets, side by side (us vs them, before vs after).",
    render: comparison,
    schema: [f("title", "text", "Optional heading."), f("left", "text", "{heading, points[]}."), f("right", "text", "{heading, points[]}.")],
    sample: { layout: "comparison", title: "Why us", left: { heading: "Spreadsheets", points: ["Manual", "Fragile"] }, right: { heading: "Glyphh", points: ["Automated", "Governed"] } },
  },
  timeline: {
    name: "timeline", summary: "A horizontal timeline of up to 5 milestones.",
    render: timeline,
    schema: [f("title", "text", "Heading.", true), f("items", "items", "[{date, label, note?}] — up to 5.", true)],
    sample: { layout: "timeline", title: "Roadmap", items: [{ date: "Q1", label: "Launch", note: "GA" }, { date: "Q2", label: "Teams" }, { date: "Q3", label: "Enterprise" }] },
  },
  agenda: {
    name: "agenda", summary: "A numbered agenda / table of contents (auto-fits up to ~12 entries; split into sections beyond that). Use ' — ' to add a sub-note per item.",
    render: agenda,
    schema: [f("title", "text", "Optional heading."), f("items", "list", "Agenda entries; 'Topic — note' splits the note out.", true), f("eyebrow", "text", "Label (defaults to 'Agenda').")],
    sample: { layout: "agenda", title: "Today", items: ["The problem — 5 min", "The solution — 10 min", "Demo — 15 min", "Q&A"] },
  },
  chart: {
    name: "chart", summary: "A native (self-contained SVG) chart from inline data — bar/line/area/pie.",
    render: chart,
    schema: [f("title", "text", "Heading.", true), f("chartType", "text", "bar | line | area | pie (default bar)."), f("series", "series", "[{label, value}] data points.", true), f("caption", "text", "Optional source line.")],
    sample: { layout: "chart", title: "Revenue by quarter", chartType: "bar", series: [{ label: "Q1", value: 120 }, { label: "Q2", value: 190 }, { label: "Q3", value: 240 }, { label: "Q4", value: 310 }] },
  },
  code: {
    name: "code", summary: "A monospaced code block with optional title + caption.",
    render: code,
    schema: [f("code", "text", "The code (preserve newlines/indentation).", true), f("title", "text", "Optional heading."), f("language", "text", "Shown as the eyebrow when set."), f("caption", "text", "Optional note under the block.")],
    sample: { layout: "code", title: "Call the API", language: "TypeScript", code: "const deck = await client.officeSlides.get('q3.html');" },
  },
  "full-bleed-image": {
    name: "full-bleed-image", summary: "Edge-to-edge background image. Text is OPTIONAL — with no title/subtitle the artwork runs bare (no scrim). align:'center' + logo composes a centered logo-over-art slide.",
    render: fullBleedImage,
    schema: [f("media", "media", "Media-library asset id for the background.", true), f("title", "text", "Overlaid headline (omit for a bare image slide)."), f("subtitle", "text", "Overlaid supporting line."), f("eyebrow", "text", "Small overlaid label."), f("logo", "media", "Logo asset id shown above the overlaid text."), f("align", "text", "'center' centers the overlaid logo/text stack (default top-left)."), f("scrim", "boolean", "false disables the text scrim."), f("kenburns", "boolean", "Slow Ken-Burns zoom on the image.")],
    sample: { layout: "full-bleed-image", media: "asset_bg", kenburns: true },
  },
  team: {
    name: "team", summary: "A grid of people (photo, name, role) — up to 8.",
    render: team,
    schema: [f("title", "text", "Heading.", true), f("members", "items", "[{name, role, photo?}] where photo is a media asset id.", true)],
    sample: { layout: "team", title: "The team", members: [{ name: "Ada", role: "Engineering" }, { name: "Chris", role: "Product" }] },
  },
  closing: {
    name: "closing", summary: "A closing / thank-you slide: centered logo + line, with an optional full-bleed background image behind them.",
    render: closing,
    schema: [f("title", "text", "Defaults to 'Thank you'."), f("subtitle", "text", "A closing line."), f("contact", "text", "Email / URL / handle."), f("logo", "media", "Logo asset id above the title (replaces the accent rule)."), f("media", "media", "Optional asset id for a full-bleed background image (a scrim keeps the type readable)."), f("scrim", "boolean", "false disables the background scrim."), f("kenburns", "boolean", "Slow Ken-Burns zoom on the background.")],
    sample: { layout: "closing", title: "Let's build", contact: "hello@glyphh.ai", enter: "fade" },
  },
  custom: {
    name: "custom",
    summary: "FULLY CUSTOM slide: your own HTML + CSS + animations on the 1920×1080 stage. The CSS is scoped to this slide; @keyframes work. Use the gp-* classes for the theme's look, or go completely your own way.",
    render: custom,
    schema: [
      f("html", "richtext", "Raw inner HTML for the slide. The stage is a fixed 1920×1080 canvas; position absolutely or use .gp-frame (inset:0, themed padding). Theme classes available: gp-title/gp-sub/gp-eyebrow/gp-bullets/gp-card/gp-frame + var(--slide-bg/fg/muted/accent/surface/border). MEDIA-LIBRARY ASSETS WORK HERE: embed with <img src=\"{{MEDIA:asset_id}}\"> or style=\"background-image:url({{MEDIA:asset_id}})\" — tokens resolve to the asset at render. Build steps: class=\"frag\" data-step=\"1\" (+ optional data-fx=\"up|zoom|…\") reveal on advance. NO <script>/<iframe> (stripped); position:fixed becomes absolute.", true),
      f("css", "richtext", "CSS for this slide only (auto-scoped — it can't leak). @keyframes pass through, so author any animation; animations tied to .slide.on replay each time the slide shows."),
    ],
    sample: { layout: "custom", html: "<div class=\"gp-frame center\"><h1 class=\"gp-title spin\">Custom</h1></div>", css: "@keyframes spin{to{transform:rotate(360deg)}} .spin{animation:spin 4s linear infinite}" },
  },
  blank: {
    name: "blank", summary: "Escape hatch — raw slide HTML when no layout fits (still structure-locked). Prefer `custom`, which also takes CSS.",
    render: blank,
    schema: [f("html", "richtext", "Raw inner HTML for the section. Media-library assets embed via {{MEDIA:asset_id}} tokens (img src or background-image url), resolved at render.", true)],
    sample: { layout: "blank", html: "<div class=\"gp-frame center\"><h1 class=\"gp-title\">Custom</h1></div>" },
  },
};

export const LAYOUT_NAMES = Object.keys(SLIDE_LAYOUTS);
