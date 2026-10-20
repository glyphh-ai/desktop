/**
 * house-store-web.js — THE HOUSE PANELS' DATA ON THE WEB: shared/house-store.ts
 * over the SDK client (his order, 2026-10-06: "cloud is first and every
 * surface pulls from it").
 *
 * The web renderer hosts Design / Slides / Images / Video / Audio / Drive
 * itself (code-workbench.ts) and reads them through window.glyphh's design*,
 * gpoint*, media* and gdrive* shims. Every shim here IS the store's door —
 * the same module the desktop's main process runs (main/house-store.ts) over
 * `client.memberLibrary` and the server's byte lane — so a deck saved on the
 * desktop is in the Slides panel here, and one made here is on the desktop.
 * Reads and writes alike; no relay, no desktop.
 *
 * The browser's own part: Upload is an <input type=file>, Download a Blob
 * the browser saves, and sha256 is SubtleCrypto. Pure over the injected
 * client + fetch: web/test/house-store-web.test.js runs it bare.
 */

import { createHouseStore, serverLaneBytes, MEDIA_MIME } from '../../src/shared/house-store.ts';

const msg = (e) => (e instanceof Error ? e.message : String(e));

/** sha256 as hex — the browser's SubtleCrypto (node's webcrypto under test). */
async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('no crypto.subtle — cannot hash the file');
  const buf = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** One file off the member's disk through the browser's picker, or null when they cancel. */
function pickFile(doc, accept) {
  return new Promise((resolve) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files && input.files[0] ? input.files[0] : null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * @param {object} client  the SDK client (client.memberLibrary, client.token)
 * @param {string} apiUrl  the server the byte lane lives on
 */
export function createHouseStoreWeb({ client, apiUrl, fetchImpl = (u, i) => fetch(u, i), now, document: doc = globalThis.document }) {
  const store = createHouseStore({
    lib: client.memberLibrary,
    bytes: serverLaneBytes({ apiUrl, token: () => client.token(), fetchImpl }),
    sha256: sha256Hex,
    ...(now ? { now } : {}),
  });
  const {
    designList, designRead, designWrite, designDelete, designAssetUpload, designAssetUrl, designAssetDelete,
    gpointList, gpointRead, gpointWrite, gpointNew, gpointDelete,
    mediaList, mediaUrl, mediaThumbBytes, mediaDelete,
    gdriveList, gdriveMkdir, gdriveMove, gdriveFolderRename, gdriveFolderDelete,
  } = store;
  const accept = Object.keys(MEDIA_MIME).join(',');

  return {
    // ── Design (wb-design.ts) ─────────────────────────────────────────────
    designList, designRead, designWrite, designDelete, designAssetUpload, designAssetUrl, designAssetDelete,
    // ── Slides (wb-gpoint.ts) ─────────────────────────────────────────────
    gpointList, gpointRead, gpointWrite, gpointNew, gpointDelete,
    // ── Images / Video / Audio (wb-media.ts) ──────────────────────────────
    mediaList, mediaUrl, mediaThumbBytes, mediaDelete,
    // GLYPHH MAKES NO MODEL CALLS (media-panel.ts says the same on the desktop):
    // the agent generates and files the result with the app's own save tool.
    mediaGenerate: async () => ({ ok: false, error: 'Ask the agent to make it — it generates and saves into this app\'s library. Glyphh itself makes no model calls.' }),
    mediaJob: async () => ({ ok: false, error: 'Generation runs in the agent, not on a server, so there is no job to poll.' }),
    // Upload: the browser's picker, then the store's add under a free name.
    mediaUploadPick: async (kind) => {
      try {
        const file = await pickFile(doc, accept);
        if (!file) return { ok: false, error: 'cancelled' };
        return await store.mediaAdd(kind, file.name, new Uint8Array(await file.arrayBuffer()), file.type || undefined);
      } catch (err) { return { ok: false, error: msg(err) }; }
    },
    // Download: the file's bytes, saved by the browser.
    mediaSave: async (id) => {
      const r = await store.mediaBytes(id);
      if (!r.ok) return r;
      try {
        const url = URL.createObjectURL(new Blob([r.bytes], { type: r.mime || 'application/octet-stream' }));
        const a = doc.createElement('a');
        a.href = url;
        a.download = r.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return { ok: true, path: r.name };
      } catch (err) { return { ok: false, error: msg(err) }; }
    },
    // ── Drive (wb-drive.ts) ───────────────────────────────────────────────
    gdriveList, gdriveMkdir, gdriveMove, gdriveFolderRename, gdriveFolderDelete,
  };
}
