/**
 * models/hardware.ts — detect the machine so we can auto-size a local model. RAM is the
 * binding constraint for a GGUF at Q4 (params × ~0.6 GB + context); Apple Silicon shares
 * RAM with the GPU (Metal), so unified memory is what matters there. GPU VRAM detection is
 * a later refinement — RAM-based sizing is the safe floor.
 */

import { totalmem, platform, arch, cpus } from "node:os";

export interface Hardware {
  platform: NodeJS.Platform;
  arch: string;
  totalRamGB: number;
  cpuCount: number;
  /** Apple Silicon → RAM is shared with the GPU (Metal), so bigger models are viable. */
  appleSilicon: boolean;
}

export function detectHardware(): Hardware {
  return {
    platform: platform(),
    arch: arch(),
    totalRamGB: Math.round(totalmem() / 1e9),
    cpuCount: cpus().length,
    appleSilicon: platform() === "darwin" && arch() === "arm64",
  };
}
