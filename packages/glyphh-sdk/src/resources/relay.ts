/**
 * resources/relay.ts — "drive-my-desktop" relay governance (control plane). `status`
 * shows the org policy + your opted-in devices; `enable` opts a device in (only if the
 * org allows it); `disable` revokes one; `setPolicy` is the org_admin toggle for whether
 * the org permits relay at all. The WS attach-serve bridge is the runtime's transport.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { RelayDevice, RelayPolicy, RelayStatus } from "../contract/relay.js";

export class RelayClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The org policy in effect plus your own opted-in devices. */
  status(): Promise<RelayStatus> {
    return this.http.get<RelayStatus>("/api/relay/status");
  }

  /** Opt a device in (fails if the org has relay disabled). */
  enable(label: string): Promise<RelayDevice> {
    return this.http.post<RelayDevice>("/api/relay/devices", { label });
  }

  /** Revoke one of your devices. */
  disable(deviceId: string): Promise<void> {
    return this.http.del<void>(`/api/relay/devices/${encodeURIComponent(deviceId)}`);
  }

  /** Set whether the org permits relay at all (org_admin). */
  setPolicy(enabled: boolean): Promise<RelayPolicy> {
    return this.http.patch<RelayPolicy>("/api/relay/policy", { enabled });
  }
}
