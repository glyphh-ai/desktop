/**
 * MCP Client — connects to Model Context Protocol servers via stdio or SSE.
 *
 * Implements the MCP JSON-RPC 2.0 protocol for:
 *   - initialize / initialized handshake
 *   - tools/list (discover available tools)
 *   - tools/call (execute a tool)
 */

import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpClientOptions {
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** OAuth2 client-credentials for an authenticated streamable-http server.
   *  A bearer token is minted from `tokenUrl` and refreshed before expiry. */
  oauth?: { clientId: string; clientSecret: string; tokenUrl: string; scope?: string };
}

export class McpClient extends EventEmitter {
  private options: McpClientOptions;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private connected = false;

  private process: ChildProcess | null = null;
  private stdioBuffer = "";

  private sseAbort: AbortController | null = null;
  private sseMessageEndpoint: string | null = null;

  private httpSessionId: string | null = null;

  // OAuth2 client-credentials token cache (streamable-http only).
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  /** Mint/refresh the bearer token and return the auth header, or {} when no
   *  OAuth is configured. The token is reused until ~60s before it expires. */
  private async authHeader(): Promise<Record<string, string>> {
    const oauth = this.options.oauth;
    if (!oauth?.clientId || !oauth?.clientSecret || !oauth?.tokenUrl) return {};
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return { Authorization: `Bearer ${this.accessToken}` };
    }
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
    });
    if (oauth.scope) body.set("scope", oauth.scope);
    const res = await fetch(oauth.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`OAuth token request failed: ${res.status} ${err.slice(0, 200)}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000;
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  constructor(options: McpClientOptions) {
    super();
    this.options = options;
  }

  isConnected(): boolean { return this.connected; }

  async connect(): Promise<void> {
    if (this.options.transport === "stdio") {
      await this.connectStdio();
    } else if (this.options.transport === "streamable-http") {
      // No persistent connection needed — just mark as ready
    } else {
      await this.connectSse();
    }
    this.connected = true;
    await this.initialize();
    this.sendNotification("notifications/initialized");
  }

  private async connectStdio(): Promise<void> {
    const { command, args = [], env } = this.options;
    if (!command) throw new Error("stdio transport requires a command");

    const mergedEnv = { ...process.env, ...env };

    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: mergedEnv,
      cwd: require("os").homedir(),
      shell: process.platform === "win32",
    });

    this.process.stdout!.on("data", (chunk: Buffer) => {
      this.stdioBuffer += chunk.toString("utf-8");
      this.processStdioBuffer();
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      this.emit("log", `stderr: ${chunk.toString("utf-8").trim()}`);
    });

    this.process.on("exit", (code) => {
      this.connected = false;
      this.rejectAllPending(new Error(`MCP server exited with code ${code}`));
      this.emit("disconnected", code);
    });

    this.process.on("error", (err) => {
      this.connected = false;
      this.rejectAllPending(err);
      this.emit("error", err);
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 500);
      this.process!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private processStdioBuffer(): void {
    const lines = this.stdioBuffer.split("\n");
    this.stdioBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this.handleMessage(msg);
      } catch { /* skip non-JSON */ }
    }
  }

  private async connectSse(): Promise<void> {
    const { url } = this.options;
    if (!url) throw new Error("SSE transport requires a url");

    this.sseAbort = new AbortController();

    const response = await fetch(url, {
      headers: { Accept: "text/event-stream", ...this.options.headers },
      signal: this.sseAbort.signal,
    });

    if (!response.ok) throw new Error(`SSE connection failed: ${response.status}`);

    const endpoint = response.headers.get("x-mcp-endpoint");
    if (endpoint) {
      this.sseMessageEndpoint = new URL(endpoint, url).toString();
    } else {
      const base = new URL(url);
      base.pathname = base.pathname.replace(/\/sse\/?$/, "/message");
      this.sseMessageEndpoint = base.toString();
    }

    this.processSseStream(response).catch((err) => {
      if (err.name !== "AbortError") {
        this.connected = false;
        this.emit("error", err);
        this.emit("disconnected", -1);
      }
    });
  }

  private async processSseStream(response: Response): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            const msg = JSON.parse(data);
            this.handleMessage(msg);
          } catch { /* skip */ }
        }
        if (line.startsWith("event: endpoint")) {
          const idx = lines.indexOf(line);
          if (idx >= 0 && idx + 1 < lines.length) {
            const endpointData = lines[idx + 1];
            if (endpointData.startsWith("data: ")) {
              const ep = endpointData.slice(6).trim();
              if (ep) this.sseMessageEndpoint = new URL(ep, this.options.url).toString();
            }
          }
        }
      }
    }
  }

  private handleMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
    if ("id" in msg && msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        const resp = msg as JsonRpcResponse;
        if (resp.error) {
          pending.reject(new Error(`MCP error ${resp.error.code}: ${resp.error.message}`));
        } else {
          pending.resolve(resp.result);
        }
      }
    } else {
      this.emit("notification", msg);
    }
  }

  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };

    if (this.options.transport === "streamable-http") {
      return this.sendHttpRequest(request);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, 30000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this.send(request);
    });
  }

  private async sendHttpRequest(request: JsonRpcRequest): Promise<unknown> {
    const { url } = this.options;
    if (!url) throw new Error("streamable-http transport requires a url");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.options.headers,
      ...(await this.authHeader()),
    };
    if (this.httpSessionId) {
      headers["Mcp-Session-Id"] = this.httpSessionId;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error(`[mcp-client] HTTP ${response.status}: ${errBody.slice(0, 500)}`);
      throw new Error(`HTTP request failed: ${response.status}`);
    }

    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.httpSessionId = sessionId;

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("text/event-stream")) {
      return this.readSseResponse(response, request.id);
    }

    const text = await response.text();
    if (!text.trim()) return undefined;

    const msg = JSON.parse(text) as JsonRpcResponse;
    if (msg.error) {
      throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
    }
    return msg.result;
  }

  private async readSseResponse(response: Response, requestId: number): Promise<unknown> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data) continue;
        try {
          const msg = JSON.parse(data) as JsonRpcResponse;
          if ("id" in msg && msg.id === requestId) {
            reader.cancel().catch(() => {});
            if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
            return msg.result;
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("MCP error")) throw e;
        }
      }
    }
    return undefined;
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
    this.send(notification);
  }

  private send(msg: JsonRpcRequest | JsonRpcNotification): void {
    const json = JSON.stringify(msg);

    if (this.options.transport === "stdio") {
      if (!this.process?.stdin?.writable) throw new Error("stdio not writable");
      this.process.stdin.write(json + "\n");
    } else if (this.options.transport === "streamable-http") {
      void this.authHeader().then((auth) => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...this.options.headers,
          ...auth,
        };
        if (this.httpSessionId) headers["Mcp-Session-Id"] = this.httpSessionId;
        return fetch(this.options.url!, { method: "POST", headers, body: json });
      }).catch((err) => this.emit("error", err));
    } else {
      if (!this.sseMessageEndpoint) throw new Error("SSE endpoint not established");
      fetch(this.sseMessageEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.options.headers },
        body: json,
      }).catch((err) => this.emit("error", err));
    }
  }

  private async initialize(): Promise<void> {
    const version = this.options.transport === "streamable-http" ? "2025-03-26" : "2024-11-05";
    await this.sendRequest("initialize", {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: "glyphh", version: "2.0.0" },
    });
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.sendRequest("tools/list") as { tools: McpTool[] };
    return result.tools || [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    return result as McpToolResult;
  }

  async disconnect(): Promise<void> {
    this.connected = false;

    if (this.options.transport === "stdio" && this.process) {
      this.process.kill();
      this.process = null;
    }

    if (this.options.transport === "sse" && this.sseAbort) {
      this.sseAbort.abort();
      this.sseAbort = null;
    }

    this.httpSessionId = null;

    this.rejectAllPending(new Error("Client disconnected"));
    this.stdioBuffer = "";
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      p.reject(err);
      this.pending.delete(id);
    }
  }
}
