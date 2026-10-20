/**
 * mic-devices — the microphone picker's rows, pure (his report, 2026-10-07:
 * the list showed the browser's "Default - X" twin and hex ids in the names).
 * The browser's virtual entries ("default", "communications") are the
 * System default row; a label's trailing "(vid:pid)" goes; one row per name.
 */

export interface MicRow { id: string; name: string }

const VIRTUAL = new Set(["default", "communications"]);

export function cleanMicLabel(label: string, index: number): string {
  const l = label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "").replace(/^Default - /i, "").trim();
  return l || `Microphone ${index + 1}`;
}

/** System default first, then every real device once, by its cleaned name. */
export function micRows(devices: ReadonlyArray<{ deviceId: string; label: string }>): MicRow[] {
  const out: MicRow[] = [{ id: "", name: "System default" }];
  const seen = new Set<string>();
  devices.forEach((d, i) => {
    if (!d.deviceId || VIRTUAL.has(d.deviceId)) return;
    const name = cleanMicLabel(d.label, i);
    if (seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    out.push({ id: d.deviceId, name });
  });
  return out;
}

/** The row to check: the saved device when it is still present, else System default. */
export function micChecked(rows: ReadonlyArray<MicRow>, savedId: string | null | undefined): string {
  return savedId && rows.some((r) => r.id === savedId) ? savedId : "";
}
