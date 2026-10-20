/**
 * house-store.ts — THE HOUSE APPS' STORE ON THE DESKTOP: shared/house-store.ts
 * over the local member library (member-library-local.ts). The panels' IPC
 * (design.ts, gpoints.ts, media-panel.ts, drive.ts, office-export.ts) all go
 * through here; the records and their bytes live under the local user's home.
 */

import { createHash } from "crypto";
import { localLibrary, localLibraryBytes } from "./member-library-local.js";
import { createHouseStore, type HouseStore } from "../shared/house-store.js";

let built: HouseStore | null = null;

export function houseStore(): HouseStore {
  return (built ??= createHouseStore({
    lib: localLibrary,
    bytes: localLibraryBytes,
    sha256: async (b) => createHash("sha256").update(b).digest("hex"),
  }));
}
