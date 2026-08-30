#!/usr/bin/env bash
#
# The app icon, from the logo — so there is one drawing of the duck and the icon is
# derived rather than drawn again.
#
# Two things the logo cannot be as it stands. It is 43.11 × 33.2, and an icon is
# square; and it has a transparent background, which App Store Connect rejects. So
# this wraps it: a square canvas, an opaque ground, the duck centred at 73% width,
# and no rounded corners — iOS applies the mask itself, and baking one in shows as a
# dark fringe against the real one.
#
#   ./scripts/app-icon.sh          rewrite app/DuckTalk/Assets.xcassets
#
# Needs `brew install librsvg`.

set -euo pipefail
cd "$(dirname "$0")/.."

LOGO=assets/duck_talk_logo.svg
SET=app/DuckTalk/Assets.xcassets/AppIcon.appiconset
# Dark, and not a free choice: the duck's head is #f9fafb and its eye is a hole, so
# the ground is what the eye is drawn in. On white the head vanishes; on the brand
# orange the tail does, because the tail is that same orange. Slate leaves all three
# — white head, dark eye, orange tail — and reads at 60 px.
GROUND='#1F2937'
SIDE=60          # canvas units; the logo's own coordinates are kept, then centred in this
FILL=0.73        # how much of the width the duck takes

command -v rsvg-convert >/dev/null || { echo 'need rsvg-convert: brew install librsvg' >&2; exit 1; }

mkdir -p "$SET"
square="$(mktemp -d)/icon.svg"

python3 - "$LOGO" "$square" "$GROUND" "$SIDE" "$FILL" <<'PY'
import re, sys

logo, out, ground, side, fill = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5])
svg = open(logo).read()

# The logo's own coordinate system, and its drawing — everything the root <svg> holds.
w, h = (float(n) for n in re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg).groups()[:2])
body = re.search(r'<svg[^>]*>(.*)</svg>', svg, re.S).group(1)

# Fit by width, since the duck is wider than it is tall, then centre what is left.
scale = side * fill / w
tx, ty = (side - w * scale) / 2, (side - h * scale) / 2

open(out, 'w').write(
    f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
    f'viewBox="0 0 {side} {side}">'
    f'<rect width="{side}" height="{side}" fill="{ground}"/>'
    f'<g transform="translate({tx:.4f},{ty:.4f}) scale({scale:.6f})">{body}</g>'
    f'</svg>'
)
PY

rsvg-convert -w 1024 -h 1024 -b "$GROUND" "$square" -o "$SET/icon-1024.png"
rm -f "$square"

# One 1024 image is the whole set on iOS 17 — Xcode derives every other size from it.
cat > "$SET/Contents.json" <<'JSON'
{
  "images" : [
    {
      "filename" : "icon-1024.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
JSON

# Opaque or App Store Connect refuses it, and the check is one line, so make it.
if sips -g hasAlpha "$SET/icon-1024.png" | grep -q 'hasAlpha: yes'; then
  echo 'the icon still has an alpha channel — App Store Connect will reject it' >&2
  exit 1
fi
sips -g pixelWidth -g pixelHeight -g hasAlpha "$SET/icon-1024.png" | tail -3
echo "wrote $SET/icon-1024.png"
