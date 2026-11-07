#!/usr/bin/env bash
# Compila Pasalo web y la deja en server/public/app, que Vercel sirve tal
# cual junto al server de conexión (en /app/). Ver web/README.md.
#
# Necesita rustup con el target wasm32-unknown-unknown, wasm-bindgen-cli de
# la misma versión que el crate wasm-bindgen de Cargo.lock y un clang con
# soporte de WASM (el de Apple no lo trae: brew install llvm).
set -euo pipefail

WEB="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$WEB")"
OUT="$ROOT/server/public/app"
UI="$ROOT/app/ui"

export PATH="$HOME/.cargo/bin:$PATH"
LLVM="${LLVM:-$(brew --prefix llvm 2>/dev/null || echo /usr/local/opt/llvm)}"
export CC_wasm32_unknown_unknown="${CC_wasm32_unknown_unknown:-$LLVM/bin/clang}"
export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-$LLVM/bin/llvm-ar}"

cd "$WEB"
cargo build --target wasm32-unknown-unknown --release
PKG="$WEB/target/pkg"
rm -rf "$PKG"
wasm-bindgen --target web --no-typescript --out-dir "$PKG" target/wasm32-unknown-unknown/release/pasalo_web.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -Os --enable-bulk-memory --enable-nontrapping-float-to-int -o "$PKG/pasalo_web_bg.wasm" "$PKG/pasalo_web_bg.wasm"
fi

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -1)"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$UI/." "$OUT/"
cp "$WEB/js/tauri.js" "$OUT/js/lib/tauri.js"
mkdir -p "$OUT/js/web"
cp -R "$WEB/js/backend" "$OUT/js/web/backend"
cp "$WEB/js/web-ui.js" "$OUT/js/web/web-ui.js"
cp -R "$PKG" "$OUT/js/web/pkg"
cp "$WEB/static/web.css" "$OUT/styles/web.css"
cp "$WEB/static/manifest.webmanifest" "$OUT/"
cp -R "$WEB/static/icons" "$OUT/icons"
find "$OUT" -name .DS_Store -delete

python3 - "$OUT" "$VERSION" "$WEB/static/sw.js" <<'EOF'
import hashlib, json, os, sys

out, version, sw = sys.argv[1:4]

def patch(path, old, new):
    with open(path) as f:
        text = f.read()
    if old not in text:
        sys.exit(f"build: no se encontró en {path}: {old!r}")
    with open(path, 'w') as f:
        f.write(text.replace(old, new, 1))

head = '''  <link rel="manifest" href="manifest.webmanifest">
  <link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
  <link rel="icon" href="icons/icon-192.png">
  <meta name="theme-color" content="#2f6bff">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Pasalo">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <link rel="stylesheet" href="styles/web.css">
</head>'''
patch(os.path.join(out, 'index.html'), '</head>', head)
# Los modelos del desenfoque, relativos a la app (en la web no está en la raíz).
blur = os.path.join(out, 'js/features/blur.js')
if os.path.exists(blur):
    patch(blur, "const BASE = '/vendor/mediapipe';", "const BASE = new URL('../../vendor/mediapipe', import.meta.url).href;")

# Archivos que el service worker guarda al instalarse (sin los modelos del
# desenfoque, que pesan y solo se bajan si se usa).
files, digest = [], hashlib.sha256()
for base, dirs, names in os.walk(out):
    dirs.sort()
    for name in sorted(names):
        path = os.path.join(base, name)
        rel = os.path.relpath(path, out)
        with open(path, 'rb') as f:
            digest.update(rel.encode() + f.read())
        if not rel.startswith('vendor/'):
            files.append(rel)
build = digest.hexdigest()[:12]

with open(os.path.join(out, 'js/web/version.js'), 'w') as f:
    f.write(f"// Lo escribe web/build.sh.\nexport const VERSION = {json.dumps(version)};\nexport const BUILD = {json.dumps(build)};\n")
files.append('js/web/version.js')
with open(sw) as f:
    text = f.read()
text = text.replace("'__BUILD__'", json.dumps(build)).replace('__FILES__', json.dumps(['./'] + sorted(files)))
with open(os.path.join(out, 'sw.js'), 'w') as f:
    f.write(text)
print(f"Pasalo web {version} ({build}): {out}")
EOF
du -sh "$OUT"
