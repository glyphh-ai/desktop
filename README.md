# Glyphh

Glyphh is a desktop AI workspace: a multi-panel app where every panel is a live
web app or tool, driven by an agent loop you talk to. It runs entirely on your
machine, on your own model provider keys. There is no account and no server.

## Install and run

Glyphh is distributed only through npm. It needs Node.js 20 or newer and runs on
macOS, Windows and Linux.

```bash
npm install -g @glyphh-ai/desktop --allow-scripts=@glyphh-ai/desktop,better-sqlite3,node-pty,kuzu,ffmpeg-static,protobufjs
glyphh            # the agent in this terminal (glyphh --help for its flags)
glyphh desktop    # the desktop app
```

Both run the same agent loop on the same local data, so a chat started in
one opens in the other (`glyphh --resume <id>`, `glyphh --continue`).

Keep `--allow-scripts`: npm 12 blocks install scripts unless they are named, and Glyphh needs them to download
Electron and prepare its native modules (better-sqlite3, node-pty, kuzu). Older npm ignores the flag.

### Linux

The terminal module (node-pty) is built on install on Linux, so first install the build tools, then Glyphh:

```bash
sudo apt install -y build-essential python3
sudo npm install -g @glyphh-ai/desktop --allow-scripts=@glyphh-ai/desktop,better-sqlite3,node-pty,kuzu,ffmpeg-static,protobufjs
glyphh desktop
```

Installed with `sudo`, Chromium's sandbox is set up for you. Installed without it (nvm, a user prefix) on Ubuntu 23.10
or later, where user namespaces are restricted, `glyphh desktop` runs without the sandbox and says so, with the two
commands that turn it back on.

## Your model key

The agent calls Anthropic directly with your own API key. Set it in the
environment before you start Glyphh:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

or save it in `~/.glyphh/users/local/provider-keys.json` as
`{ "anthropic": "sk-ant-..." }`.

## Where your data lives

Everything is stored under `~/.glyphh/users/local/`: preferences, chats,
memory (embedded on this machine, no model download) and app data.

## Develop

```bash
npm install
npm run dev
```

`npm install` builds the bundled SDK (`packages/glyphh-sdk`) and rebuilds the
native modules for Electron. `npm test` runs the test suite.

## Contributing

Changes come in only by pull request; releases are made by Glyphh maintainers.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
