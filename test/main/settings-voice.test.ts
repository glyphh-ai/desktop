/**
 * settings-voice.test.ts — Settings → General → Voice (src/renderer/help/
 * settings-voice.ts): ONE row, the voice dropdown (his order, 2026-10-07:
 * "all this is on by default, the only setting that should be there is the
 * dropdown"). The admin's config fills it; the pick writes one patch
 * through window.glyphh.voiceSettingsSet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NO_SPEECH_MODEL_LINE, NO_VOICES_LINE, loadVoiceSection, readVoiceConfig, readVoicePref, voicePatch, voiceSectionModel,
} from "../../src/renderer/help/settings-voice.js";

type Listener = (e: { target: FakeEl }) => void;
class FakeEl {
  value = ""; innerHTML = ""; textContent = ""; checked = false;
  private classes = new Set<string>();
  private listeners: Record<string, Listener[]> = {};
  classList = {
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
    toggle: (c: string, on?: boolean) => { if (on ?? !this.classes.has(c)) this.classes.add(c); else this.classes.delete(c); return this.classes.has(c); },
    contains: (c: string) => this.classes.has(c),
  };
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ||= []).push(fn); }
  fire(type: string): void { for (const fn of this.listeners[type] || []) fn({ target: this }); }
  hidden(): boolean { return this.classes.has("hidden"); }
  options(): Array<{ value: string; label: string }> {
    return [...this.innerHTML.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => ({ value: m[1], label: m[2] }));
  }
}
const IDS = ["voice-section", "voice-settings-error", "voice-voice", "voice-voices-line", "voice-brief"];
let els: Record<string, FakeEl>;
let set: ReturnType<typeof vi.fn>;
const CFG = { stt: "openai::gpt-4o-mini-transcribe", tts: "elevenlabs::eleven_flash_v2_5", voice: "Rachel", voices: ["Rachel", "Adam", "Bella"] };

function install(cfg: unknown, pref: unknown): void {
  els = Object.fromEntries(IDS.map((id) => [id, new FakeEl()]));
  set = vi.fn(async (patch: unknown) => patch);
  (globalThis as unknown as { document: unknown }).document = { getElementById: (id: string) => els[id] ?? null, documentElement: { classList: { contains: () => false } } };
  (globalThis as unknown as { window: unknown }).window = { glyphh: { voiceConfig: async () => cfg, voiceSettingsGet: async () => pref, voiceSettingsSet: set } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("reading the doors", () => {
  it("takes the desktop's raw object and the web's {ok,data} envelope alike; a missing voices list is []", () => {
    expect(readVoiceConfig(CFG)).toEqual({ tts: CFG.tts, voice: "Rachel", voices: ["Rachel", "Adam", "Bella"] });
    expect(readVoiceConfig({ ok: true, data: { tts: "t", voices: ["a", "", 3] } })).toEqual({ tts: "t", voice: null, voices: ["a"] });
    expect(readVoiceConfig(null)).toEqual({ tts: null, voice: null, voices: [] });
    expect(readVoicePref({ ok: true, data: { voiceId: "Adam", mode: "off" } })).toEqual({ voiceId: "Adam", brief: true });
    expect(readVoicePref({})).toEqual({ voiceId: null, brief: true });
    expect(readVoicePref({ brief: false })).toEqual({ voiceId: null, brief: false });
  });
});

describe("the model — the dropdown and nothing else", () => {
  it("the admin's default voice is marked (default) and is the empty value; the member's pick is selected", () => {
    const m = voiceSectionModel(CFG, { voiceId: "Bella" });
    expect(m.voiceOptions).toEqual([{ value: "", label: "Rachel (default)" }, { value: "Adam", label: "Adam" }, { value: "Bella", label: "Bella" }]);
    expect(m.voiceValue).toBe("Bella");
    expect(m.voicesLine).toBeNull();
    expect(voiceSectionModel(CFG, { voiceId: "Rachel" }).voiceValue).toBe("");
    expect(voiceSectionModel(CFG, { voiceId: "gone" }).voiceValue).toBe("");
    expect(voiceSectionModel({ ...CFG, voice: null }, {}).voiceOptions![0]).toEqual({ value: "", label: "Default" });
  });
  it("no voices listed → the line, no dropdown; no speech model → its own line", () => {
    expect(voiceSectionModel({ ...CFG, voices: [] }, {})).toEqual({ voiceOptions: null, voicesLine: NO_VOICES_LINE, voiceValue: "", brief: true });
    expect(voiceSectionModel({ tts: null, voice: null, voices: [] }, {})).toEqual({ voiceOptions: null, voicesLine: NO_SPEECH_MODEL_LINE, voiceValue: "", brief: true });
  });
  it("the dropdown writes one patch; the default row writes null", () => {
    expect(voicePatch.voice("Adam")).toEqual({ voiceId: "Adam" });
    expect(voicePatch.voice("")).toEqual({ voiceId: null });
  });
  it("BRIEF is the one switch (his order, 2026-10-07): on unless turned off, and it writes its own patch", () => {
    expect(voiceSectionModel(CFG, {}).brief).toBe(true);
    expect(voiceSectionModel(CFG, { brief: false }).brief).toBe(false);
    expect(voicePatch.brief(false)).toEqual({ brief: false });
    expect(Object.keys(voicePatch)).toEqual(["voice", "brief"]);
  });
});

describe("the row in the DOM", () => {
  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
    delete (globalThis as unknown as { window?: unknown }).window;
  });
  describe("with the admin's model and voices", () => {
    beforeEach(async () => { install(CFG, { ok: true, data: { voiceId: "Bella" } }); await loadVoiceSection(); });
    it("paints the dropdown from the doors", () => {
      expect(els["voice-section"].hidden()).toBe(false);
      expect(els["voice-voice"].options()).toEqual([{ value: "", label: "Rachel (default)" }, { value: "Adam", label: "Adam" }, { value: "Bella", label: "Bella" }]);
      expect(els["voice-voice"].value).toBe("Bella");
      expect(els["voice-voice"].hidden()).toBe(false);
      expect(els["voice-voices-line"].hidden()).toBe(true);
    });
    it("the Brief switch paints on and writes its patch when flipped", async () => {
      expect(els["voice-brief"].checked).toBe(true);
      const sw = els["voice-brief"];
      sw.checked = false; sw.fire("change"); await tick();
      expect(set).toHaveBeenLastCalledWith({ brief: false });
    });
    it("a pick writes voiceId; the default row writes null", async () => {
      const sel = els["voice-voice"];
      sel.value = "Adam"; sel.fire("change"); await tick();
      expect(set).toHaveBeenLastCalledWith({ voiceId: "Adam" });
      sel.value = ""; sel.fire("change"); await tick();
      expect(set).toHaveBeenLastCalledWith({ voiceId: null });
    });
  });
  it("no voices listed → the line, the dropdown hidden", async () => {
    install({ ...CFG, voices: [] }, {});
    await loadVoiceSection();
    expect(els["voice-voice"].hidden()).toBe(true);
    expect(els["voice-voices-line"].textContent).toBe(NO_VOICES_LINE);
    expect(els["voice-voices-line"].hidden()).toBe(false);
  });
  it("no speech model → its line; a failed save shows the error", async () => {
    install({ stt: "x", tts: null, voices: [] }, {});
    await loadVoiceSection();
    expect(els["voice-voices-line"].textContent).toBe(NO_SPEECH_MODEL_LINE);
    set.mockRejectedValueOnce(new Error("offline"));
    els["voice-voice"].value = "Adam"; els["voice-voice"].fire("change"); await tick();
    expect(els["voice-settings-error"].textContent).toContain("offline");
  });
});
