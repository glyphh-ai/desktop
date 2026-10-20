/**
 * commands/connections.ts — connectors: list, install/remove a custom MCP server,
 * and get a Pipedream connect-link.
 */

import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";

export function registerConnections(reg: CommandRegistry): void {
  reg.register({
    path: "connections list",
    summary: "list the org's connections",
    covers: ["connections.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.connections.list());
    },
  });

  reg.register({
    path: "connections apps",
    summary: "search the connector catalog for connectable apps",
    usage: "connections apps [--search <query>] [--limit <n>]",
    covers: ["connections.apps"],
    async run(ctx, args) {
      const search = flagStr(args, "search");
      const limitRaw = flagStr(args, "limit");
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
      ctx.printJson(await ctx.client.connections.apps({
        ...(search ? { search } : {}),
        ...(limit != null && Number.isFinite(limit) ? { limit } : {}),
      }));
    },
  });

  reg.register({
    path: "connections mcp add",
    summary: "install a custom MCP server (org_admin)",
    usage: "connections mcp add <slug> --name <name> --url <url> [--header 'K: V' ...]",
    covers: ["connections.installCustomMcp"],
    async run(ctx, args) {
      const slug = args.positional[0];
      const name = flagStr(args, "name");
      const url = flagStr(args, "url");
      if (!slug || !name || !url) throw new Error("usage: connections mcp add <slug> --name <name> --url <url>");
      // --header may repeat via comma: "K1: V1,K2: V2"
      const headerFlag = flagStr(args, "header");
      const headers: Record<string, string> = {};
      if (headerFlag) {
        for (const pair of headerFlag.split(",")) {
          const idx = pair.indexOf(":");
          if (idx !== -1) headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
        }
      }
      ctx.printJson(await ctx.client.connections.installCustomMcp({ slug, name, url, ...(Object.keys(headers).length ? { headers } : {}) }));
    },
  });

  reg.register({
    path: "connections mcp remove",
    summary: "remove a custom MCP server",
    usage: "connections mcp remove <slug>",
    covers: ["connections.removeCustomMcp"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: connections mcp remove <slug>");
      await ctx.client.connections.removeCustomMcp(slug);
      ctx.print("removed ✓");
    },
  });

  reg.register({
    path: "connections pipedream",
    summary: "get a Pipedream connect-link (prints the URL)",
    covers: ["connections.pipedreamConnectLink"],
    async run(ctx) {
      ctx.print((await ctx.client.connections.pipedreamConnectLink()).url);
    },
  });

  reg.register({
    path: "connections apptools",
    summary: "list a connector app's tools",
    usage: "connections apptools <slug>",
    covers: ["connections.appTools"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: connections apptools <slug>");
      ctx.printJson(await ctx.client.connections.appTools(slug));
    },
  });

  reg.register({
    path: "connections mcp-tools",
    summary: "an org custom-MCP connection's advertised tools (org_admin)",
    usage: "connections mcp-tools <slug>",
    covers: ["connections.mcpTools"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: connections mcp-tools <slug>");
      ctx.printJson(await ctx.client.connections.mcpTools(slug));
    },
  });

  reg.register({
    path: "connections tools",
    summary: "the caller's resolved per-connection granted tools",
    covers: ["connections.resolvedTools"],
    async run(ctx) {
      ctx.printJson(await ctx.client.connections.resolvedTools());
    },
  });

  reg.register({
    path: "connections mcp-oauth",
    summary: "start OAuth for a custom-MCP connection (prints the authorize URL)",
    usage: "connections mcp-oauth <slug>",
    covers: ["connections.startMcpOAuth"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: connections mcp-oauth <slug>");
      ctx.print((await ctx.client.connections.startMcpOAuth(slug)).authorizeUrl);
    },
  });

  reg.register({
    path: "connections org-tools",
    summary: "the org-level allowed-tool caps per connection { slug: tools[] }",
    covers: ["connections.orgConnectionTools"],
    async run(ctx) {
      ctx.printJson(await ctx.client.connections.orgConnectionTools());
    },
  });

  reg.register({
    path: "connections set-org-tools",
    summary: "set a connection's org-level allowed tools — the org cap (org_admin)",
    usage: "connections set-org-tools <slug> [tool...]",
    covers: ["connections.setOrgConnectionTools"],
    async run(ctx, args) {
      const [slug, ...tools] = args.positional;
      if (!slug) throw new Error("usage: connections set-org-tools <slug> [tool...]");
      ctx.printJson(await ctx.client.connections.setOrgConnectionTools(slug, tools));
    },
  });

  reg.register({
    path: "connections rename",
    summary: "rename an org Pipedream connection — set its label (org_admin)",
    usage: "connections rename <id> <label...>",
    covers: ["connections.renameOrgConnection"],
    async run(ctx, args) {
      const [id, ...rest] = args.positional;
      const label = rest.join(" ");
      if (!id || !label) throw new Error("usage: connections rename <id> <label...>");
      ctx.printJson(await ctx.client.connections.renameOrgConnection(id, label));
    },
  });

  // ── org custom-MCP catalog (Settings → MCP) ──────────────────────────────────
  reg.register({
    path: "connections org-mcp list",
    summary: "list the org's published custom-MCP connections (rich)",
    covers: ["connections.orgMcpList"],
    async run(ctx) {
      ctx.printJson(await ctx.client.connections.orgMcpList());
    },
  });

  reg.register({
    path: "connections org-mcp add",
    summary: "publish a custom-MCP connection (org_admin)",
    usage: "connections org-mcp add <slug> --name <name> --url <url> [--header 'K: V,K2: V2']",
    covers: ["connections.orgMcpCreate"],
    async run(ctx, args) {
      const slug = args.positional[0];
      const name = flagStr(args, "name");
      const url = flagStr(args, "url");
      if (!slug || !name || !url) throw new Error("usage: connections org-mcp add <slug> --name <name> --url <url>");
      const headers = parseHeaderFlag(flagStr(args, "header"));
      ctx.printJson(await ctx.client.connections.orgMcpCreate({ slug, name, url, ...(headers ? { headers } : {}) }));
    },
  });

  reg.register({
    path: "connections org-mcp update",
    summary: "edit a custom-MCP connection (org_admin)",
    usage: "connections org-mcp update <slug> [--name <n>] [--url <u>] [--header 'K: V'] [--enabled true|false]",
    covers: ["connections.orgMcpUpdate"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: connections org-mcp update <slug> [--name <n>] [--url <u>] [--header 'K: V'] [--enabled true|false]");
      const patch: { name?: string; url?: string; headers?: Record<string, string>; enabled?: boolean } = {};
      const name = flagStr(args, "name");
      const url = flagStr(args, "url");
      const headers = parseHeaderFlag(flagStr(args, "header"));
      const enabled = flagStr(args, "enabled");
      if (name !== undefined) patch.name = name;
      if (url !== undefined) patch.url = url;
      if (headers) patch.headers = headers;
      if (enabled !== undefined) patch.enabled = enabled === "true";
      ctx.printJson(await ctx.client.connections.orgMcpUpdate(slug, patch));
    },
  });

  reg.register({
    path: "connections org-mcp remove",
    summary: "delete a custom-MCP connection (org_admin)",
    usage: "connections org-mcp remove <slug>",
    covers: ["connections.orgMcpRemove"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: connections org-mcp remove <slug>");
      ctx.printJson(await ctx.client.connections.orgMcpRemove(slug));
    },
  });

  reg.register({
    path: "connections org-mcp icon",
    summary: "set a custom-MCP connection's logo (data URL)",
    usage: "connections org-mcp icon <slug> --dataUrl <data:...>",
    covers: ["connections.orgMcpSetIcon"],
    async run(ctx, args) {
      const slug = args.positional[0];
      const dataUrl = flagStr(args, "dataUrl");
      if (!slug || !dataUrl) throw new Error("usage: connections org-mcp icon <slug> --dataUrl <data:...>");
      ctx.printJson(await ctx.client.connections.orgMcpSetIcon(slug, dataUrl));
    },
  });

  // ── org-shared Pipedream connections (Configure → Connections) ───────────────
  reg.register({
    path: "connections org list",
    summary: "list the org's shared Pipedream connections (rich cards)",
    covers: ["connections.pipedreamList"],
    async run(ctx) {
      ctx.printJson(await ctx.client.connections.pipedreamList());
    },
  });

  reg.register({
    path: "connections org connect",
    summary: "start an org-level OAuth for an app (prints the URL)",
    usage: "connections org connect <appSlug>",
    covers: ["connections.pipedreamConnect"],
    async run(ctx, args) {
      const appSlug = args.positional[0];
      if (!appSlug) throw new Error("usage: connections org connect <appSlug>");
      ctx.print((await ctx.client.connections.pipedreamConnect(appSlug)).connectUrl);
    },
  });

  reg.register({
    path: "connections org disconnect",
    summary: "disconnect an org Pipedream connection by id (audited)",
    usage: "connections org disconnect <id>",
    covers: ["connections.pipedreamDisconnect"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: connections org disconnect <id>");
      ctx.printJson(await ctx.client.connections.pipedreamDisconnect(id));
    },
  });

  // ── personal (member-made) connections — the caller's OWN Pipedream auth ──────
  reg.register({
    path: "connections personal list",
    summary: "list the caller's own personal connections",
    covers: ["connections.personalList"],
    async run(ctx) {
      ctx.printJson(await ctx.client.connections.personalList());
    },
  });

  reg.register({
    path: "connections personal connect",
    summary: "start a personal OAuth for an app (prints the URL; workspace-governed)",
    usage: "connections personal connect <appSlug>",
    covers: ["connections.personalConnect"],
    async run(ctx, args) {
      const appSlug = args.positional[0];
      if (!appSlug) throw new Error("usage: connections personal connect <appSlug>");
      ctx.print((await ctx.client.connections.personalConnect(appSlug)).connectUrl);
    },
  });

  reg.register({
    path: "connections personal rename",
    summary: "label one of your own connections",
    usage: "connections personal rename <id> <label...>",
    covers: ["connections.renamePersonalConnection"],
    async run(ctx, args) {
      const [id, ...rest] = args.positional;
      const label = rest.join(" ");
      if (!id || !label) throw new Error("usage: connections personal rename <id> <label...>");
      ctx.printJson(await ctx.client.connections.renamePersonalConnection(id, label));
    },
  });

  reg.register({
    path: "connections personal disconnect",
    summary: "disconnect one of the caller's own personal connections by id",
    usage: "connections personal disconnect <id>",
    covers: ["connections.personalDisconnect"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: connections personal disconnect <id>");
      ctx.printJson(await ctx.client.connections.personalDisconnect(id));
    },
  });

  reg.register({
    path: "connections personal mcp list",
    summary: "list the caller's own custom-MCP endpoints",
    covers: ["connections.personalMcpList"],
    async run(ctx) {
      ctx.printJson(await ctx.client.connections.personalMcpList());
    },
  });

  reg.register({
    path: "connections personal mcp add",
    summary: "register your own custom-MCP endpoint (workspace must allow it)",
    usage: "connections personal mcp add <slug> --name <name> --url <url> [--header 'K: V,K2: V2']",
    covers: ["connections.personalMcpCreate"],
    async run(ctx, args) {
      const slug = args.positional[0];
      const name = flagStr(args, "name");
      const url = flagStr(args, "url");
      if (!slug || !name || !url) throw new Error("usage: connections personal mcp add <slug> --name <name> --url <url>");
      const headers = parseHeaderFlag(flagStr(args, "header"));
      ctx.printJson(await ctx.client.connections.personalMcpCreate({ slug, name, url, ...(headers ? { headers } : {}) }));
    },
  });

  reg.register({
    path: "connections personal mcp update",
    summary: "edit one of your own custom-MCP endpoints",
    usage: "connections personal mcp update <slug> [--name <n>] [--url <u>] [--header 'K: V'] [--enabled true|false]",
    covers: ["connections.personalMcpUpdate"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: connections personal mcp update <slug> [--name <n>] [--url <u>]");
      const patch: { name?: string; url?: string; headers?: Record<string, string>; enabled?: boolean } = {};
      const name = flagStr(args, "name");
      const url = flagStr(args, "url");
      const headers = parseHeaderFlag(flagStr(args, "header"));
      const enabled = flagStr(args, "enabled");
      if (name !== undefined) patch.name = name;
      if (url !== undefined) patch.url = url;
      if (headers) patch.headers = headers;
      if (enabled !== undefined) patch.enabled = enabled === "true";
      ctx.printJson(await ctx.client.connections.personalMcpUpdate(slug, patch));
    },
  });

  reg.register({
    path: "connections personal mcp remove",
    summary: "delete one of your own custom-MCP endpoints",
    usage: "connections personal mcp remove <slug>",
    covers: ["connections.personalMcpRemove"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: connections personal mcp remove <slug>");
      ctx.printJson(await ctx.client.connections.personalMcpRemove(slug));
    },
  });

  reg.register({
    path: "connections personal tools",
    summary: "your OWN per-connection tool caps { slug: tools[] }",
    covers: ["connections.personalConnectionTools"],
    async run(ctx) {
      ctx.printJson(await ctx.client.connections.personalConnectionTools());
    },
  });

  reg.register({
    path: "connections personal set-tools",
    summary: "narrow which of a connection's tools YOUR agents may call",
    usage: "connections personal set-tools <slug> [tool...]",
    covers: ["connections.setPersonalConnectionTools"],
    async run(ctx, args) {
      const [slug, ...tools] = args.positional;
      if (!slug) throw new Error("usage: connections personal set-tools <slug> [tool...]");
      ctx.printJson(await ctx.client.connections.setPersonalConnectionTools(slug, tools));
    },
  });

  reg.register({
    path: "connections run",
    summary: "run a governed connection tool (scope-derived external id)",
    usage: "connections run <slug> <tool> [props-json]",
    covers: ["connections.runTool"],
    async run(ctx, args) {
      const [slug, tool, propsRaw] = args.positional;
      if (!slug || !tool) throw new Error("usage: connections run <slug> <tool> [props-json]");
      let props;
      if (propsRaw) {
        try { props = JSON.parse(propsRaw); }
        catch { throw new Error("props must be a JSON object, e.g. '{\"text\":\"hi\"}'"); }
      }
      ctx.printJson(await ctx.client.connections.runTool({ slug, tool, ...(props ? { props } : {}) }));
    },
  });

  reg.register({
    path: "connections fetch-file",
    summary: "fetch a file's bytes from a connected account (Connect proxy) to a local path",
    usage: "connections fetch-file <slug> <provider-url> <out-path>",
    covers: ["connections.fetchFile"],
    async run(ctx, args) {
      const [slug, url, outPath] = args.positional;
      if (!slug || !url || !outPath) throw new Error("usage: connections fetch-file <slug> <provider-url> <out-path>");
      const out = await ctx.client.connections.fetchFile({ slug, url });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(outPath, Buffer.from(out.dataBase64, "base64"));
      ctx.printJson({ saved: outPath, bytes: out.bytes, contentType: out.contentType });
    },
  });

  reg.register({
    path: "connections proxy-send",
    summary: "push bytes to a connected provider's API (uploads, sends with attachments)",
    usage: "connections proxy-send <slug> <provider-url> <body-file> [content-type]",
    covers: ["connections.proxySend"],
    async run(ctx, args) {
      const [slug, url, bodyFile, contentType] = args.positional;
      if (!slug || !url || !bodyFile) throw new Error("usage: connections proxy-send <slug> <provider-url> <body-file> [content-type]");
      const { readFileSync } = await import("node:fs");
      const bodyBase64 = readFileSync(bodyFile).toString("base64");
      const out = await ctx.client.connections.proxySend({ slug, url, bodyBase64, ...(contentType ? { contentType } : {}) });
      ctx.printJson({ status: out.status, contentType: out.contentType, body: Buffer.from(out.dataBase64, "base64").toString("utf8").slice(0, 2000) });
    },
  });
}

/** Parse a repeated `--header 'K: V,K2: V2'` flag into a header map (or undefined). */
function parseHeaderFlag(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf(":");
    if (idx !== -1) headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return Object.keys(headers).length ? headers : undefined;
}
