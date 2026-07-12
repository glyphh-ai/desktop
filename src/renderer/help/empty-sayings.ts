/**
 * Empty-state sayings — shown when a list (Connections, Layouts, Drips) has
 * nothing in it. Each one ties to the object AND carries the house spirit:
 * peace, love, acceptance, and a little humor. One is picked at random on
 * every render-while-empty, so the page quietly rotates as you come back.
 */

export const CONNECTIONS_EMPTY = [
  "No connections yet — and that's perfectly okay. Every bridge starts with an open hand.",
  "Nothing connected. Peace begins with reaching out — link an app when you're ready.",
  "Empty for now. The best connections, like the best friendships, arrive in their own time.",
  "No accounts linked yet. Love is just connection with the latency turned down.",
  "Quiet here. Somewhere an API is waiting to be your friend.",
  "Nothing plugged in — take a breath, your tools will find you.",
  "A blank switchboard, full of gentle possibility.",
  "Unconnected and content. Add an app when the moment feels right.",
  "Zero connections, infinite potential. Namaste, little agent.",
  "Nothing here yet — even the internet started with two computers saying hello.",
  "No tools linked. Kindness scales; so do integrations. Start with one.",
  "All quiet on the connection front. Wire something up and let the good data flow.",
  "A peaceful, portless calm. Connect something whenever you like.",
  "Empty. Connection is just love with an OAuth token.",
];

export const LAYOUTS_EMPTY = [
  "No layouts yet — and there's beauty in a blank canvas. Arrange things when you're ready.",
  "Nothing saved. Order is just peace you can see — build a layout when it calls to you.",
  "Empty workspace, open mind. Your perfect arrangement is one click away.",
  "No layouts here. Harmony isn't found, it's arranged — gently.",
  "A clean slate. Even chaos loves a good layout eventually.",
  "Nothing saved yet. Take what you need, leave what you don't, arrange the rest.",
  "The calm before the composition.",
  "Blank for now — a place for everything, and everything in loving place.",
  "Zero layouts. Feng shui your panels whenever the spirit moves you.",
  "Nothing arranged yet. Peace is a well-placed window.",
  "The tidiest desk is the one you haven't messed up yet — enjoy it while it lasts.",
  "No saved layouts. Design your calm; save it for later.",
  "A quiet grid, waiting. Arrange with love, save with a click.",
  "Nothing here — pure potential, perfectly aligned.",
];

export const DRIPS_EMPTY = [
  "No drips yet — but the vibe is already immaculate. Make one when you feel it.",
  "Nothing sparkling here yet. Add a little flair; the universe approves.",
  "No drips. Style is just self-love with better lighting.",
  "Empty, but make it fabulous later. Start the shimmer whenever.",
  "No effects yet — peace, love, and a tasteful particle or two.",
  "Nothing dripping. Every masterpiece starts undecorated.",
  "A calm, effect-free serenity. Spice it up whenever you like.",
  "Zero drips, zero pressure. Beauty arrives on its own schedule.",
  "Nothing here — sprinkle some joy, the pixels are ready.",
  "No custom drips yet. Flair is a love language; go speak it.",
  "Empty and elegant. Add a drip when the mood strikes.",
  "No effects saved. Good vibes only, particles optional.",
  "A blank shimmer, waiting. Design a drip; play it with .drip <name>.",
  "Nothing yet — the quietest glow is still a glow.",
];

/** A random saying from the list — call on each render-while-empty. */
export function pickSaying(list: readonly string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}

/** The empty-state markup: a rotating saying over a muted how-to hint. */
export function emptyStateHtml(list: readonly string[], hint: string): string {
  return `<div class="crud-empty">`
    + `<div class="crud-empty-saying">${pickSaying(list)}</div>`
    + `<div class="crud-empty-hint">${hint}</div>`
    + `</div>`;
}
