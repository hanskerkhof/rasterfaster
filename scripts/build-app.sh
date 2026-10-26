#!/usr/bin/env bash
# Builds dist/Rasterfaster Server.app: the Angular app, then a PyInstaller bundle with the API, Python and the frontend inside.
# Usage: scripts/build-app.sh [--install]    (--install copies the app to /Applications)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
venv="$root/backend/.venv-app"

if [ ! -x "$venv/bin/python" ]; then
  /opt/homebrew/bin/python3.13 -m venv "$venv"
fi
"$venv/bin/pip" install -q -r "$root/backend/requirements-app.txt"

(cd "$root/frontend/3d-tool" && npm run build)

# icon: 1024-less iconset from the 512 px PWA icon
iconset="$root/backend/Rasterfaster.iconset"
rm -rf "$iconset" && mkdir -p "$iconset"
source="$root/frontend/3d-tool/public/icons/icon-512x512-v1.png"
for size in 16 32 128 256 512; do
  sips -z $size $size "$source" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$source" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$root/backend/Rasterfaster.icns"
rm -rf "$iconset"

cd "$root/backend"
"$venv/bin/pyinstaller" --noconfirm --clean --distpath "$root/dist" --workpath "$root/backend/build" rasterfaster.spec
echo "Built $root/dist/Rasterfaster Server.app"

if [ "${1:-}" = "--install" ]; then
  rm -rf /Applications/Rasterfaster.app "/Applications/Rasterfaster Server.app"   # the first version of the app was called Rasterfaster.app
  cp -R "$root/dist/Rasterfaster Server.app" /Applications/
  echo "Installed to /Applications/Rasterfaster Server.app"
fi
