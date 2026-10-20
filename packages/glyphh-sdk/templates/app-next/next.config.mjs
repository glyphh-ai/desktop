// The Glyphh app server serves the static export under /app-host/<key>/ui/.
// The builder sets GLYPHH_APP_BASE to that path; a bundle built without one
// (the hub's default apps) loads its assets relative to ui/ (root page only).
const base = process.env.GLYPHH_APP_BASE ?? "";

/** @type {import('next').NextConfig} */
export default {
  output: "export",
  trailingSlash: true,
  basePath: base,
  assetPrefix: base || ".",
  images: { unoptimized: true },
};
