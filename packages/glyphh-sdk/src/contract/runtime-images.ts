/**
 * contract/runtime-images.ts — the runtime IMAGE catalog (§7b): the SKUs an org's
 * runtime is provisioned FROM. `free` maps to the region's SHARED runtime; the
 * dedicated sizes map to per-org instances. Rows are per region; credits are WHOLE
 * credits per month (the server keeps micro-credit precision); the per-second
 * metering rate stays in micro-credits (sub-credit by nature).
 */

export type RuntimeImageType = "shared" | "dedicated";

/** A catalog image (one region's row for a SKU key). */
export interface RuntimeImage {
  key: string;
  displayName: string;
  region: string;
  type: RuntimeImageType;
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

/** The org's current image + the route it is realized as. */
export interface OrgRuntimeImage {
  /** The bound SKU key ('free' by default, for every org). */
  key: string;
  /** The org's effective region (what the key resolves against). */
  region: string;
  /** The realized route's mode: 'shared' | 'dedicated'. */
  mode: string;
  /** The route's provisioning status ('ready' | 'migrating' | 'error'). */
  status: string;
  /** The resolved catalog image, or null when the bound key no longer exists in the
   *  org's region (a retired SKU — serving continues off the realized route). */
  image: RuntimeImage | null;
  /** PROVENANCE: the catalog row id the current route was provisioned FROM (stamped
   *  on every image transition). Null = last provisioned outside the image path. */
  provisionedImageId: string | null;
}

/** Super-admin create input. `monthlyCredits` is WHOLE credits/month. */
export interface AdminRuntimeImageCreate {
  key: string;
  region: string;
  displayName: string;
  type: RuntimeImageType;
  ramMb: number;
  diskGb: number;
  monthlyCredits: number;
  costPerSecondMicro: number;
  monthlyUsdCents?: number;
  active?: boolean;
  sort?: number;
}

/** Super-admin edit input (all optional; omitted fields keep their value). */
export interface AdminRuntimeImageUpdate {
  displayName?: string;
  ramMb?: number;
  diskGb?: number;
  monthlyCredits?: number;
  costPerSecondMicro?: number;
  monthlyUsdCents?: number;
  active?: boolean;
  sort?: number;
}
