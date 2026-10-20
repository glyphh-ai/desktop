import { describe, expect, it } from "vitest";
import { SCAFFOLD_NEXT, scaffoldAppFiles, slugOf } from "../../src/app-spec/scaffold.js";
import { appTemplateFiles } from "../../src/app-spec/index.js";
import { validateAppProject } from "../../src/app-spec/validate.js";

describe("THE STARTER (2026-10-07): glyphh_app_scaffold's files", () => {
  it("rewrites the template for the app asked for: manifest, worker handlers, SKILL.md, the member's real connection tools", () => {
    const files = scaffoldAppFiles({
      name: "Inbox Pulse", description: "A pulse of the inbox.", connections: ["Gmail", "slack"],
      tools: [{ name: "Pulse Now", description: "Summarize what is new.", inputSchema: { type: "object", properties: { since: { type: "string" } } } }, { name: "pulse now" }],
      connectionTools: [{ app: "gmail", tools: [{ name: "gmail-find-email", description: "Find email" }, { name: "gmail-send-email" }] }, { app: "other", tools: [{ name: "x" }] }],
    });
    for (const p of Object.keys(appTemplateFiles())) expect(files).toHaveProperty(p);
    const m = JSON.parse(files["manifest.json"]!);
    expect(m).toMatchObject({ manifestVersion: 3, kind: "glyphh-app", name: "Inbox Pulse", slug: "inbox-pulse", description: "A pulse of the inbox.", connectors: ["gmail", "slack"], worker: "worker.js" });
    expect(m.capabilities).toEqual(["db.exec", "connector.status", "connector.tools", "connector.call"]);
    expect(m.tools).toEqual([{ name: "pulse_now", description: "Summarize what is new.", handler: "pulse_now", inputSchema: { type: "object", properties: { since: { type: "string" } } } }]);
    expect(files["worker.js"]).toContain('glyphh.handle("pulse_now", async ({ since }) =>');
    expect(files["worker.js"]).toContain("gmail: gmail-find-email, gmail-send-email");
    expect(files["SKILL.md"]).toMatch(/^---\nname: app-inbox-pulse\n/);
    expect(files["SKILL.md"]).toContain("- `pulse_now` — Summarize what is new.");
    expect(files["CONNECTIONS.md"]).toContain("`gmail-find-email` — Find email");
    expect(files["CONNECTIONS.md"]).toContain("## slack\n\nNo tools read for this account yet");
    expect(files["CONNECTIONS.md"]).not.toContain("other");
    expect(JSON.parse(files["package.json"]!).name).toBe("glyphh-app-inbox-pulse");
    expect(files["app/layout.js"]).toContain('title: "Inbox Pulse"');
    // the starter validates as a project, as the builder will see it
    const v = validateAppProject(files);
    expect(v.errors ?? []).toEqual([]);
  });
  it("a bare name is enough: a slug, a sample tool and no connections", () => {
    const files = scaffoldAppFiles({ name: "Notes!" });
    const m = JSON.parse(files["manifest.json"]!);
    expect(m.slug).toBe("notes");
    expect(m.connectors).toEqual([]);
    expect(m.capabilities).toEqual(["db.exec"]);
    expect(m.tools.map((t: { name: string }) => t.name)).toEqual(["add_note"]);
    expect(files).not.toHaveProperty("CONNECTIONS.md");
    expect(slugOf("_Hidden App")).toBe("hidden-app");
    expect(slugOf("")).toBe("app");
    expect(SCAFFOLD_NEXT[1]).toMatch(/app_install \{ dir/);
  });
});
