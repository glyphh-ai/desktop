"use client";

// The page reaches the host ONLY through the injected shim:
//   window.glyphh.call(capability, args) -> { ok, result } | { ok: false, error }
// It shares the DATABASE with the worker (db.exec on the same schema); the
// worker's handlers back the tools the agent calls (app_call_tool).

import { useEffect, useState } from "react";
import manifest from "../manifest.json";

const ENSURE = "CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())";

async function call(method, args) {
  const res = await window.glyphh.call(method, args ?? {});
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

export default function Page() {
  const [pong, setPong] = useState(null);
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    await call("db.exec", { sql: ENSURE });
    const { rows } = await call("db.exec", { sql: "SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT 50" });
    setNotes(rows);
  }

  useEffect(() => {
    call("ping", { from: "ui" }).then(setPong).catch((e) => setError(e.message));
    refresh().catch((e) => setError(e.message));
  }, []);

  async function add() {
    if (!text.trim()) return;
    setError("");
    try {
      await call("db.exec", { sql: "INSERT INTO notes (text) VALUES ($1)", params: [text.trim()] });
      setText("");
      await refresh();
    } catch (e) { setError(e.message); }
  }

  return (
    <main style={{ padding: 24, maxWidth: 680 }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>{manifest.name}</h1>
      <p style={{ color: "#c4c4c4", marginTop: 4 }}>{manifest.description}</p>
      <p style={{ fontSize: 12, color: "#828282" }}>
        bridge: {pong ? "ok" : error ? "unreachable" : "…"}
      </p>

      <h2 style={{ fontSize: 14, marginTop: 24 }}>Tools the agent can call</h2>
      <ul style={{ paddingLeft: 18, color: "#c4c4c4" }}>
        {manifest.tools.map((t) => (
          <li key={t.name}><code>{t.name}</code> — {t.description}</li>
        ))}
      </ul>

      <h2 style={{ fontSize: 14, marginTop: 24 }}>Notes</h2>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          placeholder="A short note"
          style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid #3f3f46", background: "#252528", color: "#f1f1f1" }}
        />
        <button onClick={add} style={{ padding: "8px 14px", borderRadius: 8, border: 0, background: "#af5fff", color: "#fff" }}>Add</button>
      </div>
      {error ? <p style={{ color: "#ff7a70" }}>{error}</p> : null}
      <ul style={{ paddingLeft: 18 }}>
        {notes.map((n) => <li key={n.id}>{n.text}</li>)}
      </ul>
    </main>
  );
}
