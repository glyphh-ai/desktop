// The server side of the app. Sandboxed: no fetch/require/import/process —
// everything goes through glyphh.call(capability, args), which resolves
// { ok: true, result } or { ok: false, error } and never throws.

async function call(method, args) {
  const res = await glyphh.call(method, args ?? {});
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

async function ensureSchema() {
  await call("db.exec", {
    sql: "CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  });
}

// The handler behind the manifest tool `add_note` (app_call_tool runs it).
glyphh.handle("add_note", async ({ text }) => {
  const body = String(text ?? "").trim();
  if (!body) throw new Error("text is required");
  await ensureSchema();
  const { rows } = await call("db.exec", {
    sql: "INSERT INTO notes (text) VALUES ($1) RETURNING id, text, created_at",
    params: [body],
  });
  return rows[0];
});
