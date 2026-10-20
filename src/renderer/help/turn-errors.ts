/**
 * turn-errors — a failed turn is a CARD with a way forward, never a raw
 * sentence (his report, 2026-09-29: a brand-new user got "Pick a model…", and
 * a provider's raw `AuthenticationError … API key is invalid`). This reads the
 * refusal's words and says what kind it is; help/code.ts draws the card. Pure,
 * so the reading is tested.
 */

export type TurnErrorKind = "no-model" | "model-down" | "failed";

export interface TurnError {
  kind: TurnErrorKind;
  title: string;
  body: string;
  /** Opens the model picker (no-model, model-down). */
  action: "models" | null;
  /** The raw words, kept for a details fold. */
  raw: string;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The model a provider error names ("Received Model Group=claude-opus-4-8"). */
function modelNamed(raw: string): string {
  return /Received Model Group=([^\s,]+)/.exec(raw)?.[1] ?? /model[=: ]+["']?([\w.:/-]+)["']?/i.exec(raw)?.[1] ?? "";
}

/** Null when the message is not a refusal (an ordinary reply). */
export function turnError(text: string): TurnError | null {
  const raw = String(text ?? "").replace(/^⚠\s*/, "").trim();
  if (!/^⚠/.test(String(text ?? "").trim())) return null;
  // The engine's NO_MODEL_MESSAGE, and the words it used before (old transcripts).
  if (/Choose a model in the model picker below|Pick a model for the Glyphh loop/i.test(raw)) {
    return { kind: "no-model", title: "Choose a model", body: "Choose a model in the model picker below.", action: "models", raw };
  }
  const said = raw.replace(/^gateway \d{3}:\s*/, "");
  const model = modelNamed(raw);
  if (/AuthenticationError|authentication_error|API key is invalid|ServiceUnavailable|APIConnectionError|model_not_found|NotFoundError|InternalServerError|overloaded|gateway 50[0-9]/i.test(raw)) {
    return {
      kind: "model-down",
      title: model ? `${model} isn't reachable right now` : "That model isn't reachable right now",
      body: "Glyphh couldn't reach the model's provider. Check its key in Settings › Models, pick another model, or try again in a minute.",
      action: "models", raw,
    };
  }
  return { kind: "failed", title: "The turn didn't go through", body: clip(said.replace(/\{.*\}/s, "").trim() || said, 220), action: null, raw };
}
