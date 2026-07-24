import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

declare global {
  interface Window {
    terminalAPI: {
      write: (data: string) => void;
      resize: (cols: number, rows: number) => void;
      onData: (cb: (data: string) => void) => void;
      onExit: (cb: (code: number) => void) => void;
    };
  }
}

const fontSize = parseInt(
  new URLSearchParams(window.location.search).get("font") || "14",
  10,
);

const term = new Terminal({
  fontSize,
  fontFamily: '"SF Mono", "Menlo", "Monaco", "Courier New", monospace',
  theme: {
    background: "#0d0d14",
    foreground: "#e0e0e0",
    cursor: "#f59e0b",
    cursorAccent: "#0d0d14",
    selectionBackground: "rgba(251, 146, 60, 0.3)",
    black: "#121f16",
    red: "#ff6b6b",
    green: "#51cf66",
    yellow: "#ffd43b",
    blue: "#74c0fc",
    magenta: "#cc5de8",
    cyan: "#66d9e8",
    white: "#e0e0e0",
    brightBlack: "#4a4a6a",
    brightRed: "#ff8787",
    brightGreen: "#69db7c",
    brightYellow: "#ffe066",
    brightBlue: "#91d5ff",
    brightMagenta: "#da77f2",
    brightCyan: "#99e9f2",
    brightWhite: "#ffffff",
  },
  cursorBlink: true,
  cursorStyle: "bar",
  scrollback: 10000,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

const container = document.getElementById("terminal")!;
term.open(container);
fitAddon.fit();

// Forward user input to pty
term.onData((data) => window.terminalAPI.write(data));

// Receive pty output
window.terminalAPI.onData((data) => term.write(data));

// Handle exit
window.terminalAPI.onExit((code) => {
  term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
});

// Resize
window.addEventListener("resize", () => {
  fitAddon.fit();
  window.terminalAPI.resize(term.cols, term.rows);
});

// Initial resize after DOM settles
requestAnimationFrame(() => {
  fitAddon.fit();
  window.terminalAPI.resize(term.cols, term.rows);
});
