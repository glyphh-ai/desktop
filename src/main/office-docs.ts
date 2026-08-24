/**
 * office-docs.ts — Glyphh Office · DOCS, the desktop transport.
 *
 * Markdown documents in the ORG library (R2 behind yo-server via
 * client.officeDocs) with the review-and-approve suggestion flow and the
 * code-defined template catalog. Same doctrine as Slides: nothing local,
 * the panel reads/writes through these handlers, the agent through tools.
 */

import { getClient } from "./glyphh-client";

/** Doc refs are bare names — same containment rule as the server (.md). */
export function gdocFileName(name: unknown): string {
  const base = String(name ?? "").trim().split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.(md|markdown)$/i, "").replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
  if (!stem) throw new Error("a document needs a name");
  return `${stem}.md`;
}

