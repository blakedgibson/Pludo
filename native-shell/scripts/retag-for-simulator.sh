#!/usr/bin/env bash
# Some third-party plugins in Pludo ship arm64 *device* static libraries only
# (Photon Fusion's libnanosockets, ReactUnity's libyoga and libquickjs). The
# arm64 machine code is identical on Apple Silicon simulators; only the Mach-O
# platform tag differs. This rewrites that tag to iOS Simulator (platform 7) in
# the SIMULATOR export's copies — Assets/ and device exports are never touched.
#
# Usage: retag-for-simulator.sh <unity simulator export dir>
set -euo pipefail
EXPORT="$1"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
MINOS=15.0
SDK=$(xcrun --sdk iphonesimulator --show-sdk-version)

retag_archive() {
  local lib; lib="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
  # Already a simulator library? Leave it.
  if xcrun otool -l "$lib" 2>/dev/null | grep -A3 LC_BUILD_VERSION | grep -q "platform 7"; then return; fi
  echo "▸ retagging $lib for the iOS Simulator"
  local work; work="$(mktemp -d)"
  local thin="$work/thin.a"
  if lipo -archs "$lib" | grep -qw arm64 && [ "$(lipo -archs "$lib")" != "arm64" ]; then
    lipo "$lib" -thin arm64 -output "$thin"
  else
    cp "$lib" "$thin"
  fi
  (cd "$work" && mkdir objs && cd objs && ar x ../thin.a)
  for o in "$work"/objs/*.o; do
    if file "$o" | grep -q "LLVM bitcode"; then
      # Bitcode (eg. QuickJS): recompile it for the simulator triple instead.
      xcrun --sdk iphonesimulator clang -c -target "arm64-apple-ios$MINOS-simulator" \
        -Wno-override-module -x ir "$o" -o "$o.sim.o" && mv "$o.sim.o" "$o"
    else
      # Old objects (LC_VERSION_MIN_IPHONEOS, no header padding) can't grow a
      # LC_BUILD_VERSION; drop the platform tag instead — ld then assumes the
      # platform it is linking for.
      xcrun vtool -arch arm64 -set-build-version 7 "$MINOS" "$SDK" -replace -output "$o" "$o" 2>/dev/null \
        || xcrun vtool -arch arm64 -remove-build-version ios -output "$o" "$o"
    fi
  done
  rm -f "$lib"
  (cd "$work/objs" && ar rcs "$lib" ./*.o)
  rm -rf "$work"
}

while IFS= read -r lib; do
  retag_archive "$lib"
done < <(find "$EXPORT/Libraries" -path '*/iOS/*.a' -type f)
