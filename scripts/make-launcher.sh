#!/bin/bash
# Builds (or rebuilds) the "AI Command Centre" launcher on the Desktop.
#
# The bundle is a thin shim: all launch logic lives in scripts/launch.sh, which
# is version-controlled. Rerun this after moving the project.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$HOME/Desktop/AI Command Centre.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Generating icon…"
node "$PROJECT_ROOT/scripts/make-icon.mjs" "$WORK/icon.png"

ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$WORK/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$WORK/icon.png" \
    --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$WORK/icon.icns"

echo "Building bundle…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/icon.icns" "$APP/Contents/Resources/icon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>AI Command Centre</string>
  <key>CFBundleDisplayName</key><string>AI Command Centre</string>
  <key>CFBundleIdentifier</key><string>local.aicommandcentre.launcher</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/launcher" <<SHIM
#!/bin/bash
PROJECT="$PROJECT_ROOT"
if [ ! -x "\$PROJECT/scripts/launch.sh" ]; then
  osascript -e 'display dialog "AI Command Centre is no longer where this shortcut expects it. Rebuild it with: npm run make-launcher" with title "AI Command Centre" buttons {"OK"} default button 1 with icon caution'
  exit 1
fi
# Homebrew and node live outside the PATH Finder hands to a bundle.
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
exec "\$PROJECT/scripts/launch.sh"
SHIM

chmod +x "$APP/Contents/MacOS/launcher"
touch "$APP"

echo "Done: $APP"
