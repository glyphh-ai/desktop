/**
 * commands/app-instances.ts — the installed apps: list, install a BUILT bundle
 * (create → upload → ready), build from SOURCE (builds → upload → run), the
 * release list + pin (rollback), invoke a tool, patch, remove. One command per
 * SDK method; `covers` keeps the parity test honest.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";
import type { AppInstanceAccess, AppInstanceKind, PatchAppInstanceInput } from "../../contract/app-instances.js";

async function putTo(url: string, bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<void> {
  const res = await fetch(url, { method: "PUT", headers: { "content-type": contentType }, body: bytes });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
}

function parseN(raw: string | undefined, what: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${what} must be a positive integer`);
  return n;
}

export function registerAppInstances(reg: CommandRegistry): void {
  reg.register({
    path: "apps list",
    summary: "the installed apps you can open (the org's + your personal ones)",
    covers: ["appInstances.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.appInstances.list());
    },
  });

  reg.register({
    path: "apps install",
    summary: "install a BUILT bundle (zip: manifest.json + ui/ + worker.js) as an instance",
    usage: "apps install <bundle.zip> --manifest <manifest.json> [--kind org|personal] [--note <text>]",
    covers: ["appInstances.create", "appInstances.ready"],
    async run(ctx, args) {
      const file = args.positional[0];
      const manifestPath = flagStr(args, "manifest");
      if (!file || !manifestPath) throw new Error("usage: apps install <bundle.zip> --manifest <manifest.json> [--kind org|personal]");
      const bytes = new Uint8Array(readFileSync(file)) as Uint8Array<ArrayBuffer>;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const slug = String(manifest.slug ?? "");
      if (!slug) throw new Error("the manifest has no slug");
      const kind = (flagStr(args, "kind") ?? "personal") as AppInstanceKind;
      const { instance, upload } = await ctx.client.appInstances.create({ slug, kind, bundle: { sha256, sizeBytes: bytes.byteLength }, manifest });
      await putTo(upload.url, bytes, "application/zip");
      const note = flagStr(args, "note");
      ctx.printJson(await ctx.client.appInstances.ready(instance.key, note ? { note } : {}));
    },
  });

  reg.register({
    path: "apps from-hub",
    summary: "install a public hub app as it is",
    usage: "apps from-hub <itemId>",
    covers: ["appInstances.fromHub"],
    async run(ctx, args) {
      const itemId = args.positional[0];
      if (!itemId) throw new Error("usage: apps from-hub <itemId>");
      ctx.printJson(await ctx.client.appInstances.fromHub(itemId));
    },
  });

  reg.register({
    path: "apps releases",
    summary: "an instance's releases (the pinned one marked)",
    usage: "apps releases <key>",
    covers: ["appInstances.releases"],
    async run(ctx, args) {
      const key = args.positional[0];
      if (!key) throw new Error("usage: apps releases <key>");
      ctx.printJson(await ctx.client.appInstances.releases(key));
    },
  });

  reg.register({
    path: "apps pin",
    summary: "pin a release (rollback = the previous n)",
    usage: "apps pin <key> <n>",
    covers: ["appInstances.pin"],
    async run(ctx, args) {
      const [key, n] = args.positional;
      if (!key || !n) throw new Error("usage: apps pin <key> <n>");
      ctx.printJson(await ctx.client.appInstances.pin(key, parseN(n, "n")));
    },
  });

  reg.register({
    path: "apps deploy",
    summary: "build a release from SOURCE (a .tgz of the Next.js project) and pin it",
    usage: "apps deploy <key> <source.tgz> [--note <text>]",
    covers: ["appInstances.builds", "appInstances.runBuild"],
    async run(ctx, args) {
      const [key, file] = args.positional;
      if (!key || !file) throw new Error("usage: apps deploy <key> <source.tgz> [--note <text>]");
      const bytes = new Uint8Array(readFileSync(file)) as Uint8Array<ArrayBuffer>;
      const { build, upload } = await ctx.client.appInstances.builds(key);
      await putTo(upload.url, bytes, "application/gzip");
      const note = flagStr(args, "note");
      const { release, log } = await ctx.client.appInstances.runBuild(key, build.n, note ? { note } : {});
      ctx.printJson({ release, log });
    },
  });

  reg.register({
    path: "apps invoke",
    summary: "run one of an app's tools",
    usage: "apps invoke <key> <tool> [--args <json>]",
    covers: ["appInstances.invoke"],
    async run(ctx, args) {
      const [key, tool] = args.positional;
      if (!key || !tool) throw new Error("usage: apps invoke <key> <tool> [--args <json>]");
      const raw = flagStr(args, "args");
      const toolArgs = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      ctx.printJson(await ctx.client.appInstances.invoke(key, tool, toolArgs));
    },
  });

  reg.register({
    path: "apps patch",
    summary: "access, members, public, the org connection, config vars, the embedding model",
    usage: "apps patch <key> [--access everyone|restricted] [--members a,b] [--public true|false] [--org-connection <id>|none] [--secrets <json: {K: V|null}>] [--embed-model <model>|none]",
    covers: ["appInstances.patch"],
    async run(ctx, args) {
      const key = args.positional[0];
      if (!key) throw new Error("usage: apps patch <key> [--flags]");
      const input: PatchAppInstanceInput = {};
      const access = flagStr(args, "access");
      if (access) input.access = access as AppInstanceAccess;
      const members = flagStr(args, "members");
      if (members !== undefined) input.members = members ? members.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const pub = flagStr(args, "public");
      if (pub !== undefined) input.public = pub === "true";
      const conn = flagStr(args, "org-connection");
      if (conn !== undefined) input.orgConnectionId = conn === "none" ? null : conn;
      const secretsJson = flagStr(args, "secrets");
      if (secretsJson !== undefined) input.secrets = JSON.parse(secretsJson) as Record<string, string | null>;
      const embed = flagStr(args, "embed-model");
      if (embed !== undefined) input.embedModel = embed === "none" ? null : embed;
      if (Object.keys(input).length === 0) throw new Error("nothing to patch — pass at least one flag");
      ctx.printJson(await ctx.client.appInstances.patch(key, input));
    },
  });

  reg.register({
    path: "apps remove",
    summary: "remove an instance (its releases stay in R2)",
    usage: "apps remove <key>",
    covers: ["appInstances.remove"],
    async run(ctx, args) {
      const key = args.positional[0];
      if (!key) throw new Error("usage: apps remove <key>");
      await ctx.client.appInstances.remove(key);
      ctx.printJson({ removed: key });
    },
  });
}
