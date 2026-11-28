#!/usr/bin/env bash
#
# Build (and optionally install) the Blinko Flatpak locally.
#
#   ./flatpak/build-local.sh              # use the latest published .deb
#   ./flatpak/build-local.sh 1.8.8        # use a specific released version
#   BLINKO_DEB=/path/to/x.deb ./flatpak/build-local.sh   # use a local build
#
# Requires: flatpak, curl.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$HERE")"
APP_ID="space.blinko.Blinko"
RUNTIME_VERSION="50"
MANIFEST="$HERE/$APP_ID.yml"

for tool in flatpak curl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: '$tool' is required but not installed" >&2
    exit 1
  }
done

# --- obtain a .deb -----------------------------------------------------------
if [[ -n "${BLINKO_DEB:-}" ]]; then
  echo "==> Using local .deb: $BLINKO_DEB"
  cp -- "$BLINKO_DEB" "$HERE/blinko.deb"
else
  VERSION="${1:-}"
  if [[ -z "$VERSION" ]]; then
    echo "==> Resolving latest release..."
    VERSION="$(curl -fsSL https://api.github.com/repos/blinkospace/blinko/releases/latest \
      | grep -m1 '"tag_name"' | cut -d'"' -f4)"
  fi
  VERSION="${VERSION#v}"
  URL="https://github.com/blinkospace/blinko/releases/download/${VERSION}/Blinko_${VERSION}_amd64.deb"
  echo "==> Downloading $URL"
  curl -fSL --progress-bar -o "$HERE/blinko.deb" "$URL"
fi

# --- toolchain ---------------------------------------------------------------
# org.flatpak.Builder is used rather than a distro flatpak-builder so this
# matches CI exactly. Older flatpak-builder releases call `appstream-compose`,
# which current GNOME SDKs no longer ship.
echo "==> Ensuring builder, GNOME $RUNTIME_VERSION runtime and SDK are present"
flatpak remote-add --if-not-exists --user \
  flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y --noninteractive flathub org.flatpak.Builder \
  "org.gnome.Platform//$RUNTIME_VERSION" "org.gnome.Sdk//$RUNTIME_VERSION"

# --- build -------------------------------------------------------------------
cd "$REPO_ROOT"
echo "==> Building $APP_ID"
flatpak run org.flatpak.Builder --user --force-clean --disable-rofiles-fuse \
  --repo=flatpak-repo flatpak-build "$MANIFEST"

BUNDLE="Blinko_local_x86_64.flatpak"
flatpak build-bundle flatpak-repo "$BUNDLE" "$APP_ID" \
  --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo

echo
echo "==> Built $BUNDLE"
echo "    Install with: flatpak install --user -y $BUNDLE"
echo "    Run with:     flatpak run $APP_ID"
