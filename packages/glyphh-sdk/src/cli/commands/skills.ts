/**
 * commands/skills.ts — the org's skill library. Members list/read; org_admins
 * build/edit/delete.
 *
 * A skill is a manifest + an instruction prompt + an optional program, so authoring
 * works against FILES the way loops do: `--prompt`, `--code`, and `--manifest` each
 * read a path, and `skills pull` writes all three back out.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { CommandRegistry } from "../registry.js";
import type { CliArgs } from "../args.js";
import { flagStr } from "../args.js";
import type { CreateSkillInput, UpdateSkillInput, SkillManifest } from "../../contract/skills.js";

function fileFlag(args: CliArgs, name: string): string | undefined {
  const path = flagStr(args, name);
  if (path === undefined) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`--${name}: cannot read ${path} (${err instanceof Error ? err.message : String(err)})`);
  }
}

function manifestFlag(args: CliArgs): SkillManifest | undefined {
  const raw = fileFlag(args, "manifest");
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as SkillManifest;
  } catch {
    throw new Error("--manifest must be a file containing valid JSON");
  }
}

export function registerSkills(reg: CommandRegistry): void {
  reg.register({
    path: "skills list",
    summary: "list the org's skills",
    covers: ["skills.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.skills.list());
    },
  });

  reg.register({
    path: "skills get",
    summary: "a skill's detail (manifest + prompt + program)",
    usage: "skills get <slug|id>",
    covers: ["skills.get"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: skills get <slug|id>");
      ctx.printJson(await ctx.client.skills.get(ref));
    },
  });

  reg.register({
    path: "skills pull",
    summary: "write a skill's prompt, program + manifest to disk",
    usage: "skills pull <slug|id> [--prompt <path>] [--code <path>] [--manifest <path>]",
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: skills pull <slug|id> [--prompt <path>] [--code <path>] [--manifest <path>]");
      const skill = await ctx.client.skills.get(ref);
      const promptPath = flagStr(args, "prompt") ?? `${skill.slug}.skill.md`;
      const manifestPath = flagStr(args, "manifest") ?? `${skill.slug}.skill.json`;
      writeFileSync(promptPath, skill.prompt, "utf8");
      writeFileSync(manifestPath, `${JSON.stringify(skill.manifest, null, 2)}\n`, "utf8");
      const written = [promptPath, manifestPath];
      // Only write a program file when there is one — a prompt-only skill
      // shouldn't leave an empty .js behind.
      if (skill.code.trim()) {
        const codePath = flagStr(args, "code") ?? `${skill.slug}.skill.js`;
        writeFileSync(codePath, skill.code, "utf8");
        written.push(codePath);
      }
      ctx.print(written.join("\n"));
    },
  });

  reg.register({
    path: "skills create",
    summary: "build a skill (org_admin)",
    usage: "skills create <slug> <name> [--description <d>] [--prompt <path>] [--code <path>] [--manifest <path>]",
    covers: ["skills.create"],
    async run(ctx, args) {
      const [slug, name] = args.positional;
      if (!slug || !name) {
        throw new Error("usage: skills create <slug> <name> [--description ..] [--prompt <path>] [--code <path>] [--manifest <path>]");
      }
      const input: CreateSkillInput = { slug, name };
      const desc = flagStr(args, "description"); if (desc !== undefined) input.description = desc;
      const prompt = fileFlag(args, "prompt"); if (prompt !== undefined) input.prompt = prompt;
      const code = fileFlag(args, "code"); if (code !== undefined) input.code = code;
      const manifest = manifestFlag(args); if (manifest !== undefined) input.manifest = manifest;
      ctx.printJson(await ctx.client.skills.create(input));
    },
  });

  reg.register({
    path: "skills update",
    summary: "edit a skill (org_admin)",
    usage: "skills update <slug|id> [--name <n>] [--description <d>] [--prompt <path>] [--code <path>] [--manifest <path>]",
    covers: ["skills.update"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) {
        throw new Error("usage: skills update <slug|id> [--name ..] [--prompt <path>] [--code <path>] [--manifest <path>]");
      }
      const patch: UpdateSkillInput = {};
      const name = flagStr(args, "name"); if (name !== undefined) patch.name = name;
      const desc = flagStr(args, "description"); if (desc !== undefined) patch.description = desc;
      const slug = flagStr(args, "slug"); if (slug !== undefined) patch.slug = slug;
      const prompt = fileFlag(args, "prompt"); if (prompt !== undefined) patch.prompt = prompt;
      const code = fileFlag(args, "code"); if (code !== undefined) patch.code = code;
      const manifest = manifestFlag(args); if (manifest !== undefined) patch.manifest = manifest;
      if (Object.keys(patch).length === 0) throw new Error("nothing to update — pass at least one flag");
      ctx.printJson(await ctx.client.skills.update(ref, patch));
    },
  });

  reg.register({
    path: "skills delete",
    summary: "delete a skill (org_admin)",
    usage: "skills delete <slug|id>",
    covers: ["skills.remove"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: skills delete <slug|id>");
      await ctx.client.skills.remove(ref);
      ctx.print("deleted ✓");
    },
  });
}
