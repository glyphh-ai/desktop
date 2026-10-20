/**
 * loop-artifacts.ts — THE AGENT'S ARTIFACTS, on this machine (local only,
 * 2026-10-18).
 *
 * The loop's artifact_publish and artifact_read used to post to the
 * gateway's /api/artifacts. With no server, the loop asks its host instead
 * (LoopDeps.artifacts) and this is the desktop's answer: the same folder the
 * Artifacts panel and the Files gallery read (artifacts-local.ts), so what
 * the agent publishes is in the panel at once and an edit it makes lands on
 * the file the user is commenting on.
 *
 * The id is the filename. A create picks a free name; an update replaces the
 * bytes in place and, given a new name, renames — the record it answers
 * carries the id the artifact has from then on, and its comments move with
 * it (artifacts-local.ts rename).
 */

import fs from "fs";
import type { ArtifactMeta, LoopArtifacts } from "@glyphh/sdk/loop";
import * as local from "./artifacts-local.js";

/** The record the model sees for a local artifact. */
export function metaOf(a: local.LocalArtifact): ArtifactMeta {
  return { id: a.id, name: a.name, mime: a.mime, sizeBytes: a.sizeBytes, updatedAt: a.createdAt };
}

export const loopArtifacts: LoopArtifacts = {
  publish: async ({ id, name, bytes }) => {
    const data = Buffer.from(bytes);
    if (!id) {
      if (!name) throw new Error("a new artifact needs a name");
      return metaOf(local.write(name, data));
    }
    let row = local.get(id);
    row = local.save(row.id, data);
    if (name && name !== row.name) row = local.rename(row.id, local.renameTarget(row.name, name));
    return metaOf(row);
  },
  read: async (id) => {
    const row = local.get(id);
    return { meta: metaOf(row), bytes: fs.readFileSync(row.path) };
  },
};
