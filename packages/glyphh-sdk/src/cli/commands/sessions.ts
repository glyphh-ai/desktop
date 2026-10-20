/**
 * commands/sessions.ts — control-plane runtime sessions. `create` provisions a rotor
 * runtime and prints `{ session, runtimeToken }` (token shown once); the REPL can then
 * open a data-plane stream to `session.runtimeUrl` with that token.
 */

import { readFileSync } from "node:fs";
import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";
import type { CreateSessionInput, SessionLocus, ModelSwitchSurface } from "../../contract/runtime.js";
import type { PushThreadInput, SessionThreadMessage } from "../../contract/threads.js";

export function registerSessions(reg: CommandRegistry): void {
  reg.register({
    path: "sessions create",
    summary: "provision a runtime session (token shown once)",
    usage: "sessions create <rotor> [--locus remote|local|relay] [--workspace <id>] [--repo <r> --branch <b> --path <p>]",
    covers: ["sessions.create"],
    async run(ctx, args) {
      const rotor = args.positional[0];
      if (!rotor) throw new Error("usage: sessions create <rotor> [--locus …] [--repo …]");
      const input: CreateSessionInput = { rotor };
      const locus = flagStr(args, "locus");
      if (locus) input.locus = locus as SessionLocus;
      const workspace = flagStr(args, "workspace");
      if (workspace) input.workspaceId = workspace;
      const repo = flagStr(args, "repo");
      if (repo) input.repo = repo;
      const branch = flagStr(args, "branch");
      if (branch) input.branch = branch;
      const path = flagStr(args, "path");
      if (path) input.path = path;
      ctx.printJson(await ctx.client.sessions.create(input));
    },
  });

  reg.register({
    path: "sessions list",
    summary: "your runtime sessions",
    covers: ["sessions.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.sessions.list());
    },
  });

  reg.register({
    path: "sessions get",
    summary: "one runtime session by id",
    usage: "sessions get <id>",
    covers: ["sessions.get"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: sessions get <id>");
      ctx.printJson(await ctx.client.sessions.get(id));
    },
  });

  reg.register({
    path: "sessions model-switch",
    summary: "record a mid-stream model switch (traceability audit)",
    usage: "sessions model-switch <sessionId> --to <modelId> --surface cli|desktop|mobile|platform [--rotor <slug>] [--role <role>] [--from <modelId>]",
    covers: ["sessions.recordModelSwitch"],
    async run(ctx, args) {
      const sessionId = args.positional[0];
      const to = flagStr(args, "to");
      const surface = flagStr(args, "surface");
      if (!sessionId || !to || !surface) {
        throw new Error("usage: sessions model-switch <sessionId> --to <modelId> --surface cli|desktop|mobile|platform");
      }
      const rotorSlug = flagStr(args, "rotor");
      const role = flagStr(args, "role");
      const from = flagStr(args, "from");
      ctx.printJson(
        await ctx.client.sessions.recordModelSwitch({
          sessionId,
          to,
          surface: surface as ModelSwitchSurface,
          ...(rotorSlug ? { rotorSlug } : {}),
          ...(role ? { role } : {}),
          ...(from ? { from } : {}),
        }),
      );
    },
  });

  reg.register({
    path: "sessions delete",
    summary: "deprovision + stop a runtime session",
    usage: "sessions delete <id>",
    covers: ["sessions.delete"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: sessions delete <id>");
      await ctx.client.sessions.delete(id);
      ctx.printJson({ stopped: id });
    },
  });

  // ── threads: the durable conversations in the regional stator (LWW sync) ────

  reg.register({
    path: "threads list",
    summary: "your threads (metadata only, newest-updated first)",
    covers: ["sessions.threads"],
    async run(ctx) {
      ctx.printJson(await ctx.client.sessions.threads());
    },
  });

  reg.register({
    path: "threads get",
    summary: "one thread with its message preview (last 20) and transcriptUrl",
    usage: "threads get <id>",
    covers: ["sessions.thread"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: threads get <id>");
      ctx.printJson(await ctx.client.sessions.thread(id));
    },
  });

  reg.register({
    path: "threads push",
    summary: "LWW-push a thread (cache sync — an unknown id creates it)",
    usage: "threads push <id> [--file <body.json>] [--title <t>] [--mode <m>] [--source <json>] [--updated-at <epoch-ms>]",
    covers: ["sessions.pushThread"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: threads push <id> [--file <body.json>] [--title …]");
      // A full body (incl. messages) comes from --file; flags override its metadata.
      const file = flagStr(args, "file");
      const body: PushThreadInput = file
        ? (JSON.parse(readFileSync(file, "utf8")) as PushThreadInput)
        : { updatedAt: Date.now() };
      const title = flagStr(args, "title");
      if (title !== undefined) body.title = title;
      const mode = flagStr(args, "mode");
      if (mode !== undefined) body.mode = mode;
      const source = flagStr(args, "source");
      if (source !== undefined) body.source = JSON.parse(source);
      const updatedAt = flagStr(args, "updated-at");
      if (updatedAt !== undefined) {
        const ms = Number(updatedAt);
        if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("--updated-at must be epoch milliseconds");
        body.updatedAt = ms;
      }
      if (typeof body.updatedAt !== "number") body.updatedAt = Date.now();
      ctx.printJson(await ctx.client.sessions.pushThread(id, body));
    },
  });

  reg.register({
    path: "threads transcript",
    summary: "a presigned URL of a thread's whole transcript",
    usage: "threads transcript <id>",
    covers: ["sessions.transcriptUrl"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: threads transcript <id>");
      ctx.printJson(await ctx.client.sessions.transcriptUrl(id));
    },
  });

  reg.register({
    path: "threads append",
    summary: "append messages to a thread (LWW — a stale clock answers applied:false)",
    usage: "threads append <id> --messages <json|@file> [--updated-at <epoch-ms>]",
    covers: ["sessions.appendMessages"],
    async run(ctx, args) {
      const id = args.positional[0];
      const raw = flagStr(args, "messages");
      if (!id || raw === undefined) throw new Error("usage: threads append <id> --messages <json|@file> [--updated-at <epoch-ms>]");
      const messages = JSON.parse(raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw) as SessionThreadMessage[];
      if (!Array.isArray(messages)) throw new Error("--messages must be a JSON array of messages");
      let updatedAt = Date.now();
      const flag = flagStr(args, "updated-at");
      if (flag !== undefined) {
        updatedAt = Number(flag);
        if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new Error("--updated-at must be epoch milliseconds");
      }
      ctx.printJson(await ctx.client.sessions.appendMessages(id, { messages, updatedAt }));
    },
  });

  reg.register({
    path: "threads delete",
    summary: "tombstone a thread (messages purged; stale pushes cannot revive it)",
    usage: "threads delete <id>",
    covers: ["sessions.deleteThread"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: threads delete <id>");
      await ctx.client.sessions.deleteThread(id);
      ctx.printJson({ deleted: id });
    },
  });
}
