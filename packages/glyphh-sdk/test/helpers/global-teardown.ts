/**
 * global-teardown.ts — the SDK integration suite cleans up after itself.
 *
 * THE PROBLEM. Nearly every file here signs a user in against a live server, which
 * creates an org, which provisions that org a SCHEMA (`org_<hex>`, ~40 tables) in the
 * stator. Nothing ever dropped them: one full run leaves ~80 orgs / ~80 schemas and
 * ~86 MB of stator behind, and accumulated across runs that reached 10,485 schemas /
 * 12 GB and segfaulted Postgres repeatedly until the database had to be rebuilt. The
 * server repo solved this for its own suite (test/helpers/global-teardown.ts); this is
 * the same sweep for the client that drives the same databases.
 *
 * WHY HERE AND NOT IN A PER-FILE HOOK. Test FILES run in parallel processes against
 * ONE shared database. A per-file teardown cannot safely drop "org schemas that exist"
 * — it would delete schemas another file is still using — and it never runs at all for
 * a file that crashed. Vitest's `globalSetup` runs once in the main process, before any
 * worker starts and after every worker has finished (including on failure), which is
 * the only place a DB-wide sweep is both safe and complete.
 *
 * HOW. Snapshot the org schemas / org ids / user ids that exist BEFORE the run, then
 * delete exactly what appeared during it. Anything already in the database is untouched,
 * a partial/failed run is cleaned the same as a green one, and a run whose server points
 * somewhere else simply finds no new rows and drops nothing.
 *
 * SAFETY. Every step is individually guarded, only `org_<hex>` names are ever touched,
 * the canonical `glyphh` defaults org is excluded (it is the seed source every run
 * copies from), and the teardown NEVER throws — a cleanup problem must not turn a green
 * run red. An unreachable database is skipped.
 */

import pg from "pg";

const CONTROL_URL = process.env.DATABASE_URL ?? "postgres://glyphh:glyphh@127.0.0.1:5432/glyphh";
const STATOR_URL =
  process.env.TENANT_DATABASE_URL ?? process.env.STATOR_TEST_URL ?? "postgres://glyphh:glyphh@127.0.0.1:5434/rotor_stator";

/** The canonical defaults org (server src/domains/org/glyphh-org.ts) and its schema —
 *  the seed source for every new org. Never swept, at any point in its lifetime. */
const GLYPHH_ORG_ID = "00000000-0000-0000-0000-0000000091f0";
const GLYPHH_SCHEMA = `org_${GLYPHH_ORG_ID.replace(/-/g, "").toLowerCase()}`;

/** A single DROP takes a lock on every object it cascades to (~40 tables plus their
 *  indexes/triggers), so keep BATCH × LANES small or the server's lock table overflows
 *  with "out of shared memory"; the one-by-one retry below covers a bad guess. */
const DROP_BATCH = 4;
const DROP_LANES = 4;

interface Snapshot {
  schemas: Set<string>;
  orgIds: Set<string>;
  userIds: Set<string>;
}

/** Vitest's globalSetup passes nothing between setup and teardown, so the pre-run
 *  snapshot lives here (same module instance, same process). */
const before = new Map<string, Snapshot>();

function log(message: string, fields: Record<string, unknown> = {}): void {
  console.log(`[db-sweep] ${message} ${JSON.stringify(fields)}`);
}

async function connect(url: string): Promise<pg.Pool | null> {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000, max: DROP_LANES + 1 });
  try {
    await pool.query("SELECT 1");
    return pool;
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
}

const ORG_SCHEMAS = `SELECT schema_name AS v FROM information_schema.schemata WHERE schema_name LIKE 'org\\_%'`;
const ORG_IDS = `SELECT id::text AS v FROM organizations`;
const USER_IDS = `SELECT id::text AS v FROM users`;

async function ids(pool: pg.Pool, sql: string): Promise<Set<string>> {
  try {
    const { rows } = await pool.query<{ v: string }>(sql);
    return new Set(rows.map((r) => r.v));
  } catch {
    // A table that does not exist here (the stator has no identity tables) simply
    // contributes nothing.
    return new Set();
  }
}

async function snapshot(pool: pg.Pool, identity: boolean): Promise<Snapshot> {
  return {
    schemas: await ids(pool, ORG_SCHEMAS),
    orgIds: identity ? await ids(pool, ORG_IDS) : new Set(),
    userIds: identity ? await ids(pool, USER_IDS) : new Set(),
  };
}

/** Drop schemas in batches over a few parallel lanes; a failed batch is retried one at
 *  a time so a single bad schema cannot strand the rest. Never throws. */
async function dropSchemas(pool: pg.Pool, names: string[]): Promise<number> {
  const batches: string[][] = [];
  for (let i = 0; i < names.length; i += DROP_BATCH) batches.push(names.slice(i, i + DROP_BATCH));

  let dropped = 0;
  let next = 0;
  const lane = async (): Promise<void> => {
    for (let i = next++; i < batches.length; i = next++) {
      const batch = batches[i]!;
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${batch.map((n) => `"${n}"`).join(", ")} CASCADE`);
        dropped += batch.length;
      } catch (e) {
        log("batch drop failed — retrying one at a time", { size: batch.length, message: (e as Error).message });
        for (const name of batch) {
          try {
            await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
            dropped++;
          } catch (inner) {
            log("could not drop schema", { schema: name, message: (inner as Error).message });
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DROP_LANES, batches.length) }, lane));
  return dropped;
}

/** Only ever act on names the provisioner could have minted (`org_<hex>`), so a typo or
 *  a corrupted row can never turn this into an arbitrary DROP. */
function sweepable(name: string, seen: Set<string>): boolean {
  return /^org_[0-9a-f]+$/.test(name) && name !== GLYPHH_SCHEMA && !seen.has(name);
}

async function deleteRows(pool: pg.Pool, table: string, idList: string[]): Promise<number> {
  if (idList.length === 0) return 0;
  try {
    const res = await pool.query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [idList]);
    return res.rowCount ?? 0;
  } catch (e) {
    log("could not delete rows", { table, count: idList.length, message: (e as Error).message });
    return 0;
  }
}

/** Control-plane PROJECTIONS carry no FK to organizations, so the cascade cannot reach
 *  them. Sweep any row whose org is gone — otherwise the next run inherits routing
 *  pointers into stores that no longer exist. */
const PROJECTIONS = ["deployment_index", "runtime_session_index", "support_ticket_index", "flagged_review_index", "usage_rollup"];

async function deleteOrphanProjections(pool: pg.Pool): Promise<void> {
  for (const table of PROJECTIONS) {
    try {
      await pool.query(`DELETE FROM ${table} WHERE org_id NOT IN (SELECT id FROM organizations)`);
    } catch (e) {
      log("could not sweep orphan projection rows", { table, message: (e as Error).message });
    }
  }
}

/**
 * The system catalogs churn hardest: a run mints and drops ~80 schemas × ~40 tables,
 * which bloats pg_class/pg_attribute/… and autovacuum does not keep up with a
 * developer's test loop. One plain VACUUM after the sweep costs a couple of seconds and
 * gives the space back.
 */
const CHURNED_CATALOGS = [
  "pg_catalog.pg_class", "pg_catalog.pg_attribute", "pg_catalog.pg_depend",
  "pg_catalog.pg_type", "pg_catalog.pg_index", "pg_catalog.pg_constraint",
  "pg_catalog.pg_attrdef",
];

async function vacuumCatalogs(pool: pg.Pool, label: string): Promise<void> {
  try {
    await pool.query(`VACUUM (ANALYZE) ${CHURNED_CATALOGS.join(", ")}`);
  } catch (e) {
    log(`${label}: catalog vacuum skipped`, { message: (e as Error).message });
  }
}

async function take(label: string, url: string, identity: boolean): Promise<void> {
  const pool = await connect(url);
  if (!pool) return;
  try {
    before.set(label, await snapshot(pool, identity));
  } catch (e) {
    log(`${label}: could not snapshot, sweep will skip`, { message: (e as Error).message });
  } finally {
    await pool.end().catch(() => {});
  }
}

async function sweep(label: string, url: string, identity: boolean): Promise<void> {
  const pool = await connect(url);
  if (!pool) {
    log(`${label}: unreachable, skipped`);
    return;
  }
  try {
    const start = before.get(label);
    if (!start) {
      log(`${label}: no pre-run snapshot, skipped`);
      return;
    }
    const now = await snapshot(pool, identity);

    const newSchemas = [...now.schemas].filter((s) => sweepable(s, start.schemas));
    const droppedSchemas = newSchemas.length > 0 ? await dropSchemas(pool, newSchemas) : 0;

    let deletedOrgs = 0;
    let deletedUsers = 0;
    if (identity) {
      // Orgs first: the cascade takes memberships, credit lots, apps, invites… Users
      // whose org went with them are then orphans and go next.
      const newOrgs = [...now.orgIds].filter((id) => id !== GLYPHH_ORG_ID && !start.orgIds.has(id));
      const newUsers = [...now.userIds].filter((id) => !start.userIds.has(id));
      deletedOrgs = await deleteRows(pool, "organizations", newOrgs);
      deletedUsers = await deleteRows(pool, "users", newUsers);
      await deleteOrphanProjections(pool);
    }

    if (droppedSchemas > 0) await vacuumCatalogs(pool, label);

    log(`${label}: swept`, {
      schemas_dropped: droppedSchemas,
      schemas_seen_before: start.schemas.size,
      orgs_deleted: deletedOrgs,
      users_deleted: deletedUsers,
    });
  } catch (e) {
    log(`${label}: sweep failed`, { message: (e as Error).message });
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Vitest globalSetup: the exported default runs before the first worker; the returned
 *  function runs after the last one, pass or fail. */
export default async function setup(): Promise<() => Promise<void>> {
  await Promise.all([take("control", CONTROL_URL, true), take("stator", STATOR_URL, false)]);
  return async () => {
    // Sequential: the two targets may share one instance in a collapsed local setup.
    await sweep("control", CONTROL_URL, true);
    await sweep("stator", STATOR_URL, false);
  };
}
