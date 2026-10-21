# Glyphh

Glyphh is a desktop AI workspace: a multi-panel app where every panel is a live
web app or tool, driven by an agent loop you talk to. It runs entirely on your
machine, on your own model provider keys. There is no account and no server.

## Install and run

Glyphh is distributed only through npm. It needs Node.js 20 or newer and runs on
macOS, Windows and Linux.

```bash
npm install -g @glyphh-ai/desktop
glyphh            # the agent in this terminal (glyphh --help for its flags)
glyphh desktop    # the desktop app
```

Both run the same agent loop on the same local data, so a chat started in
one opens in the other (`glyphh --resume <id>`, `glyphh --continue`).

Glyphh runs on Electron and uses native modules (better-sqlite3, node-pty,
kuzu), so it needs its install scripts. If your npm blocks install scripts,
allow them for this install:

```bash
npm install -g @glyphh-ai/desktop --allow-scripts=@glyphh-ai/desktop,electron,better-sqlite3,node-pty,kuzu
```

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
