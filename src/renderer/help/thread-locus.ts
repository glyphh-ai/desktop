/**
 * thread-locus.ts — where a thread runs, read off its record.
 *
 * A COPY of `threadLocus` in src/shared/member-library.ts, kept in the renderer
 * on purpose: the renderer never imports src/shared (one such import moves tsc's
 * rootDir and the app runs stale code — the 2026-09-17 incident, guarded by
 * scripts/check-renderer-emit.mjs). Keep the two in step.
 */
/** The cloud workers' session root: a "local" source whose path lives under
 *  it is a cloud session that a desktop republished with its own stamp (his
 *  report, 2026-10-05: the rail then asked for remote control of
 *  /data/glyphh-harness/sessions/…/workspace). */
export const CLOUD_WORKSPACE_ROOT = "/data/glyphh-harness/";
export function isCloudWorkspacePath(p: unknown): boolean {
  return typeof p === "string" && p.startsWith(CLOUD_WORKSPACE_ROOT);
}
/** A source read off a record, healed: a local stamp over a cloud workspace
 *  path is the cloud's bare session again. Anything else passes through. */
export function healSource<T>(source: T): T {
  const src = source as { kind?: unknown; path?: unknown } | null | undefined;
  if (src && typeof src === "object" && src.kind === "local" && isCloudWorkspacePath(src.path)) return { kind: "cloud-new" } as unknown as T;
  return source;
}
export function threadLocus(c: { source?: unknown; workdir?: unknown; messages?: unknown[]; messageCount?: number }): "local" | "cloud" {
  const src = c.source as { kind?: unknown; path?: unknown } | null | undefined;
  const kind = src && typeof src === "object" && typeof src.kind === "string" ? src.kind : "";
  if (kind === "local" && isCloudWorkspacePath(src?.path)) return "cloud";
  if (kind === "local") return "local";
  if (isCloudWorkspacePath(c.workdir)) return "cloud";
  if (kind.startsWith("cloud")) return "cloud";
  if (typeof c.workdir === "string" && c.workdir) return "local";
  const adoptedStub = typeof c.messageCount === "number" && c.messageCount > 0 && !(c.messages?.length);
  return adoptedStub ? "cloud" : "local";
}
