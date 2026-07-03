/**
 * Keep in Touch — worker (the headless half of the app).
 *
 * Runs hidden inside Glyphh. Owns the schema, backs every MCP tool the
 * manifest declares, and keeps a 9am daily cron that checks who's due and
 * raises an OS notification. Everything goes through glyphh.call() — the
 * per-app SQLite (db.exec), the scheduler (cron.*), notifications
 * (notify.send), and Messages (messages.send).
 */

/* global glyphh */

async function call(method, args) {
  const res = await glyphh.call(method, args);
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

const DUE_WHERE = "(last_touch IS NULL OR julianday('now') - julianday(last_touch) >= cadence_days)";

async function ensureSchema() {
  await call("db.exec", {
    sql: `CREATE TABLE IF NOT EXISTS people (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            handle TEXT NOT NULL,
            cadence_days INTEGER NOT NULL DEFAULT 14,
            notes TEXT,
            last_touch TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )`,
  });
  await call("db.exec", {
    sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_people_name ON people (name COLLATE NOCASE)",
  });
}

function rowOut(r) {
  return {
    name: r.name,
    handle: r.handle,
    cadence_days: r.cadence_days,
    notes: r.notes || undefined,
    last_touch: r.last_touch || null,
    due: !!r.due,
    overdue_days: r.overdue_days == null ? null : Math.floor(r.overdue_days),
  };
}

const SELECT_COLS = `name, handle, cadence_days, notes, last_touch,
  ${DUE_WHERE} AS due,
  CASE WHEN last_touch IS NULL THEN NULL
       ELSE julianday('now') - julianday(last_touch) - cadence_days END AS overdue_days`;

async function findPerson(name) {
  const { rows } = await call("db.exec", {
    sql: `SELECT id, ${SELECT_COLS} FROM people WHERE name = ? COLLATE NOCASE`,
    params: [String(name || "").trim()],
  });
  return rows[0] || null;
}

// ── handlers: the MCP tool surface ──────────────────────────

glyphh.handle("add_person", async (args) => {
  await ensureSchema();
  const name = String(args.name || "").trim();
  const handle = String(args.handle || "").trim();
  if (!name || !handle) throw new Error("name and handle are required");
  const cadence = Math.max(1, Math.min(365, parseInt(args.cadence_days, 10) || 14));
  const notes = args.notes ? String(args.notes) : null;
  await call("db.exec", {
    sql: `INSERT INTO people (name, handle, cadence_days, notes) VALUES (?, ?, ?, ?)
          ON CONFLICT (name COLLATE NOCASE) DO UPDATE SET
            handle = excluded.handle, cadence_days = excluded.cadence_days,
            notes = COALESCE(excluded.notes, people.notes)`,
    params: [name, handle, cadence, notes],
  });
  return { saved: true, name, handle, cadence_days: cadence };
});

glyphh.handle("list_people", async () => {
  await ensureSchema();
  const { rows } = await call("db.exec", {
    sql: `SELECT ${SELECT_COLS} FROM people ORDER BY due DESC, overdue_days DESC, name`,
  });
  return rows.map(rowOut);
});

glyphh.handle("due_today", async () => {
  await ensureSchema();
  const { rows } = await call("db.exec", {
    sql: `SELECT ${SELECT_COLS} FROM people WHERE ${DUE_WHERE} ORDER BY overdue_days DESC, name`,
  });
  return rows.map(rowOut);
});

glyphh.handle("log_touch", async (args) => {
  await ensureSchema();
  const person = await findPerson(args.name);
  if (!person) throw new Error(`no one named "${args.name}" — add_person first`);
  await call("db.exec", { sql: "UPDATE people SET last_touch = datetime('now') WHERE id = ?", params: [person.id] });
  return { logged: true, name: person.name };
});

glyphh.handle("send_checkin", async (args) => {
  await ensureSchema();
  const person = await findPerson(args.name);
  if (!person) throw new Error(`no one named "${args.name}" — add_person first`);
  const body = String(args.body || "").trim();
  if (!body) throw new Error("body is required");
  await call("messages.send", { to: person.handle, body });
  await call("db.exec", { sql: "UPDATE people SET last_touch = datetime('now') WHERE id = ?", params: [person.id] });
  return { sent: true, to: person.name, handle: person.handle };
});

// ── daily nudge (cron → notification) ───────────────────────

glyphh.handle("daily_check", async () => {
  await ensureSchema();
  const { rows } = await call("db.exec", {
    sql: `SELECT name FROM people WHERE ${DUE_WHERE} ORDER BY julianday('now') - julianday(COALESCE(last_touch, created_at)) DESC`,
  });
  if (!rows.length) return { due: 0 };
  const names = rows.map((r) => r.name);
  const shown = names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4} more` : "");
  await call("notify.send", {
    title: "Keep in Touch",
    body: names.length === 1 ? `Time to reach out to ${shown}.` : `${names.length} people are due: ${shown}`,
  });
  return { due: names.length, names };
});

// Startup: make sure the schema and the daily 9am nudge exist. cron.schedule
// is an upsert, so re-registering on every worker start is safe.
(async () => {
  try {
    await ensureSchema();
    await call("cron.schedule", { id: "daily-nudge", cron: "0 9 * * *", handler: "daily_check" });
  } catch (err) {
    console.error("keep-in-touch worker setup failed:", err.message);
  }
})();
