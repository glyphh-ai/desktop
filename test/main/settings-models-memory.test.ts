/**
 * settings-models-memory.test.ts — Settings › Models names every model type
 * with its line (embeddings power memory; image and video are made when a loop
 * asks), and Settings › Memory knows memory is off without an embeddings model.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/help/shared.js", () => ({ confirmAction: async () => false }));
vi.mock("../../src/renderer/help/toast.js", () => ({ toastOk: () => undefined }));
vi.mock("../../src/renderer/help/navigation.js", () => ({ openSettingsModal: () => undefined }));
vi.mock("../../src/renderer/help/web-surface.js", () => ({ keepIfHost: () => undefined }));
vi.mock("../../src/renderer/glyphh-spinner.js", () => ({ createGlyphhSpinner: () => ({}) }));

const models = await import("../../src/renderer/help/settings-models.js");
const memory = await import("../../src/renderer/help/settings-memory.js");

describe("Settings › Models types", () => {
  it("labels and explains every type, voice ones unchanged", () => {
    expect(models.TYPE_LABEL).toEqual({ chat: "Chat", transcription: "Transcription", speech: "Speech", embeddings: "Embeddings", image: "Image", video: "Video" });
    expect(models.TYPE_HINT).toEqual({
      chat: "What a new session runs on.",
      transcription: "Turns your voice into text when you dictate.",
      speech: "Reads replies aloud in voice mode.",
      embeddings: "Powers memory and search.",
      image: "Makes images when a loop asks for one.",
      video: "Makes video when a loop asks for one.",
    });
  });
});

describe("Settings › Memory without an embeddings model", () => {
  it("is off with no model, on with one, and assumes on when it cannot ask", () => {
    expect(memory.memoryHasModel({ ok: true, model: "", models: [] })).toBe(false);
    expect(memory.memoryHasModel({ ok: true, model: "openai::text-embedding-3-small", models: [] })).toBe(true);
    expect(memory.memoryHasModel(null)).toBe(true);
    expect(memory.memoryHasModel({ ok: false, model: "", models: [] })).toBe(true);
    expect(memory.MEMORY_NEEDS_MODEL).toBe("Memory needs an embeddings model. Add one in Settings › Models.");
  });
});
