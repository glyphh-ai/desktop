# Glyphh

Glyphh is a desktop AI workspace — a multi-panel Electron app where every panel is a
live web app or tool, all driven by an agent you talk to with `.yo` commands
(`.yo`, `.sup`, `.dip`, `.drip`).

## Prerequisites

- Node.js 20+
- macOS or Windows (native modules are rebuilt for Electron during install)
- An Anthropic API key (bring your own — pasted into the app on first run)

## Setup

```bash
npm install        # postinstall runs electron-rebuild for native modules
                   # (better-sqlite3, node-pty, onnxruntime-node, …)
```

## Run (development)

```bash
npm run dev        # builds main + renderer bundles, then launches Electron
```

## Build & package

```bash
npm run build          # compile/bundle everything into dist/
npm run package:mac    # signed + notarized .dmg / .zip  (needs signing secrets)
npm run package:win    # Windows installer
```

Release builds are normally produced by CI (`.github/workflows/build.yml`) on a
`v*` tag and published to the public **glyphh-ai/glyphh-releases** repo.

## Configuration

- Backend defaults to `https://api.glyphh.ai`; override with `YO_AUTH_SERVER`
  (and `YO_PLATFORM_URL`) to point at a different/self-hosted server.
- Local app data lives under `~/.glyphh/`.

---

> _Formerly **.yo** — this app was rebranded to Glyphh._
