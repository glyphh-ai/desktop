/**
 * contract/relay.ts — "drive-my-desktop" relay governance. SAME-USER only: a user's
 * client reaches that user's OWN desktop, which attach-serves its local rotor over an
 * outbound WS. Consent is layered: the ORG allows relay at all (a flag, default OPEN so
 * users MAY opt in), then each USER opts in PER DEVICE and can revoke any device at any
 * time. Relay API keys are user-scoped (see `contract/api-keys.ts`). This is the control
 * plane for that policy; the WS data-plane bridge is the runtime's attach-serve transport.
 */

export interface RelayPolicy {
  /** Whether the org permits relay at all. Default true (open); an org_admin may close it. */
  orgEnabled: boolean;
}

export type RelayDeviceStatus = "active" | "revoked";

export interface RelayDevice {
  id: string;
  label: string;
  status: RelayDeviceStatus;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface RelayStatus {
  /** The org policy in effect for the caller. */
  orgEnabled: boolean;
  /** The caller's own opted-in devices. */
  devices: RelayDevice[];
}

export interface EnableRelayInput {
  /** A human label for the device being opted in (e.g. "work-laptop"). */
  label: string;
}
