/**
 * Autofill guard — the workspace has no shared <input> component and builds
 * most fields dynamically (HTML templates + innerHTML + DOM), so browsers and
 * password managers were injecting autocomplete dropdowns and the AutoFill
 * accessory bar onto ad-hoc text fields. This stamps every text-like input /
 * textarea that hasn't opted in with the standard "leave me alone" hints, and a
 * MutationObserver keeps doing so for nodes added after load. Install once per
 * document (each BrowserView / web page loads its own bundle).
 *
 * Respects intent — a field is left untouched when it already declares
 * `autocomplete` (e.g. login email, new-password), is a password input (owned
 * by password managers, like the BYOK key), or is tagged `data-allow-autofill`.
 * Idempotent and cheap: each element is processed at most once.
 */

// Ignore hints honoured by 1Password / LastPass / Bitwarden + the browser's own
// autocomplete. Mirrors the NOFILL set in web/src/mobile.tsx (string values here
// because we apply them via setAttribute rather than JSX).
const IGNORE_HINTS: Readonly<Record<string, string>> = {
  autocomplete: "off",
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
};

// <input> types that carry no free text the browser would try to autofill, plus
// `password` which we deliberately leave to password managers / explicit markup.
const SKIP_TYPES = new Set([
  "checkbox", "radio", "file", "range", "hidden", "submit",
  "button", "reset", "image", "color", "password",
]);

const processed = new WeakSet<Element>();

function guardField(el: Element): void {
  if (processed.has(el)) return;
  const tag = el.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA") return;
  processed.add(el);
  // A declared autocomplete or an explicit opt-in means the author already decided.
  if (el.hasAttribute("autocomplete") || el.hasAttribute("data-allow-autofill")) return;
  if (tag === "INPUT" && SKIP_TYPES.has((el.getAttribute("type") || "text").toLowerCase())) return;
  for (const [name, value] of Object.entries(IGNORE_HINTS)) {
    if (!el.hasAttribute(name)) el.setAttribute(name, value);
  }
}

function sweep(root: ParentNode): void {
  if ((root as Element).tagName) guardField(root as Element);
  for (const el of Array.from(root.querySelectorAll("input, textarea"))) guardField(el);
}

let installed = false;

/** Sweep the current DOM and watch for future inputs. Safe to call at module load. */
export function installAutofillGuard(doc: Document = document): void {
  if (installed) return;
  installed = true;
  const run = () => {
    sweep(doc);
    new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of Array.from(rec.addedNodes)) {
          if (node.nodeType === 1) sweep(node as Element);
        }
      }
    }).observe(doc.documentElement, { childList: true, subtree: true });
  };
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
}
