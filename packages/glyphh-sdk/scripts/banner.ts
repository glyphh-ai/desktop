/**
 * banner.ts — the Glyphh mascot + wordmark in white braille, byte-identical to
 * glyphh-rotor's (glyphh_rotor/banner.py) so every Glyphh shell shares one
 * identity. Palette follows the TUI law: white + neutral gray + ONE purple
 * (#af5fff = xterm-256 135); 256-color-safe, no truecolor.
 */

const W = "\x1b[38;5;231m"; // true white
const D = "\x1b[38;5;244m"; // dim / neutral gray
const R = "\x1b[0m";
const BOLD = "\x1b[1m";

const LOGO = `⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⢸⡏⠳⣄⡀⠀⣀⣠⠴⠚⠉⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠈⢧⣀⡤⠟⠛⠉⠀⠀⠀⢰⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢰⢛⣛⢳⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡞⢛⣛⢳⠀⠀⠀⠀⠀⢰⠛⣛⡛⡆⠀⠀⠀⠀⠀⠀⠀
⠀⠀⢠⠞⠁⢀⣤⠴⠖⠒⠲⣄⠈⢳⡀⠀⠀⠀⣀⡤⠤⠶⠶⠦⠤⣼⢸⣿⢸⠤⠤⣤⠀⣠⠤⠤⣤⠤⠤⠶⠶⠤⢤⣀⡇⢸⣿⠸⠤⠶⠦⠤⣄⢸⠀⣿⡇⠧⠴⠦⠤⣄⠀⠀⠀
⠀⠀⡏⠀⣰⠋⠀⠀⢠⣶⡆⢸⡆⠀⣧⠀⢀⡞⣡⣶⠿⣛⣛⢿⣷⢸⢸⣿⢸⢸⣷⢸⠀⣿⢸⣿⠀⢸⣿⢛⣛⠻⢷⣎⠃⣸⣿⠾⢛⣛⠻⣷⣮⢻⠀⣿⡷⠟⣛⠻⣷⣮⢳⡀⠀
⠀⠀⣇⠀⠘⠲⢤⣄⣀⣈⣠⠞⠁⢀⡟⠀⢸⠱⣿⡇⣏⠉⣹⢸⣿⢸⢸⣿⢸⢸⣿⢸⠀⣿⢸⣿⠀⢸⣿⢸⡉⣹⠎⣿⡆⣿⣿⢸⠉⠉⢻⢸⣿⢸⠀⣿⡇⡏⠉⢻⢸⣿⢸⡇⠀
⠀⠀⠈⢹⡆⠀⣀⡀⠉⠉⠀⢤⠖⠋⠀⠀⠈⢧⡻⢿⣮⣭⣥⢾⣿⢸⢸⣿⢸⡘⢿⣮⣭⣥⢾⣿⠀⢸⣿⣬⣭⣥⣾⠟⡄⢻⣿⢸⠀⠀⢸⢸⣿⢸⠀⣿⡇⡇⠀⢸⢸⣿⢸⡇⠀
⠀⠀⠀⡾⠀⣸⣿⣿⣿⣶⡀⠈⠷⢚⣻⠀⠀⣼⢛⣓⠶⠖⣂⣼⡟⣸⠶⠶⠚⡟⣓⡲⠖⣂⣼⡟⡀⢸⣿⢰⠤⠶⠖⠋⠓⠶⠶⠚⠀⠀⠘⠒⠶⠚⠓⠶⠶⠃⠀⠘⠶⠶⠞⠃⠀
⠀⠀⠰⣧⣀⣉⣩⣭⣭⣭⣧⣤⣼⠏⠀⠀⠀⠳⢬⣝⣛⣛⣫⡭⠞⠁⠀⠀⠘⠧⣭⣛⣛⣫⡭⠞⠷⠬⠭⠼⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀`;

/** The full logo in bold white braille, with `subtitle` right-aligned beneath. */
export function banner(subtitle: string): string {
  const lines = LOGO.split("\n");
  const w = Math.max(...lines.map((l) => l.length));
  const body = lines.map((l) => `  ${BOLD}${W}${l}${R}`);
  body.push(`  ${D}${subtitle.padStart(w)}${R}`);
  return body.join("\n") + "\n";
}
