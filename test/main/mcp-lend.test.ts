/**
 * mcp-lend.test.ts — who answers which tool name when the desktop's loop lends
 * its local MCP beside the gateway's /mcp (his order, 2026-10-04: the local
 * server wins the window tools, the gateway the rest).
 */
import { describe, expect, it, vi } from "vitest";
import { CLOUD_TOOLS, LOOP_HIDDEN, MACHINE_TOOLS, WINDOW_TOOLS, lendSplit } from "../../src/main/mcp-lend.js";

vi.mock("electron", () => ({ BrowserWindow: class {}, dialog: {}, ipcMain: { handle: () => undefined } }));
vi.mock("../../src/main/relay-client.js", () => ({ dispatchRelayMethod: async () => undefined }));
vi.mock("../../src/main/attach-handlers.js", () => ({ gitStateOf: () => ({ isRepo: false }) }));
vi.mock("../../src/main/broadcast.js", () => ({ broadcast: () => undefined }));
vi.mock("../../src/main/stores/preferences-db.js", () => ({ getPreference: () => undefined, loadPreferences: async () => undefined, setPreference: () => undefined }));

const BELT = new Set(["panels_open", "panels_list", "panels_close", "panels_available", "rpa_read", "rpa_screenshot", "settings_open", "skill_get"]);

describe("lendSplit", () => {
  it("gives the windows to the local server and the library, clock and apps to the gateway", () => {
    const s = lendSplit({ localUp: true, gatewayUp: true, connections: true, belt: BELT });
    for (const t of ["panels_open", "panels_list", "panels_switch", "panels_close", "layouts_open", "settings_open"]) {
      expect(s.local(t), t).toBe(true);
      expect(s.gateway(t), t).toBe(false);
    }
    for (const t of ["skills_list", "skill_save", "tasks_list", "task_runs", "schedules_list", "schedule_save", "agents_list", "app_releases", "app_pin"]) {
      expect(s.local(t), t).toBe(false);
      expect(s.gateway(t), t).toBe(true);
    }
    // A RUN HAPPENS WHERE THE RPA LIVES (his order, 2026-10-07): with the
    // desktop up, task_run and skill_run run on this machine, with its tools.
    for (const t of ["task_run", "skill_run"]) {
      expect(s.local(t), t).toBe(true);
      expect(s.gateway(t), t).toBe(false);
      expect(MACHINE_TOOLS.has(t), t).toBe(true);
      expect(CLOUD_TOOLS.has(t), t).toBe(false);
    }
    // app_install { dir } zips or tars THIS machine's folder: the local server
    // answers it (and the job it starts); the gateway's base64 copies are not
    // lent beside it — app_deploy is hidden from the loop outright (2026-10-07).
    expect(s.local("app_install")).toBe(true);
    expect(s.gateway("app_install")).toBe(false);
    expect(s.local("app_build_status")).toBe(true);
    expect(s.local("glyphh_app_scaffold")).toBe(true);
    expect(MACHINE_TOOLS.has("app_install")).toBe(true);
    expect(s.local("app_deploy")).toBe(false);
    // RPA ON A TAB (2026-10-07): the picker and the mapped runs act on THIS
    // screen's panels — local only, never the gateway.
    for (const t of ["rpa_commands", "rpa_pick", "rpa_map", "rpa_unmap", "rpa_run", "rpa_sequence_save", "rpa_sequence_remove", "rpa_sequence_run"]) {
      expect(s.local(t), t).toBe(true);
      expect(s.gateway(t), t).toBe(false);
    }
    // One name, one server: nothing the loop may see is lent twice or by nobody.
    for (const t of [...WINDOW_TOOLS, ...MACHINE_TOOLS, ...CLOUD_TOOLS].filter((n) => !LOOP_HIDDEN.has(n))) expect([s.local(t), s.gateway(t)], t).toContain(true);
    for (const t of [...WINDOW_TOOLS, ...MACHINE_TOOLS, ...CLOUD_TOOLS]) expect(s.local(t) && s.gateway(t), t).toBe(false);
  });

  it("keeps a belt tool local even when the gateway carries it", () => {
    const s = lendSplit({ localUp: true, gatewayUp: true, connections: true, belt: BELT });
    expect(s.local("skill_get")).toBe(true);
    expect(s.gateway("skill_get")).toBe(false);
  });

  it("lets the gateway answer everything when the local server is down", () => {
    const s = lendSplit({ localUp: false, gatewayUp: true, connections: true, belt: BELT });
    expect(s.gateway("panels_open")).toBe(true);
    expect(s.gateway("app_install")).toBe(true);
    expect(s.gateway("skill_get")).toBe(true);
    expect(s.gateway("skills_list")).toBe(true);
    // No desktop: the gateway's copies run a task or a skill in the cloud.
    expect(s.gateway("task_run")).toBe(true);
    expect(s.gateway("skill_run")).toBe(true);
  });

  it("keeps the library local when no gateway is lent", () => {
    const s = lendSplit({ localUp: true, gatewayUp: false, connections: true, belt: BELT });
    expect(s.local("skills_list")).toBe(true);
    expect(s.local("task_run")).toBe(true);
  });

  it("drops both halves of the connections lane when the org has it off", () => {
    const on = lendSplit({ localUp: true, gatewayUp: true, connections: true, belt: BELT });
    const off = lendSplit({ localUp: true, gatewayUp: true, connections: false, belt: BELT });
    expect(on.gateway("mcp_tool_search")).toBe(true);
    expect(on.gateway("glyphh_connections")).toBe(true);
    expect(off.gateway("mcp_tool_search")).toBe(false);
    expect(off.gateway("mcp_tool_call")).toBe(false);
    expect(off.gateway("glyphh_connect")).toBe(false);
    expect(off.local("connector_call")).toBe(false);
    // The library still rides the gateway with the lane off.
    expect(off.gateway("skills_list")).toBe(true);
  });

  it("never lends the loop the diagnostics or the list/call pairs the catalog stands in for", () => {
    const s = lendSplit({ localUp: true, gatewayUp: true, connections: true, belt: BELT });
    for (const t of ["relay_ping", "app_list_tools", "app_call_tool", "connector_tools", "connections_list_tools"]) expect(s.local(t), t).toBe(false);
    expect(s.gateway("relay_ping")).toBe(false);
  });
});

