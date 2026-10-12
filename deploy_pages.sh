#!/bin/bash
# Publish the guest page to Cloudflare (photos.<domain>), as a static-assets Worker.
# Reads PUBLIC_API_BASE and PUBLIC_IMG_BASE from cloud.env.
# First time only: `npx wrangler login` (opens a browser to authorise).
set -euo pipefail
cd "$(dirname "$0")"
eval "$(grep -E '^(PUBLIC_API_BASE|PUBLIC_IMG_BASE|PAGES_PROJECT)=' cloud.env | tr -d '\r')"
: "${PUBLIC_API_BASE:?set PUBLIC_API_BASE in cloud.env (e.g. https://api.example.com)}"
: "${PUBLIC_IMG_BASE:?set PUBLIC_IMG_BASE in cloud.env (e.g. https://img.example.com)}"
PROJECT="${PAGES_PROJECT:-event-photos}"

rm -rf dist && mkdir -p dist/static/vendor
cp static/style.css static/app.js dist/static/
cp static/vendor/pica.min.js dist/static/vendor/
mkdir -p dist/static/brand/icons && cp static/brand/*.jpg static/brand/*.png dist/static/brand/ && cp static/brand/icons/*.png dist/static/brand/icons/
printf 'window.EVENT = { api: "%s", api2: "", imgBase: "%s" };\n' "$PUBLIC_API_BASE" "$PUBLIC_IMG_BASE" > dist/static/config.js
# Fingerprint every asset (?v=<content hash>) so a phone never mixes a new page
# with old cached CSS/JS. Assets can then be cached for a year.
cp static/index.html dist/index.html
for f in static/style.css static/app.js static/config.js static/vendor/pica.min.js; do
  h=$(shasum "dist/$f" | cut -c1-10)
  sed -i '' "s|/$f\"|/$f?v=$h\"|" dist/index.html
done
cat > dist/_headers <<'EOF'
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(self)
/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/static/*
  Cache-Control: public, max-age=31536000, immutable
EOF

# Static-assets Worker (Cloudflare's current home for Pages-style sites); see wrangler.jsonc.
npx --yes wrangler@4 deploy
