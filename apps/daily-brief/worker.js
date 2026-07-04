/**
 * Daily Brief — worker (headless pipeline + MCP tools).
 *
 * Pipeline (generate_brief, also fired by the 7am cron):
 *   1. connector.call  — Fox News via the rss connector, recent Gmail,
 *                        today's Google Calendar events
 *   2. llm.complete    — one structured-JSON summarization pass
 *                        (provider picked from whichever <PROVIDER>_API_KEY
 *                        config var the user has set; graceful list-only
 *                        fallback with no key)
 *   3. db.exec         — store the brief (one row per day)
 *   4. vector.upsert   — index every story/email/event for NL search
 *   5. notify.send     — "Your Daily Brief is ready"
 *
 * NOTE: generateBrief() is mirrored in index.html (the UI cannot invoke
 * worker handlers — it has the same capability bridge instead). If you
 * change the pipeline here, update the copy there.
 */

/* global glyphh */

async function call(method, args) {
  const res = await glyphh.call(method, args);
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

const FOX_FEEDS = [
  "https://moxie.foxnews.com/google-publisher/latest.xml",
  "https://moxie.foxnews.com/google-publisher/politics.xml",
];

const SYS_PROMPT =
  "You are a sharp, neutral morning-brief editor. You are given raw source dumps " +
  "(news feed items, email metadata, calendar events — some may be missing). " +
  "Respond with ONLY a JSON object, no markdown fence, matching exactly: " +
  '{"headline": string (one punchy line for the day), ' +
  '"summary_md": string (2-3 short paragraphs: news first, then inbox, then the day ahead), ' +
  '"news": [{"title": string, "summary": string}] (top stories, max 8), ' +
  '"emails": [{"from": string, "subject": string, "gist": string, "urgent": boolean}] (max 10, most important first), ' +
  '"events": [{"time": string, "title": string, "location": string}] (chronological, max 10)}. ' +
  "Omit sections you have no data for by using empty arrays. Be concrete and brief.";

function parseJsonLoose(text) {
  if (!text) return null;
  const raw = String(text).trim();
  const attempt = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return attempt(raw)
    || attempt(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""))
    || attempt(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
}

async function ensureSchema() {
  await call("db.exec", {
    sql: `CREATE TABLE IF NOT EXISTS briefs (
            date TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            json TEXT NOT NULL
          )`,
  });
}

async function pickProvider() {
  try {
    const keys = await call("secrets.list", {});
    const has = (k) => keys.some((x) => x.key === k && x.readable);
    if (has("ANTHROPIC_API_KEY")) return "anthropic";
    if (has("OPENAI_API_KEY")) return "openai";
    if (has("GOOGLE_API_KEY")) return "google";
  } catch { /* secrets unavailable — fall through */ }
  return null;
}

async function gatherSources() {
  const sources = { news: null, gmail: null, calendar: null };
  const problems = [];
  const status = await call("connector.status", {});
  const by = {};
  for (const s of status) by[s.connector] = s;

  if (by.gmail && by.gmail.connected) {
    try {
      const r = await call("connector.call", {
        connector: "gmail",
        tool: "gmail-find-email",
        args: { q: "in:inbox newer_than:1d", maxResults: 20, format: "metadata" },
      });
      sources.gmail = String(r.result || r).slice(0, 9000);
    } catch (e) { problems.push("Gmail fetch failed: " + e.message); }
  } else problems.push("Gmail is not connected (connect it in Glyphh → Connections).");

  if (by.google_calendar && by.google_calendar.connected) {
    try {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 36 * 3600 * 1000);
      const r = await call("connector.call", {
        connector: "google_calendar",
        tool: "google_calendar-list-events",
        args: {
          timeMin: start.toISOString(), timeMax: end.toISOString(),
          singleEvents: true, orderBy: "startTime", maxResults: 30,
        },
      });
      sources.calendar = String(r.result || r).slice(0, 9000);
    } catch (e) { problems.push("Calendar fetch failed: " + e.message); }
  } else problems.push("Google Calendar is not connected (connect it in Glyphh → Connections).");

  if (by.rss && by.rss.connected) {
    try {
      // Discover the feed-fetch tool at runtime — connector tool names drift.
      const tools = await call("connector.tools", { connector: "rss" });
      const tool = tools.find((t) => /merge|fetch|items|feed/i.test(t.name));
      if (!tool) throw new Error("the rss connector exposes no feed-fetch tool");
      const props = (tool.inputSchema && tool.inputSchema.properties) || {};
      const key = Object.keys(props).find((k) => /url|feed/i.test(k)) || "feedUrls";
      const wantsArray = props[key] && props[key].type === "array";
      const r = await call("connector.call", {
        connector: "rss",
        tool: tool.name,
        args: { [key]: wantsArray ? FOX_FEEDS : FOX_FEEDS[0] },
      });
      sources.news = String(r.result || r).slice(0, 12000);
    } catch (e) { problems.push("Fox News fetch failed: " + e.message); }
  } else problems.push("RSS is not connected — connect the RSS app in Glyphh → Connections to get Fox News.");

  return { sources, problems };
}

/** No-LLM fallback: surface raw source text so the brief is never empty. */
function mechanicalBrief(sources, problems) {
  return {
    headline: "Daily Brief (unsummarized)",
    summary_md:
      "No LLM key is configured, so today's sources are shown raw. " +
      "Set ANTHROPIC_API_KEY (or OPENAI_API_KEY / GOOGLE_API_KEY) on this app's Config Vars tab for real summaries.",
    news: sources.news ? [{ title: "Raw Fox News feed", summary: sources.news.slice(0, 1500) }] : [],
    emails: sources.gmail ? [{ from: "(raw)", subject: "Raw Gmail results", gist: sources.gmail.slice(0, 1500), urgent: false }] : [],
    events: sources.calendar ? [{ time: "", title: "Raw calendar results", location: sources.calendar.slice(0, 1500) }] : [],
    problems,
  };
}

async function generateBrief() {
  await ensureSchema();
  const dateKey = new Date().toISOString().slice(0, 10);
  const { sources, problems } = await gatherSources();
  const provider = await pickProvider();

  let brief = null;
  if (provider && (sources.news || sources.gmail || sources.calendar)) {
    const prompt =
      `Build my morning brief for ${dateKey}.\n\n` +
      `── FOX NEWS FEED ──\n${sources.news || "(unavailable)"}\n\n` +
      `── GMAIL (last 24h, metadata) ──\n${sources.gmail || "(unavailable)"}\n\n` +
      `── GOOGLE CALENDAR (today) ──\n${sources.calendar || "(unavailable)"}`;
    try {
      const res = await call("llm.complete", { provider, system: SYS_PROMPT, prompt });
      brief = parseJsonLoose(res.text);
    } catch (e) { problems.push(`Summarization failed (${provider}): ` + e.message); }
  } else if (!provider) {
    problems.push("No LLM key set — add ANTHROPIC_API_KEY on the Config Vars tab for real summaries.");
  }
  if (!brief) brief = mechanicalBrief(sources, problems);

  brief.date = dateKey;
  brief.generated_at = new Date().toISOString();
  brief.problems = problems;

  await call("db.exec", {
    sql: `INSERT INTO briefs (date, created_at, json) VALUES (?, ?, ?)
          ON CONFLICT (date) DO UPDATE SET created_at = excluded.created_at, json = excluded.json`,
    params: [dateKey, brief.generated_at, JSON.stringify(brief)],
  });

  // Index every item for natural-language search.
  const items = [];
  const push = (kind, text, title) => items.push({
    id: `${dateKey}:${kind}:${items.length}`,
    text,
    metadata: { kind, date: dateKey, title: String(title || "").slice(0, 200) },
  });
  for (const n of brief.news || []) push("news", `${n.title}. ${n.summary || ""}`, n.title);
  for (const e of brief.emails || []) push("email", `Email from ${e.from}: ${e.subject}. ${e.gist || ""}`, e.subject);
  for (const ev of brief.events || []) push("event", `Calendar event: ${ev.title} ${ev.time || ""} ${ev.location || ""}`, ev.title);
  if (items.length) {
    try { await call("vector.upsert", { collection: "brief-items", items }); }
    catch (e) { brief.problems.push("Search indexing failed: " + e.message); }
  }
  return brief;
}

// ── MCP tool handlers ────────────────────────────────────────

glyphh.handle("generate_brief", async () => {
  const brief = await generateBrief();
  try {
    await call("notify.send", {
      title: "Daily Brief",
      body: brief.headline || "Your daily brief is ready.",
    });
  } catch { /* notification is best-effort */ }
  return brief;
});

glyphh.handle("get_brief", async (args) => {
  await ensureSchema();
  const date = args && args.date ? String(args.date) : null;
  const { rows } = await call("db.exec", {
    sql: date
      ? "SELECT json FROM briefs WHERE date = ?"
      : "SELECT json FROM briefs ORDER BY date DESC LIMIT 1",
    params: date ? [date] : [],
  });
  if (!rows.length) return { exists: false, hint: "No brief stored yet — call generate_brief." };
  return JSON.parse(rows[0].json);
});

glyphh.handle("search_brief", async (args) => {
  const query = String((args && args.query) || "").trim();
  if (!query) throw new Error("query is required");
  const k = Math.max(1, Math.min(25, parseInt(args && args.k, 10) || 8));
  const req = { collection: "brief-items", query, k };
  if (args && args.kind) req.filter = { kind: String(args.kind) };
  const { matches } = await call("vector.search", req);
  return matches.map((m) => ({
    kind: m.metadata && m.metadata.kind,
    date: m.metadata && m.metadata.date,
    title: m.metadata && m.metadata.title,
    text: m.text,
    score: Math.round(m.score * 1000) / 1000,
  }));
});

// ── startup: schema + the 7am daily run (cron.schedule is an upsert) ──
(async () => {
  try {
    await ensureSchema();
    await call("cron.schedule", { id: "daily-brief", cron: "0 7 * * *", handler: "generate_brief" });
  } catch (err) {
    console.error("daily-brief worker setup failed:", err.message);
  }
})();
