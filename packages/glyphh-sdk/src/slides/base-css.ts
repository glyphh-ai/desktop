/**
 * slides/base-css.ts — the shared component stylesheet every layout renders
 * against. The engine prepends this ONCE per deck (inside #stage, ahead of the
 * first section, so the structure lock leaves it intact). Layouts emit semantic
 * classes (.gp-title, .gp-bullets, …); this sheet + the theme's `--slide-*`
 * vars turn them into the finished, "visually sick" look — no per-slide CSS,
 * no agent HTML.
 *
 * Everything is sized for the fixed 1920×1080 stage.
 */

export const SLIDE_BASE_CSS = `
.gp-frame{position:absolute;inset:0;padding:var(--slide-pad);display:flex;flex-direction:column;justify-content:center;box-sizing:border-box}
.gp-frame.center{align-items:center;justify-content:center;text-align:center}
.gp-frame.top{justify-content:flex-start}
.gp-eyebrow{font:600 26px/1 var(--slide-font-body);letter-spacing:.2em;text-transform:uppercase;color:var(--slide-accent);margin:0 0 30px}
.gp-title{font:700 104px/1.03 var(--slide-font-display);letter-spacing:-.025em;margin:0;color:var(--slide-fg)}
.gp-title.sm{font-size:74px}
.gp-title.lg{font-size:150px}
.gp-sub{font:400 34px/1.42 var(--slide-font-body);color:var(--slide-muted);margin:32px 0 0;max-width:1300px}
.gp-frame.center .gp-sub{margin-left:auto;margin-right:auto}
.gp-body{font:400 33px/1.5 var(--slide-font-body);color:var(--slide-fg);margin:0;max-width:900px}
.gp-lead{font:400 40px/1.42 var(--slide-font-body);color:var(--slide-fg);margin:0;max-width:1000px}
.gp-muted{color:var(--slide-muted)}
.gp-accent{color:var(--slide-accent)}
.gp-rule{width:120px;height:6px;border-radius:3px;background:var(--slide-accent);margin:0 0 44px}
.gp-frame.center .gp-rule{margin-left:auto;margin-right:auto}
.gp-kicker{font:700 30px/1 var(--slide-font-mono);color:var(--slide-accent);margin:0 0 34px;letter-spacing:.04em}

.gp-bullets{list-style:none;margin:48px 0 0;padding:0;display:flex;flex-direction:column;gap:32px}
.gp-bullets li{position:relative;padding-left:56px;font:400 40px/1.38 var(--slide-font-body);color:var(--slide-fg)}
.gp-bullets li b,.gp-bullets li strong{font-weight:700}
.gp-bullets li::before{content:"";position:absolute;left:0;top:.5em;width:22px;height:22px;border-radius:7px;background:var(--slide-accent)}
.gp-bullets.check li::before{border-radius:50%;background:none;box-shadow:inset 0 0 0 4px var(--slide-accent)}
/* Count-based auto-fit: layouts set --n only past a threshold, so shorter
   lists keep the sizes above; these engage only when the row count would
   otherwise clip the 1080px frame. min() caps at the default so it only ever
   shrinks. */
.gp-bullets[style*="--n"]{gap:min(32px,calc(720px / var(--n) * 0.18))}
.gp-bullets[style*="--n"] li{font-size:min(40px,calc(720px / var(--n) * 0.5))}

.gp-grid2{display:grid;grid-template-columns:1fr 1fr;gap:72px;flex:1;align-items:center;min-height:0}
.gp-grid2.media{grid-template-columns:1.05fr .95fr}
.gp-col{display:flex;flex-direction:column;justify-content:center;gap:22px;min-width:0}
.gp-colhead{font:700 30px/1 var(--slide-font-body);letter-spacing:.12em;text-transform:uppercase;color:var(--slide-accent);margin:0 0 8px}

.gp-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:44px;flex:1;align-items:stretch;min-height:0}
.gp-grid2c{display:grid;grid-template-columns:repeat(2,1fr);gap:48px;flex:1;align-items:stretch;min-height:0}
.gp-card{background:var(--slide-surface);border:1px solid var(--slide-border);border-radius:var(--slide-radius);padding:52px;display:flex;flex-direction:column;gap:18px}
.gp-card .gp-cardnum{font:700 30px/1 var(--slide-font-mono);color:var(--slide-accent)}
.gp-card h3{font:700 42px/1.08 var(--slide-font-display);margin:0;color:var(--slide-fg)}
.gp-card p{font:400 28px/1.46 var(--slide-font-body);color:var(--slide-muted);margin:0}

.gp-stat{font:800 clamp(180px,20vw,320px)/.86 var(--slide-font-display);letter-spacing:-.04em;color:var(--slide-accent);margin:0}
.gp-statlabel{font:600 48px/1.16 var(--slide-font-display);margin:18px 0 0;color:var(--slide-fg)}
.gp-statcap{font:400 32px/1.4 var(--slide-font-body);color:var(--slide-muted);margin:20px 0 0;max-width:1100px}
.gp-stats-row{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:56px;flex:1;align-items:center}
.gp-stats-row .gp-stat{font-size:clamp(120px,12vw,180px)}
.gp-stats-row .gp-statlabel{font-size:34px}

.gp-quote{font:500 74px/1.24 var(--slide-font-display);letter-spacing:-.02em;margin:0;max-width:1560px;color:var(--slide-fg)}
.gp-quote .mark{color:var(--slide-accent)}
.gp-cite{font:500 34px/1.3 var(--slide-font-body);color:var(--slide-muted);margin:56px 0 0}
.gp-cite b{color:var(--slide-fg);font-weight:600}

.gp-media{border-radius:var(--slide-radius);overflow:hidden;background:var(--slide-surface);width:100%;height:100%;min-height:520px;object-fit:cover;display:block}
.gp-mediabox{border-radius:var(--slide-radius);overflow:hidden;background:var(--slide-surface) center/cover no-repeat;width:100%;height:100%;min-height:520px}
.gp-fill{position:absolute;inset:0;background:var(--slide-surface) center/cover no-repeat}
.gp-scrim{position:absolute;inset:0;background:linear-gradient(90deg,var(--slide-bg) 4%,rgba(0,0,0,.05) 62%,transparent)}
.gp-scrim.bottom{background:linear-gradient(0deg,var(--slide-bg) 2%,transparent 55%)}

.gp-agenda{list-style:none;margin:48px 0 0;padding:0;counter-reset:a;display:flex;flex-direction:column;gap:6px;flex:1;justify-content:center}
.gp-agenda li{display:flex;gap:38px;align-items:baseline;font:500 50px/1.15 var(--slide-font-display);color:var(--slide-fg);border-bottom:1px solid var(--slide-border);padding:26px 0}
.gp-agenda li::before{counter-increment:a;content:counter(a,decimal-leading-zero);font:700 34px/1 var(--slide-font-mono);color:var(--slide-accent);min-width:70px}
.gp-agenda li .sub{font:400 28px/1 var(--slide-font-body);color:var(--slide-muted);margin-left:auto}
/* Auto-fit past ~7 entries (the layout sets --n only then) — shorter agendas
   are untouched; min() guarantees it only shrinks, never grows. */
.gp-agenda[style*="--n"] li{font-size:min(50px,calc(720px / var(--n) * 0.62));padding:min(26px,calc(720px / var(--n) * 0.14)) 0}
.gp-agenda[style*="--n"] li::before{font-size:min(34px,calc(720px / var(--n) * 0.42))}

.gp-timeline{display:flex;gap:0;flex:1;align-items:stretch;margin-top:56px}
.gp-tl{flex:1;position:relative;padding-top:60px}
.gp-tl::before{content:"";position:absolute;top:16px;left:0;right:0;height:3px;background:var(--slide-border)}
.gp-tl::after{content:"";position:absolute;top:6px;left:0;width:24px;height:24px;border-radius:50%;background:var(--slide-accent);box-shadow:0 0 0 8px var(--slide-bg)}
.gp-tl .date{font:700 30px/1 var(--slide-font-mono);color:var(--slide-accent);margin:0 0 14px}
.gp-tl .label{font:600 36px/1.18 var(--slide-font-display);color:var(--slide-fg);margin:0;padding-right:30px}
.gp-tl .note{font:400 26px/1.4 var(--slide-font-body);color:var(--slide-muted);margin:12px 30px 0 0}

.gp-code{background:var(--slide-surface);border:1px solid var(--slide-border);border-radius:var(--slide-radius);padding:48px 56px;font:500 30px/1.62 var(--slide-font-mono);white-space:pre;overflow:hidden;color:var(--slide-fg);margin:44px 0 0}
.gp-codecap{font:400 28px/1.4 var(--slide-font-body);color:var(--slide-muted);margin:26px 0 0}

.gp-team{display:grid;grid-template-columns:repeat(4,1fr);gap:48px;flex:1;align-items:center;margin-top:40px}
.gp-member{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px}
.gp-avatar{width:220px;height:220px;border-radius:50%;background:var(--slide-surface) center/cover no-repeat;border:2px solid var(--slide-border);margin-bottom:16px}
.gp-member .name{font:700 34px/1.15 var(--slide-font-display);color:var(--slide-fg);margin:0}
.gp-member .role{font:400 26px/1.3 var(--slide-font-body);color:var(--slide-muted);margin:0}

.gp-chart{display:flex;flex-direction:column;flex:1;margin-top:40px;min-height:0}
.gp-chart svg{width:100%;height:100%;flex:1;overflow:visible}
.gp-legend{display:flex;gap:36px;flex-wrap:wrap;margin-top:26px}
.gp-legend span{font:500 28px/1 var(--slide-font-body);color:var(--slide-muted);display:flex;align-items:center;gap:12px}
.gp-legend i{width:22px;height:22px;border-radius:6px;display:inline-block}

.gp-tag{display:inline-flex;align-items:center;gap:12px;align-self:flex-start;background:var(--slide-surface);border:1px solid var(--slide-border);border-radius:999px;padding:12px 26px;font:600 26px/1 var(--slide-font-body);color:var(--slide-muted);margin:0 0 34px}
.gp-tag b{color:var(--slide-accent);font-weight:700}
#stage{counter-reset:gpslide}
.slide{counter-increment:gpslide}
.gp-footer{position:absolute;left:var(--slide-pad);right:var(--slide-pad);bottom:44px;display:flex;justify-content:space-between;align-items:center;font:500 24px/1 var(--slide-font-body);color:var(--slide-muted);letter-spacing:.02em;z-index:3}
.gp-footer .gp-pagenum::after{content:counter(gpslide,decimal-leading-zero)}

/* ── motion: slide-ENTRANCE animations ──────────────────────────────────────
   A layout root carrying .gp-enter-<fx> replays its entrance every time its
   slide becomes active (.slide.on re-matches the rule → the animation runs).
   Applied via the universal \`enter\` field on any slide spec. */
@keyframes gpFade{from{opacity:0}to{opacity:1}}
@keyframes gpUp{from{opacity:0;transform:translateY(70px)}to{opacity:1;transform:none}}
@keyframes gpDown{from{opacity:0;transform:translateY(-70px)}to{opacity:1;transform:none}}
@keyframes gpLeft{from{opacity:0;transform:translateX(90px)}to{opacity:1;transform:none}}
@keyframes gpRight{from{opacity:0;transform:translateX(-90px)}to{opacity:1;transform:none}}
@keyframes gpZoom{from{opacity:0;transform:scale(.86)}to{opacity:1;transform:none}}
@keyframes gpZoomOut{from{opacity:0;transform:scale(1.15)}to{opacity:1;transform:none}}
@keyframes gpBlurIn{from{opacity:0;filter:blur(20px)}to{opacity:1;filter:none}}
@keyframes gpRise{from{opacity:0;transform:translateY(160px) scale(.98)}to{opacity:1;transform:none}}
@keyframes gpWipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
@keyframes gpPop{0%{opacity:0;transform:scale(.7)}70%{opacity:1;transform:scale(1.04)}100%{opacity:1;transform:none}}
@keyframes gpKenBurns{from{transform:scale(1)}to{transform:scale(1.09)}}
.slide.on .gp-enter-fade{animation:gpFade .8s ease both}
.slide.on .gp-enter-up{animation:gpUp .75s cubic-bezier(.22,1,.36,1) both}
.slide.on .gp-enter-down{animation:gpDown .75s cubic-bezier(.22,1,.36,1) both}
.slide.on .gp-enter-left{animation:gpLeft .75s cubic-bezier(.22,1,.36,1) both}
.slide.on .gp-enter-right{animation:gpRight .75s cubic-bezier(.22,1,.36,1) both}
.slide.on .gp-enter-zoom{animation:gpZoom .8s cubic-bezier(.22,1,.36,1) both}
.slide.on .gp-enter-zoom-out{animation:gpZoomOut .8s cubic-bezier(.22,1,.36,1) both}
.slide.on .gp-enter-blur{animation:gpBlurIn .9s ease both}
.slide.on .gp-enter-rise{animation:gpRise .9s cubic-bezier(.22,1,.36,1) both}
.slide.on .gp-enter-wipe{animation:gpWipe .9s cubic-bezier(.6,.05,.2,1) both}
.slide.on .gp-enter-pop{animation:gpPop .7s cubic-bezier(.34,1.56,.64,1) both}
.slide.on .gp-kenburns{animation:gpKenBurns 16s ease-out both}

/* ── motion: per-FRAGMENT reveal effects ────────────────────────────────────
   The shell reveals .frag on advance (adds .show). data-fx picks the hidden
   pose; the shared transition carries it home. Default (no data-fx) keeps the
   classic fade-up. Set via the universal \`fx\` field (or per-item \`fx\`). */
.frag[data-fx]{transition:opacity .55s ease,transform .6s cubic-bezier(.22,1,.36,1),filter .55s ease,clip-path .6s cubic-bezier(.6,.05,.2,1)}
.frag[data-fx="fade"]{transform:none}
.frag[data-fx="up"]{transform:translateY(56px)}
.frag[data-fx="down"]{transform:translateY(-44px)}
.frag[data-fx="left"]{transform:translateX(80px)}
.frag[data-fx="right"]{transform:translateX(-80px)}
.frag[data-fx="zoom"]{transform:scale(.84)}
.frag[data-fx="zoom-out"]{transform:scale(1.16)}
.frag[data-fx="blur"]{transform:none;filter:blur(16px)}
.slide.on .frag[data-fx="blur"].show{filter:none}
.frag[data-fx="rise"]{transform:translateY(130px)}
.frag[data-fx="wipe"]{transform:none;clip-path:inset(0 100% 0 0);opacity:1}
.slide.on .frag[data-fx="wipe"].show{clip-path:inset(0 0 0 0)}
.frag[data-fx="pop"]{transform:scale(.7);transition-timing-function:ease,cubic-bezier(.34,1.56,.64,1),ease,ease}

/* ── hero: edge-bleed media one side, content the other ───────────────────── */
.gp-heromedia{position:absolute;top:0;bottom:0;width:47%;background:var(--slide-surface) center/cover no-repeat;z-index:0}
.gp-heromedia.left{left:0}
.gp-heromedia.right{right:0}
.gp-frame.gp-hero{z-index:1}
.gp-frame.gp-hero.media-left{padding-left:calc(47% + 96px)}
.gp-frame.gp-hero.media-right{padding-right:calc(47% + 96px)}
.gp-logoimg{max-height:120px;max-width:560px;object-fit:contain;object-position:left;align-self:flex-start;margin:0 0 48px;display:block}
.gp-frame.center .gp-logoimg{align-self:center;object-position:center}
.gp-cta{display:inline-flex;align-self:flex-start;background:var(--slide-accent);color:var(--slide-bg);border-radius:14px;padding:22px 44px;font:700 30px/1 var(--slide-font-body);margin-top:52px}
.gp-frame.center .gp-cta{align-self:center}

/* ── image: contained media scaled to fit (logos, diagrams, screenshots) ──── */
.gp-imagewrap{flex:1;min-height:0;display:flex;align-items:center;justify-content:center}
.gp-imagewrap img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.gp-imagewrap.framed img{border-radius:var(--slide-radius);box-shadow:0 40px 120px rgba(0,0,0,.35)}
.gp-caption{font:400 28px/1.4 var(--slide-font-body);color:var(--slide-muted);margin:30px 0 0;text-align:center}

/* ── gallery: a grid of shots with optional captions ──────────────────────── */
.gp-gallery{display:grid;gap:36px;flex:1;min-height:0;margin-top:44px;align-items:stretch}
.gp-shot{display:flex;flex-direction:column;gap:16px;min-height:0}
.gp-shot .gp-mediabox{min-height:0;flex:1}
.gp-shot p{font:400 26px/1.35 var(--slide-font-body);color:var(--slide-muted);margin:0;text-align:center}

/* ── logo wall: "trusted by" tiles ────────────────────────────────────────── */
.gp-logos{display:grid;grid-template-columns:repeat(4,1fr);gap:40px;flex:1;align-content:center;margin-top:40px}
.gp-logos .cell{height:190px;border-radius:var(--slide-radius);background:var(--slide-surface);border:1px solid var(--slide-border);display:flex;align-items:center;justify-content:center;padding:38px;box-sizing:border-box}
.gp-logos .cell img{max-width:100%;max-height:100%;object-fit:contain}

/* ── split: two color-blocked half-panes ──────────────────────────────────── */
.gp-splitpane{position:absolute;top:0;bottom:0;width:50%;display:flex;flex-direction:column;justify-content:center;padding:var(--slide-pad);box-sizing:border-box;overflow:hidden}
.gp-splitpane.left{left:0}
.gp-splitpane.right{right:0}
.gp-splitpane.tone-surface{background:var(--slide-surface)}
.gp-splitpane.tone-accent{background:var(--slide-accent)}
.gp-splitpane.tone-accent .gp-title,.gp-splitpane.tone-accent .gp-body,.gp-splitpane.tone-accent .gp-colhead,.gp-splitpane.tone-accent .gp-bullets li{color:var(--slide-bg)}
.gp-splitpane.tone-accent .gp-bullets li::before{background:var(--slide-bg)}
.gp-splitpane .gp-splitmedia{position:absolute;inset:0;background:center/cover no-repeat}

/* ── statement: one massive line ──────────────────────────────────────────── */
.gp-statement{font:800 138px/1.04 var(--slide-font-display);letter-spacing:-.03em;color:var(--slide-fg);margin:0;max-width:1720px}
.gp-statement .gp-accent{color:var(--slide-accent)}
`.trim();
