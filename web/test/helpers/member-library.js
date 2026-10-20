/** THE MEMBER LIBRARY (his rule, 2026-10-04: database-as-truth) — an in-memory
 *  `client.memberLibrary` seeded per kind, honouring the LWW put/remove rule. */
import { vi } from 'vitest';

// ONE LIST (2026-10-06): a workspace row is a workspace on every surface; it carries the SURFACE it was
// made on (`surface`, his order the same day) and each surface lists its own — this one is the web's.
export const GRID = { name: 'Grid', version: 2, cols: 2, rows: 1, colWidths: [0.5, 0.5], rowHeights: [1], cells: [{ panelId: 'p', col: 0, row: 0, colSpan: 1, rowSpan: 1 }], surface: 'web', updatedAt: 1_000 };
export const CRM = { id: 'crm', kind: 'web', slug: 'crm', name: 'CRM', prodUrl: 'https://crm', nativeRef: null, config: null, description: '', access: 'members', owned: true, latestVersion: null, version: '0.1.0', secretNames: [], requiredConnections: [], listing: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
export const DRIP = { name: 'party', recipe: '3 confetti fireworks' };
export const SCHED = { name: 'Morning digest', cron: '0 9 * * 1-5', kind: 'task', target: 'digest', agentId: null, ownerAgentId: null, args: {}, enabled: true };
export const ADA = { id: 'a', slug: 'a', name: 'Ada', description: '', prompt: '', provider: '', model: '', skills: [], apps: [], live: true, guardrails: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
export function fakeLibrary(seed = {}) {
  const rows = new Map();
  const put = (kind, id, row) => rows.set(`${kind}:${id}`, { kind, id, deletedAt: null, files: [], createdAt: '', ...row });
  for (const [kind, list] of Object.entries(seed)) for (const r of list) put(kind, r.id, r);
  const notFound = () => { const e = new Error('not found'); e.httpStatus = 404; e.code = 'not_found'; return e; };
  return {
    rows,
    list: vi.fn(async (kind) => [...rows.values()].filter((r) => r.kind === kind && !r.deletedAt).map((r) => ({ kind, id: r.id, updatedAt: r.updatedAt, deletedAt: null, data: r.data }))),
    get: vi.fn(async (kind, id) => { const r = rows.get(`${kind}:${id}`); if (!r || r.deletedAt) throw notFound(); return r; }),
    put: vi.fn(async (kind, id, input) => {
      const cur = rows.get(`${kind}:${id}`);
      const applied = !cur || input.updatedAt > cur.updatedAt;
      if (applied) put(kind, id, { data: input.data, files: input.files ?? [], updatedAt: input.updatedAt });
      return { applied, item: rows.get(`${kind}:${id}`) };
    }),
    remove: vi.fn(async (kind, id, input = {}) => {
      const cur = rows.get(`${kind}:${id}`);
      if (!cur || cur.deletedAt) throw notFound();
      if (input.updatedAt !== undefined && input.updatedAt <= cur.updatedAt) { const e = new Error('stale'); e.httpStatus = 409; e.code = 'stale'; throw e; }
      rows.set(`${kind}:${id}`, { ...cur, deletedAt: new Date(input.updatedAt ?? Date.now()).toISOString(), updatedAt: input.updatedAt ?? Date.now() });
    }),
    files: vi.fn(async (kind, id, paths) => ({ put: Object.fromEntries(paths.map((p) => [p, `https://r2/put/${kind}/${id}/${p}`])), get: Object.fromEntries(paths.map((p) => [p, `https://r2/get/${kind}/${id}/${p}`])) })),
  };
}
export const seededLibrary = () => fakeLibrary({
  workspace: [{ id: 'grid', updatedAt: 1_000, data: GRID }], tab: [{ id: 'crm', updatedAt: 1_000, data: CRM }], agent: [{ id: 'a', updatedAt: 1_000, data: ADA }],
  drip: [{ id: 'party', updatedAt: 1_000, data: DRIP }], schedule: [{ id: 's1', updatedAt: 1_000, data: SCHED }],
});

