#!/usr/bin/env bash
#
# Regenerate the README screenshots (assets/*.png) from demo data.
#
# disk-solve's demo mode is pure, fabricated data (see makeDemoTree in
# src/lib/demo.ts) that renders whenever the UI runs outside Tauri - i.e. in a
# plain browser. So, unlike the-wall (whose demo needs live shells and must
# capture the native app), we build the frontend, serve it with `vite preview`,
# and screenshot it with headless Chrome. Nothing here ever touches a real disk,
# and no Screen Recording permission is needed.
#
# Each shot is post-processed with ImageMagick to look like a macOS window:
# faux traffic lights (the real ones are an OS overlay we don't have here),
# rounded corners, and a soft drop shadow.
#
# Usage: npm run screenshot   (or: bash scripts/screenshot.sh)

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO/assets"
PORT=4319
SCALE=2                 # device pixel ratio: 2 = crisp retina output
W=1240; H=812           # logical window size (matches tauri.conf.json defaults)
RENDER_MS=3000          # settle time for React to mount + the demo to render

cd "$REPO"
mkdir -p "$OUT_DIR"

# Locate a Chrome/Chromium binary.
CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    [ -x "$c" ] && CHROME="$c" && break
  done
fi
[ -n "$CHROME" ] || { echo "error: no Chrome/Chromium found (set \$CHROME)." >&2; exit 1; }
command -v magick >/dev/null || { echo "error: ImageMagick (magick) not found - 'brew install imagemagick'." >&2; exit 1; }

WORKDIR="$(mktemp -d -t disk-solve-shot)"
PREVIEW_PID=""
cleanup() {
  [ -n "$PREVIEW_PID" ] && kill "$PREVIEW_PID" 2>/dev/null || true
  # vite preview can outlive its parent; reap it by port, but only if it's ours.
  for pid in $(lsof -ti "tcp:$PORT" 2>/dev/null); do
    ps -o command= -p "$pid" 2>/dev/null | grep -q "disk-solve/node_modules" && kill "$pid" 2>/dev/null || true
  done
  rm -rf "$WORKDIR" || true
}
trap cleanup EXIT

echo "Building the frontend..."
npm run build >"$WORKDIR/build.log" 2>&1 || { echo "error: build failed - see $WORKDIR/build.log" >&2; cat "$WORKDIR/build.log" >&2; exit 1; }

echo "Serving on :$PORT..."
npx vite preview --port "$PORT" --strictPort >"$WORKDIR/preview.log" 2>&1 &
PREVIEW_PID=$!
for ((i = 0; i < 40; i++)); do
  curl -sf "http://localhost:$PORT/" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://localhost:$PORT/" >/dev/null 2>&1 || { echo "error: preview server never came up - see $WORKDIR/preview.log" >&2; exit 1; }

# Add faux macOS traffic lights, round the corners, and drop a soft shadow.
# The app reserves 84px of title-bar padding for the (real, native) lights, so
# the dots land in empty space here. Geometry is in device pixels (x$SCALE).
dress() { # raw.png -> out.png
  local raw="$1" out="$2"
  local r=$((10 * SCALE))          # corner radius
  local cy=$((24 * SCALE))         # title-bar vertical centre (48px bar)
  local cx=$((30 * SCALE)) gap=$((20 * SCALE)) dot=$((6 * SCALE))
  local pw ph
  pw=$(magick identify -format "%w" "$raw"); ph=$(magick identify -format "%h" "$raw")
  magick "$raw" \
    -fill "#ff5f57" -draw "circle $cx,$cy $((cx + dot)),$cy" \
    -fill "#febc2e" -draw "circle $((cx + gap)),$cy $((cx + gap + dot)),$cy" \
    -fill "#28c840" -draw "circle $((cx + 2 * gap)),$cy $((cx + 2 * gap + dot)),$cy" \
    \( -size "${pw}x${ph}" xc:none -draw "roundrectangle 0,0,$((pw - 1)),$((ph - 1)),$r,$r" \) \
    -alpha set -compose DstIn -composite \
    \( +clone -background black -shadow 55x$((12 * SCALE))+0+$((7 * SCALE)) \) \
    +swap -background none -compose Over -layers merge +repage \
    -bordercolor none -border $((10 * SCALE)) \
    -strip "$out"
}

shoot() { # url-hash out-name label
  local hash="$1" name="$2" label="$3"
  local raw="$WORKDIR/$name.raw.png" log="$WORKDIR/$name.cap.log"
  echo "Capturing $label -> assets/$name.png"
  # Capture over CDP with an emulated viewport (see scripts/capture.mjs) so the
  # page lays out into exactly the captured size — a plain --screenshot leaves an
  # empty strip below the content because the layout viewport is shorter than the
  # OS window by the platform frame height.
  if ! node "$REPO/scripts/capture.mjs" "$CHROME" "http://localhost:$PORT/$hash" "$raw" "$W" "$H" "$SCALE" "$RENDER_MS" >"$log" 2>&1; then
    echo "error: capture failed for $label - see $log" >&2; cat "$log" >&2; exit 1
  fi
  [ -s "$raw" ] || { echo "error: capture produced no image for $label" >&2; exit 1; }
  dress "$raw" "$OUT_DIR/$name.png"
}

shoot "" "disk-solve" "treemap"
shoot "#filter=node_modules" "list-view" "reclaim list"
shoot "#dups" "duplicates" "duplicates"
# "Get organized" flow — demo deep links seed each screen (see SortFlow.tsx).
shoot "#sort" "get-organized" "get organized overview"
shoot "#sort-locations" "filing-locations" "filing locations"
shoot "#sort-review" "sort-reviewer" "sort reviewer"
shoot "#sort-done" "sort-summary" "sort summary"

echo "Done:"
for f in disk-solve list-view duplicates get-organized filing-locations sort-reviewer sort-summary; do
  magick identify -format "  assets/%f  %wx%h\n" "$OUT_DIR/$f.png"
done
