/**
 * mcp-client-config — one-click "Configure" for external MCP clients.
 *
 * Writes (merges, never overwrites) our local MCP server into the config
 * file each tool already reads on its own — so Settings → MCP can offer a
 * button instead of a copy-paste snippet. Every writer:
 *   - reads the existing file if present (tolerating a missing/empty file),
 *   - merges in ONLY our "glyphh" entry under that tool's servers key,
 *   - leaves every other entry the user already has untouched,
 *   - creates the parent directory if needed,
 *   - returns the resolved path so the UI can show exactly what changed.
 *
 * Two transport shapes, depending on what each tool's CURRENT stable release
 * is confirmed to support:
 *   - Claude Desktop + Cursor: native remote MCP via a `url` + `headers` entry
 *     (SSE), matching the manual example already shown in this settings page.
 *   - Windsurf + Codex CLI: no confirmed native remote-MCP support as of this
 *     writing, so we route through the community `mcp-remote` stdio↔SSE
 *     bridge (`npx -y mcp-remote <url> --header "Authorization: Bearer …"`) —
 *     the portable option that works regardless of the installed version.
 */

import fs from "fs";
import os from "os";
import path from "path";

export interface McpClientConfigResult {
  ok: boolean;
  configPath?: string;
  error?: string;
}

function readJsonObject(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    throw new Error(`Existing config at ${filePath} isn't valid JSON — fix or remove it, then try again. (${(err as Error).message})`);
  }
}

function writeJsonObject(filePath: string, obj: Record<string, any>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

/** Merge our SSE entry into `<root>[serversKey]`, preserving every other server. */
function mergeSseEntry(filePath: string, serversKey: string, port: number, token: string): McpClientConfigResult {
  const root = readJsonObject(filePath);
  const servers = (root[serversKey] && typeof root[serversKey] === "object") ? root[serversKey] : {};
  servers["glyphh"] = {
    type: "sse",
    url: `http://127.0.0.1:${port}/sse`,
    headers: { Authorization: `Bearer ${token}` },
  };
  root[serversKey] = servers;
  writeJsonObject(filePath, root);
  return { ok: true, configPath: filePath };
}

/** Merge our mcp-remote stdio-bridge entry into `<root>[serversKey]`. */
function mergeStdioBridgeEntry(filePath: string, serversKey: string, port: number, token: string): McpClientConfigResult {
  const root = readJsonObject(filePath);
  const servers = (root[serversKey] && typeof root[serversKey] === "object") ? root[serversKey] : {};
  servers["glyphh"] = {
    command: "npx",
    args: ["-y", "mcp-remote", `http://127.0.0.1:${port}/sse`, "--header", `Authorization: Bearer ${token}`],
  };
  root[serversKey] = servers;
  writeJsonObject(filePath, root);
  return { ok: true, configPath: filePath };
}

function claudeDesktopConfigPath(): string | null {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return null; // Claude Desktop doesn't ship for Linux.
}

export function configureClaudeDesktop(port: number, token: string): McpClientConfigResult {
  const configPath = claudeDesktopConfigPath();
  if (!configPath) return { ok: false, error: "Claude Desktop isn't available on this OS." };
  try {
    return mergeSseEntry(configPath, "mcpServers", port, token);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function configureCursor(port: number, token: string): McpClientConfigResult {
  const configPath = path.join(os.homedir(), ".cursor", "mcp.json");
  try {
    return mergeSseEntry(configPath, "mcpServers", port, token);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function configureWindsurf(port: number, token: string): McpClientConfigResult {
  const configPath = path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json");
  try {
    return mergeStdioBridgeEntry(configPath, "mcpServers", port, token);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Codex CLI's config is TOML — patch just the `[mcp_servers.glyphh]` table by
 *  text, leaving every other line (including other tables) untouched, rather
 *  than pulling in a full TOML parser/serializer for one small table. */
export function configureCodexCli(port: number, token: string): McpClientConfigResult {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";

    const ourTable = [
      "[mcp_servers.glyphh]",
      `command = "npx"`,
      `args = ["-y", "mcp-remote", "http://127.0.0.1:${port}/sse", "--header", "Authorization: Bearer ${token}"]`,
      "",
    ].join("\n");

    // Replace an existing [mcp_servers.glyphh] table (up to the next top-level
    // "[" header or EOF) if present; otherwise append ours at the end.
    const tableRe = /^\[mcp_servers\.glyphh\]\r?\n(?:(?!^\[)[^\n]*\r?\n?)*/m;
    const next = tableRe.test(existing)
      ? existing.replace(tableRe, ourTable)
      : (existing.trimEnd() + (existing.trim() ? "\n\n" : "") + ourTable);

    fs.writeFileSync(configPath, next.trimEnd() + "\n", "utf-8");
    return { ok: true, configPath };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
