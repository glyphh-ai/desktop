/**
 * commands/api.ts — raw authenticated requests against the control plane, the CLI
 * face of the `client.http` escape hatch. For endpoints no typed command covers
 * yet; the response prints as JSON verbatim.
 */

import type { CommandRegistry } from "../registry.js";
import type { CliContext } from "../context.js";
import type { CliArgs } from "../args.js";

const METHODS = ["get", "post", "patch", "put", "del"] as const;
type Method = (typeof METHODS)[number] | "stream";
const ALL = [...METHODS, "stream"] as const;

function parseBody(raw: string | undefined, ctx: CliContext): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    ctx.print("body must be valid JSON");
    throw new Error("invalid --body JSON");
  }
}

export function registerApi(reg: CommandRegistry): void {
  reg.register({
    path: "api",
    summary: "raw authenticated request: api <get|post|patch|put|del|stream> </api/path> [json-body]",
    usage: "api <get|post|patch|put|del|stream> </api/path> [<json-body>]",
    covers: [...METHODS.map((m) => `http.${m}`), "http.stream", "http.getBytes"],
    async run(ctx: CliContext, args: CliArgs) {
      const [methodRaw, path, body] = args.positional;
      const method = methodRaw?.toLowerCase() as Method | undefined;
      if (!method || !(ALL as readonly string[]).includes(method) || !path?.startsWith("/")) {
        return ctx.print("usage: api <get|post|patch|put|del|stream> </api/path> [<json-body>]");
      }
      // `stream` prints the raw body as it arrives — the shape agent turns use.
      if (method === "stream") {
        const upstream = await ctx.client.http.stream(path, parseBody(body, ctx) ?? {});
        ctx.print(await upstream.text());
        return;
      }
      const parsed = parseBody(body, ctx);
      const result =
        method === "get" || method === "del"
          ? await ctx.client.http[method](path)
          : await ctx.client.http[method](path, parsed);
      ctx.printJson(result);
    },
  });
}
