import { ipcMain } from "electron";
import path from "path";
import { pathToFileURL } from "url";
import type { SkillEngine } from "./skill-engine";
import type { McpManager } from "./mcp-manager";
import type { AppConnector } from "./app-connector";
import type { SkillScheduler } from "./skill-scheduler";

interface SkillsIpcDeps {
  skillEngine: SkillEngine;
  mcpManager: McpManager | null;
  appConnector: AppConnector | null;
  skillScheduler: SkillScheduler | null;
  canCreateSkill: (count: number) => { allowed: boolean; reason?: string };
  listBuiltinYoTools: () => Array<{ name: string; description: string }>;
  /** Open a path (skill folder or its SKILL.md) in the editor — supplied by main. */
  openSkillPath?: (absPath: string) => void;
}

export function registerSkillsIpc(deps: SkillsIpcDeps): void {
  const {
    skillEngine,
    mcpManager,
    appConnector,
    skillScheduler,
    listBuiltinYoTools,
    openSkillPath,
  } = deps;

  // Skills are authored only by the assistant (server-side, via the
  // skill-builder system skill). The client is view/run-only — every authoring
  // IPC returns this so the renderer surfaces a message instead of silently
  // writing to a cache that never reaches the server.
  const AUTHORING_DISABLED = "Skills are created by the assistant and can't be edited here.";

  // IPC: skills read surface (server is the source of truth — refresh the local
  // execution cache from /api/skills/tools before every list/get).
  ipcMain.handle("skills-list", async () => {
    await skillEngine.refreshFromServer();
    return skillEngine.listSkills();
  });
  ipcMain.handle("skills-list-detailed", async () => {
    await skillEngine.refreshFromServer();
    return skillEngine.listSkillsDetailed();
  });
  ipcMain.handle("mcp-tools-list", () => (mcpManager?.getAllTools() ?? []).map((t) => ({
    serverId: t.serverId,
    serverName: t.serverName,
    name: t.name,
    qualifiedName: t.qualifiedName,
    description: t.description,
  })));
  ipcMain.handle("skills-read", (_e, name: string) => skillEngine.readSkill(name));
  ipcMain.handle("skills-get", async (_e, name: string) => {
    await skillEngine.refreshFromServer();
    const s = skillEngine.getSkill(name);
    if (!s) return null;
    const hasRunner = skillEngine.hasRunner(name);
    const hasApp = !!skillEngine.readSkillFile(name, "app/index.html");
    const runnerCode = hasRunner ? skillEngine.readSkillFile(name, "SKILL.js") : null;
    const runnerSchedule = skillEngine.getSkillJsSchedule(name);
    return {
      name: s.name,
      manifest: s.manifest,
      prompt: s.prompt,
      hasRunner,
      hasApp,
      runnerCode,
      runnerSchedule,
    };
  });
  // Authoring is disabled in the client — the assistant owns skill creation.
  ipcMain.handle("skills-write", () => ({ error: AUTHORING_DISABLED }));
  ipcMain.handle("skills-write-full", () => ({ error: AUTHORING_DISABLED }));
  ipcMain.handle("skills-remove", () => ({ error: AUTHORING_DISABLED }));
  ipcMain.handle("skills-generate", () => "");
  ipcMain.handle("skills-available-tools", () => {
    const groups: Array<{ namespace: string; label: string; tools: Array<{ name: string; description: string }> }> = [];
    const yoTools = listBuiltinYoTools();
    if (yoTools.length) {
      groups.push({ namespace: "yo", label: "yo (built-in)", tools: yoTools.map(t => ({ name: t.name, description: t.description })) });
    }
    if (mcpManager) {
      const byApp = new Map<string, { label: string; tools: Array<{ name: string; description: string }> }>();
      for (const t of mcpManager.getAllTools()) {
        const appId = t.serverId;
        const app = appConnector?.get(appId);
        const label = app?.name || appId;
        if (!byApp.has(appId)) byApp.set(appId, { label, tools: [] });
        byApp.get(appId)!.tools.push({ name: t.name, description: t.description });
      }
      for (const [appId, group] of byApp) {
        groups.push({ namespace: appId, label: group.label, tools: group.tools });
      }
    }
    return groups;
  });
  // File operations within a skill folder
  ipcMain.handle("skills-list-files", (_e, name: string) => skillEngine.listSkillFiles(name));
  ipcMain.handle("skills-read-file", (_e, name: string, rel: string) => skillEngine.readSkillFile(name, rel));
  ipcMain.handle("skills-write-file", () => ({ error: AUTHORING_DISABLED }));
  ipcMain.handle("skills-delete-file", () => ({ error: AUTHORING_DISABLED }));
  // Open a skill's SKILL.md via the shared file-open path (OS default app).
  ipcMain.handle("skills-open-in-editor", (_e, name: string) => {
    const safe = (name || "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
    if (!safe) return false;
    const folder = path.join(skillEngine.getSkillsDir(), safe);
    // Prefer opening SKILL.md so the editor lands on something concrete; the
    // open router treats the folder's file the same way as any file link.
    const target = path.join(folder, "SKILL.md");
    openSkillPath?.(target);
    return true;
  });
  // Resolve a file:// URL for a skill file (media preview: audio/video/images).
  ipcMain.handle("skills-file-url", (_e, name: string, rel: string) => {
    const safe = (name || "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
    const safeRel = (rel || "").replace(/\.\.(\/|\\|$)/g, "").replace(/^[/\\]+/, "");
    if (!safe || !safeRel) return "";
    return pathToFileURL(path.join(skillEngine.getSkillsDir(), safe, safeRel)).href;
  });
  // Open a specific file within a skill's folder via the OS default app.
  ipcMain.handle("skills-open-file-in-editor", (_e, name: string, rel: string) => {
    const safe = (name || "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
    const safeRel = (rel || "").replace(/\.\.(\/|\\|$)/g, "").replace(/^[/\\]+/, "");
    if (!safe || !safeRel) return false;
    openSkillPath?.(path.join(skillEngine.getSkillsDir(), safe, safeRel));
    return true;
  });
  // Run a skill (LLM call with skill's prompt)
  ipcMain.handle("skills-run", async (_e, name: string, input: unknown) => {
    try {
      // runSkill() dispatches to the JS runner if SKILL.js exists, else falls
      // back to prompt-mode (process()) — same code path the scheduler uses.
      const output = await skillEngine.runSkill(name, input, { trigger: "manual" });
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("skills-run-history", (_e, name: string) => skillEngine.getRunHistory(name));
  // Export/import .yo bundles
  ipcMain.handle("skills-export", (_e, name: string) => {
    const buf = skillEngine.exportSkill(name);
    return buf ? buf.toString("base64") : null;
  });
  ipcMain.handle("skills-import", () => ({ imported: [], skipped: [], error: AUTHORING_DISABLED }));
  // Scheduler
  ipcMain.handle("skills-schedule-status", () => skillScheduler?.status() ?? []);
  ipcMain.handle("skills-pause-schedule", (_e, name: string) => { skillScheduler?.pause(name); });
  ipcMain.handle("skills-resume-schedule", (_e, name: string) => { skillScheduler?.resume(name); });
}
