/**
 * app-spec — the one contract every app builder shares: the spec text, the
 * validators, and the Next.js template.
 */

import { APP_TEMPLATE_FILES } from "./template.js";

export { GLYPHH_APP_SPEC } from "./spec.js";
export { scaffoldAppFiles, slugOf as appSlugOf, SCAFFOLD_NEXT } from "./scaffold.js";
export type { ScaffoldOptions, ScaffoldTool, ScaffoldConnection } from "./scaffold.js";
export {
  validateAppBundle, validateAppProject, parseAppManifest, lintRemoteAssets,
  checkCallTargets, checkCronExpressions, checkSqlDialect, extractConnectorCalls,
  KNOWN_CAPABILITIES, RETIRED_CAPABILITIES, MANIFEST_VERSIONS, APP_MANIFEST,
} from "./validate.js";
export type { AppBundle, AppValidationResult, ParsedAppManifest, AppManifestTool } from "./validate.js";

/** The Next.js app template (sdk/templates/app-next) as { path: content } —
 *  a fresh copy each call, ready to write to a folder. */
export function appTemplateFiles(): Record<string, string> {
  return { ...APP_TEMPLATE_FILES };
}
