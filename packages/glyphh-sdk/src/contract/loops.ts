/**
 * contract/loops.ts — THE MEMBER'S GATEWAY CREDENTIAL.
 *
 * This file carried the CLI pre-configs — a loop per vendor, the org's support
 * list, a role's grants. All of it went with the bridge (his order,
 * 2026-09-28: one loop, ours). What is left is the credential a host runs a
 * turn inside; the loop library (a program with role slots) is contract/tasks.ts.
 */

/** The member's own gateway credential — what a CLI subprocess runs inside. */
export interface GatewayToken {
  /** Point the CLI's *_BASE_URL at this. */
  baseUrl: string;
  /** The minted key for the CLI's key variable. */
  token: string;
  expiresAt: string | null;
  /** The models this credential may reach, per the caller's role. */
  models: string[];
  /** False = the gateway lane is OFF for this org: keep the CLI on its own login;
   *  the token still authenticates the server's /mcp. Absent = on (older servers). */
  gateway?: boolean;
}
