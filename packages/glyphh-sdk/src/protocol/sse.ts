/**
 * protocol/sse.ts — parse a Server-Sent Events byte stream into WireEvents. Built
 * on the web-standard `ReadableStream` off a `fetch` response, so it runs on Node,
 * the browser, and RN alike (no `EventSource`, which RN lacks). Handles multi-line
 * `data:` fields, `id:`/`event:` fields, comment lines (`:`), and partial frames
 * split across chunk boundaries.
 */

import { ProtocolError } from "../core/errors.js";
import type { WireEvent } from "./events.js";

/** Yield each WireEvent as it is framed off the stream. */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<WireEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      // A record ends at a blank line. Process every complete record in the buffer.
      let sep: number;
      while ((sep = indexOfBlankLine(buffer)) !== -1) {
        const record = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){1,2}/, "");
        const ev = frameToEvent(record);
        if (ev) yield ev;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Index just past the end of the first record (first blank line), or -1. */
function indexOfBlankLine(buf: string): number {
  const nn = buf.indexOf("\n\n");
  const rnrn = buf.indexOf("\r\n\r\n");
  if (nn === -1) return rnrn;
  if (rnrn === -1) return nn;
  return Math.min(nn, rnrn);
}

/** Turn one SSE record (its lines) into a WireEvent, or null for comment-only frames. */
function frameToEvent(record: string): WireEvent | null {
  const dataLines: string[] = [];
  for (const raw of record.split(/\r?\n/)) {
    if (raw === "" || raw.startsWith(":")) continue; // comment / blank (e.g. the version announce)
    const colon = raw.indexOf(":");
    const field = colon === -1 ? raw : raw.slice(0, colon);
    const val = colon === -1 ? "" : raw.slice(colon + 1).replace(/^ /, "");
    if (field === "data") dataLines.push(val);
    // `id:` (the seq) and `event:` (the kind) are also present in each frame, but the
    // canonical event JSON in `data` already carries `seq` and `kind`, so we decode that.
  }
  if (dataLines.length === 0) return null;
  const json = dataLines.join("\n");
  try {
    return JSON.parse(json) as WireEvent;
  } catch (e) {
    throw new ProtocolError("malformed SSE data frame", e);
  }
}
