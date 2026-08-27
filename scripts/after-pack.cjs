/**
 * electron-builder `afterPack` hook.
 *
 * Copy the vendored rrotor pod's node_modules INTO the packed resources.
 * electron-builder's extraResources file-sets silently drop `node_modules`
 * directories (a hardcoded default exclude), so beta.3 shipped rrotor as
 * dist + package.json with ZERO deps — the pod died on boot with
 * ERR_MODULE_NOT_FOUND (ajv) and every local session saw "the local runtime
 * did not become healthy in time". This hook runs after the file-sets, when
 * the resources dir is plain filesystem, and copies what the filter dropped.
 */

const fs = require("fs");
const path = require("path");

/** @param {{ appOutDir: string, electronPlatformName: string, packager: any }} context */
exports.default = async function afterPack(context) {
  const src = path.join(context.packager.projectDir, "vendor", "rrotor", "node_modules");
  if (!fs.existsSync(src)) return; // dev/local packs without a vendored pod
  const resources = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const dest = path.join(resources, "rrotor", "node_modules");
  fs.rmSync(dest, { recursive: true, force: true });
  // NO SYMLINKS and no .bin shims: npm's .bin links go broken after pruning,
  // and `codesign --verify --deep --strict` refuses to seal a bundle holding
  // them (the mac beta.5 build died exactly there). The pod imports by
  // package name only — bin shims are installer plumbing it never runs.
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      if (path.basename(p) === ".bin") return false;
      try { if (fs.lstatSync(p).isSymbolicLink()) return false; } catch { return false; }
      return true;
    },
  });
  // Fail the BUILD, not a user's machine: the pod's hard imports must resolve.
  for (const dep of ["ajv", "ajv-formats", "yaml", "@modelcontextprotocol/sdk"]) {
    if (!fs.existsSync(path.join(dest, dep))) {
      throw new Error(`vendored rrotor is missing ${dep} — the pod cannot boot`);
    }
  }
  console.log(`[after-pack] rrotor node_modules → ${dest}`);
};
