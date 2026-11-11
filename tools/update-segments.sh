#!/usr/bin/env bash
# Download or refresh BRouter routing data: one .rd5 file per 5°×5° tile,
# named after its south-west corner (E5_N50 = 5–10°E, 50–55°N). Where these
# files are, routes can be planned; the backend reads the list at start-up and
# tells the app (GET /api/coverage).
#
#   tools/update-segments.sh                               # Europe (default)
#   SEGMENTS_BBOX="-10 35 5 45" tools/update-segments.sh   # W S E N, degrees
#
# Files are fetched only when the server has a newer one, into a side folder,
# and moved in together at the end, so the tiles always come from one build
# (roads cross tile borders). BRouter keeps files open: it is restarted when
# something changed (SEGMENTS_RESTART=0 to skip).
set -euo pipefail
cd "$(dirname "$0")/.."

DIR=${SEGMENTS_DIR:-data/brouter-segments}
BASE=${SEGMENTS_URL:-https://brouter.de/brouter/segments4}
read -r W S E N <<<"${SEGMENTS_BBOX:--25 35 35 72}"
PART=$DIR/.part
mkdir -p "$PART"

floor5() { local v=$1; echo $(( v >= 0 ? v / 5 * 5 : -(( -v + 4 ) / 5 * 5) )); }
name() { # lon lat of the south-west corner
  local lon=$1 lat=$2 a b
  [ "$lon" -ge 0 ] && a="E$lon" || a="W$(( -lon ))"
  [ "$lat" -ge 0 ] && b="N$lat" || b="S$(( -lat ))"
  echo "${a}_${b}.rd5"
}

changed=0 kept=0 sea=0
for (( lon = $(floor5 "$W"); lon < E; lon += 5 )); do
  for (( lat = $(floor5 "$S"); lat < N; lat += 5 )); do
    f=$(name "$lon" "$lat")
    args=(-sS --retry 3 --retry-delay 5 -o "$PART/$f" -w '%{http_code}')
    [ -f "$DIR/$f" ] && args+=(-z "$DIR/$f")
    code=$(curl "${args[@]}" "$BASE/$f" || echo 000)
    case $code in
      200) changed=$(( changed + 1 )) ;;
      304) rm -f "$PART/$f"; kept=$(( kept + 1 )) ;;
      404) rm -f "$PART/$f"; sea=$(( sea + 1 )) ;;          # open sea: no such tile
      *)   echo "segments: $f failed (HTTP $code), nothing installed" >&2; rm -rf "$PART"; exit 1 ;;
    esac
  done
done

if [ "$changed" -gt 0 ]; then
  # an .rd5 file starts with a table of 8-byte offsets: anything tiny is an error page
  for f in "$PART"/*.rd5; do
    [ "$(stat -c %s "$f")" -ge 1024 ] || { echo "segments: $f looks broken, nothing installed" >&2; rm -rf "$PART"; exit 1; }
  done
  mv -f "$PART"/*.rd5 "$DIR"/
  if [ "${SEGMENTS_RESTART:-1}" = 1 ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx squadrats-brouter; then
    docker restart squadrats-brouter >/dev/null
    docker restart squadrats-backend >/dev/null   # re-reads the coverage list
  fi
fi
rmdir "$PART" 2>/dev/null || true
echo "segments: $changed downloaded, $kept up to date, $sea not on the server ($(date -Iseconds)); $(ls "$DIR"/*.rd5 | wc -l) tiles, $(du -sh "$DIR" | cut -f1)"
