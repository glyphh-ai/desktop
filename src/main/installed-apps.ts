/**
 * installed-apps — discover + launch the apps installed on this machine, so
 * `.dip <name>` (and the agent, over attach) can open them even when they were
 * never added to the Glyphh library.
 *
 * The implementation is the SDK's shared MACHINE layer (@glyphh/sdk/machine):
 * one codebase for every host of machine-reach — this desktop, and the CLI on
 * machines without one. This module only re-exports it so existing callers
 * keep their import path.
 */

export {
  listInstalledApps,
  findInstalledApp,
  launchInstalledApp,
  normKey,
  isSubsequence,
  type InstalledApp,
} from "@glyphh/sdk/machine";
