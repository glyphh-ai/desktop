# A Glyphh app

A Next.js static-export project with a `manifest.json` and a server-side
`worker.js`. Built into a bundle (`manifest.json` + `ui/` + `worker.js`),
deployed as a versioned release, served by the Glyphh app server; its tools
land in the agent's toolbox.

```
manifest.json     kind, manifestVersion 3, name, slug, description, capabilities, connectors, tools, worker, window
package.json      next + react; scripts.build = "next build"
next.config.mjs   output: 'export', trailingSlash: true, basePath from GLYPHH_APP_BASE
app/              the Next.js app router
worker.js         handlers behind the tools (glyphh.handle) and cron
```

- The page talks to the host only through `window.glyphh.call(capability, args)`
  → `{ ok, result } | { ok: false, error }`.
- `db.exec` is Postgres in the app's own schema: `$1` params, one statement per
  call, `CREATE TABLE IF NOT EXISTS` on first use.
- The page and the worker share the database, not code: the page reads and
  writes with `db.exec`; the worker's handlers back the agent's tools.

Build locally with `npm install && npm run build`. Deploy from a Code session
with `app_deploy { slug }`; roll back with `app_pin { app, n }`.
