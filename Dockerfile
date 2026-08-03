# app-web on Fly — the WEB TARGET ONLY (glyphh-ai-app / future app.glyphh.ai).
#
# Deploys go through GitHub Actions (.github/workflows/deploy-web.yml) — never a
# local `fly deploy`. The workflow vendors the `file:../sdk` dependency into
# .sdk-vendor/ (package.json + built dist) before `flyctl deploy`, because the
# sibling ../sdk checkout doesn't exist inside the Docker build context. A local
# `docker build` without that vendor step fails on the COPY below — expected.
#
# Runtime is a static server: `node web/serve.mjs` serves prebuilt dist/renderer,
# injecting window.__GLYPHH_* config (from env — fly.toml [env]) + the SDK bridge
# into HTML. No web/.env in the image; process.env wins in serve.mjs.

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /work/app

# Rewire the lockfile's `@glyphh/sdk: file:../sdk` link — placed at /work/sdk so
# the relative path resolves exactly as it does on a dev machine.
COPY .sdk-vendor/package.json /work/sdk/package.json
COPY .sdk-vendor/dist /work/sdk/dist

COPY package.json package-lock.json ./
# --ignore-scripts: skips the electron-rebuild postinstall (native desktop-only
# toolchain). esbuild/tsc/shx need no install scripts; esbuild's linux binary
# arrives via optionalDependencies.
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build:web

# ── run ───────────────────────────────────────────────────────────────────────
# Lean: only serve.mjs + the built renderer. serve.mjs resolves ../dist/renderer
# relative to web/, so the /app/web + /app/dist/renderer layout is load-bearing.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3002

COPY --from=build /work/app/web/serve.mjs ./web/serve.mjs
COPY --from=build /work/app/dist/renderer ./dist/renderer

EXPOSE 3002
USER node
CMD ["node", "web/serve.mjs"]
