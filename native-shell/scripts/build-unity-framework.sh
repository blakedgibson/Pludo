#!/usr/bin/env bash
# Turns Unity's iOS export into unity/builds/ios/UnityFramework.xcframework,
# which @azesmway/react-native-unity vendors into the app.
#
#   1. In Unity: Pludo ▸ Native Shell ▸ Export iOS (Simulator) [and/or (Device)]
#   2. npm run unity:framework
#   3. cd ios && pod install   (or npx expo run:ios, which runs it)
#
# Builds every export that exists (simulator, device) and packs the slices into
# one XCFramework, so the same app runs in the Simulator and on a phone.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNITY_DIR="$ROOT/unity"
OUT="$UNITY_DIR/builds/ios/UnityFramework.xcframework"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

args=()
build_slice() {
  local export_dir="$1" sdk="$2" config_dir="$3" archs="$4"
  [ -d "$export_dir/Unity-iPhone.xcodeproj" ] || return 0
  echo "▸ Building UnityFramework for $sdk from $export_dir"
  xcodebuild -project "$export_dir/Unity-iPhone.xcodeproj" -scheme UnityFramework \
    -configuration Release -sdk "$sdk" BUILD_DIR="$export_dir/build" \
    ARCHS="$archs" ONLY_ACTIVE_ARCH=NO \
    ENABLE_USER_SCRIPT_SANDBOXING=NO ENABLE_MODULE_VERIFIER=NO \
    CODE_SIGNING_ALLOWED=NO build -quiet
  args+=(-framework "$export_dir/build/$config_dir/UnityFramework.framework")
}

# Xcode's user-script sandbox blocks IL2CPP's run-script phase from loading its
# own .NET host (libhostfxr.dylib), and Xcode 27's module verifier rejects
# Unity's stock framework headers, so both are disabled above. Simulator slice is
# arm64 only (Apple Silicon Macs).
[ -d "$UNITY_DIR/export-ios-simulator" ] && "$ROOT/scripts/retag-for-simulator.sh" "$UNITY_DIR/export-ios-simulator"
build_slice "$UNITY_DIR/export-ios-simulator" iphonesimulator Release-iphonesimulator arm64
build_slice "$UNITY_DIR/export-ios-device"    iphoneos        Release-iphoneos        arm64

if [ ${#args[@]} -eq 0 ]; then
  echo "No Unity export found in $UNITY_DIR (run Pludo ▸ Native Shell ▸ Export iOS first)." >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
xcodebuild -create-xcframework "${args[@]}" -output "$OUT"
echo "✓ $OUT"

# CocoaPods copies the framework into the react-native-unity package only on a
# fresh install (podspec prepare_command), so refresh that copy directly —
# otherwise rebuilds keep linking the first framework ever installed.
PKG_COPY="$ROOT/node_modules/@azesmway/react-native-unity/ios/UnityFramework.xcframework"
if [ -d "$(dirname "$PKG_COPY")" ]; then
  rm -rf "$PKG_COPY"
  cp -R "$OUT" "$PKG_COPY"
  echo "✓ refreshed $PKG_COPY"
fi
