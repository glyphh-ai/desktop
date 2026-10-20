/**
 * contract/app-servers.ts — the app-server IMAGE SKU catalog (super-admin CRUD on
 * `client.admin`). The catalog mirrors the runtime images (per region; whole
 * credits/month, micro-credit metering rate).
 */

// ── the app-server IMAGE catalog (sm / md / lg) ────────────────────────────────

/** A catalog app-server image (one region's row for a SKU key). */
export interface AppServerImage {
  key: string;
  region: string;
  /** Buyer-facing copy for the size picker. */
  description: string;
  /** The dedicated-Postgres tier backing the server. */
  dbTier: string;
  ramMb: number;
  diskGb: number;
  /** Recurring rental in WHOLE credits per month. */
  monthlyCredits: number;
  /** Metering rate in MICRO-credits per second of runtime. */
  costPerSecondMicro: number;
  /** Cost basis in USD cents/month (admin margin input). */
  monthlyUsdCents: number;
  active: boolean;
  sort: number;
}

/** Super-admin create input. `monthlyCredits` is WHOLE credits/month. */
export interface AdminAppServerImageCreate {
  key: string;
  region: string;
  description: string;
  dbTier: string;
  ramMb: number;
  diskGb: number;
  monthlyCredits: number;
  costPerSecondMicro: number;
  monthlyUsdCents?: number;
  active?: boolean;
  sort?: number;
}

/** Super-admin edit input (all optional; omitted fields keep their value). */
export interface AdminAppServerImageUpdate {
  description?: string;
  dbTier?: string;
  ramMb?: number;
  diskGb?: number;
  monthlyCredits?: number;
  costPerSecondMicro?: number;
  monthlyUsdCents?: number;
  active?: boolean;
  sort?: number;
}
