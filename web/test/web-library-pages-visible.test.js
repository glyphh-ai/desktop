/**
 * The member library's pages open on the web (his rule, 2026-10-04: drips,
 * schedules, workspaces, tabs, skills, agents, tasks are database records the
 * web lists and edits). A `.glyphh-web … display:none` rule on one of their
 * settings panels blanks the page with no error anywhere — his report
 * 2026-10-04: "the drips panel isn't loading", a stale rule from when drips
 * was a desktop-only surface. This test reads the stylesheet so it cannot
 * come back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "..", "src", "renderer", "styles.css"), "utf-8");

const LIBRARY_SUBS = ["drips", "schedules", "layouts", "tabs", "skills", "agents", "tasks"];

describe("the web never hides a member-library settings page", () => {
  for (const sub of LIBRARY_SUBS) {
    it(`no .glyphh-web rule hides the ${sub} panel or its nav row`, () => {
      const re = new RegExp(String.raw`\.glyphh-web[^{]*\[data-sub="${sub}"\][^{]*\{[^}]*display:\s*none`, "g");
      expect(css.match(re) ?? []).toEqual([]);
    });
  }
});
