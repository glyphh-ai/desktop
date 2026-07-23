/**
 * electron-builder `beforePack` hook.
 *
 * For the WINDOWS build only, fetch the official Microsoft Visual C++ 2015–2022
 * x64 redistributable into the build-resources dir (assets/). The NSIS custom
 * script (assets/installer.nsh) bundles + runs it during install so kuzu's
 * native module — which links against that runtime — can load on Windows.
 *
 * No-op on macOS/Linux. Skips the download if a valid copy is already present.
 */

const fs = require("fs");
const path = require("path");

const REDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe";
const MIN_BYTES = 1_000_000; // a real redist is ~25 MB; guard against error pages

/** @param {{ electronPlatformName: string, packager: any }} context */
exports.default = async function beforePack(context) {
  if (context.electronPlatformName !== "win32") return;

  const buildRes = context.packager.info.buildResourcesDir
    || path.join(context.packager.projectDir, "assets");
  const dest = path.join(buildRes, "vc_redist.x64.exe");

  if (fs.existsSync(dest) && fs.statSync(dest).size > MIN_BYTES) {
    console.log(`[before-pack] VC++ redistributable already present: ${dest}`);
    return;
  }

  fs.mkdirSync(buildRes, { recursive: true });
  console.log(`[before-pack] downloading VC++ redistributable → ${dest}`);

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(REDIST_URL, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < MIN_BYTES) throw new Error(`suspiciously small (${buf.length} bytes)`);
      fs.writeFileSync(dest, buf);
      console.log(`[before-pack] wrote ${buf.length} bytes`);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[before-pack] attempt ${attempt}/3 failed: ${err && err.message}`);
    }
  }
  throw new Error(`[before-pack] could not fetch the VC++ redistributable: ${lastErr && lastErr.message}`);
};
