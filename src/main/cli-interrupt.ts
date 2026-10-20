/**
 * cli-interrupt — "the user stopped me", told apart from "I failed".
 *
 * An interrupt does not arrive as an exit first: the CLI answers it with a
 * `result` frame carrying is_error, and a reader that took that frame at its
 * word turned every stop into an error card — which then landed on whatever
 * turn the user had already moved on to.
 *
 * Pure and dependency-free on purpose: the bridge's stream reader and its
 * headless exit handler read the same answer.
 */

/** THE CLI'S OWN WORDS FOR AN INTERRUPT, across the vendors. */
export const INTERRUPT_SAID = /interrupted by user|request(ed)? interruption|user (interrupt|abort|cancel)|\bSIGINT\b|\bSIGTERM\b|aborted by (the )?user|operation (was )?(cancell?ed|aborted)/i;

/** Is this `result` frame the CLI acknowledging an interrupt, rather than
 *  reporting a failure of its own? */
export function isInterrupted(ev: { is_error?: unknown; subtype?: unknown; result?: unknown }): boolean {
  if (!ev.is_error) return false;
  if (/interrupt|abort|cancel/i.test(String(ev.subtype ?? ""))) return true;
  return INTERRUPT_SAID.test(String(ev.result ?? ""));
}
