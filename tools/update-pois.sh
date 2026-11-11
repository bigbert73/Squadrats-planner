#!/usr/bin/env bash
# Rebuild the local OSM layers from Geofabrik extracts:
#   data/pois.db     places along a route (shops, water, food, sights…)
#   data/reach.db    squadratinhos without any road or path
#   data/popular.db  cycle routes and cycleways for the "Popularne" mode
# Safe to run while the app is up: each import builds a new file and swaps it
# in; the backend notices and reopens it.
#
#   tools/update-pois.sh                                   # regions from data/osm/regions.txt
#   OSM_REGIONS="poland germany" tools/update-pois.sh      # or from the environment
#
# Regions are Geofabrik names, one per line in data/osm/regions.txt (default:
# poland). A plain name is looked up under europe/ ("netherlands"); anything
# with a slash is taken as it is ("north-america/us/colorado").
#
# Each region is filtered once and its results are kept in data/osm/cache/, so
# a weekly run only redoes what changed: the first region is checked for a
# newer extract on every run, the others every OSM_REFRESH_DAYS (28) days.
# The downloaded extract is deleted after use (OSM_KEEP_PBF=1 keeps it).
# "Popularne" is built for the first region only: its cell index is kept in
# memory and would not fit for half a continent; elsewhere that mode uses the
# worldwide GPS traces.
#
# osmium runs in Docker on at most OSM_CPUS (3) cores. On OpenShift the same
# script runs inside the squadrats-osm job with SQUADRATS_OSM_NATIVE=1: osmium
# and the importers run directly, no Docker.
#
# Keep the tag list in sync with POI_CATS in frontend/index.html.
set -euo pipefail
cd "$(dirname "$0")/.."

OSM=${OSM_DIR:-data/osm}
MIRROR=${OSM_MIRROR:-https://download.geofabrik.de}
REFRESH_DAYS=${OSM_REFRESH_DAYS:-28}
mkdir -p "$OSM/cache"

if [ -n "${OSM_REGIONS:-}" ]; then LIST=$OSM_REGIONS
elif [ -f "$OSM/regions.txt" ]; then LIST=$(sed 's/#.*//' "$OSM/regions.txt" | tr '\n' ' ')
else LIST=poland; fi
read -ra REGIONS <<<"$LIST"
[ "${#REGIONS[@]}" -gt 0 ] || REGIONS=(poland)

if [ "${SQUADRATS_OSM_NATIVE:-}" = 1 ]; then
  IN_OSM=$OSM
  IN_DATA=${DATA_DIR:-/app/data}
  osmium() { (cd "$OSM" && command osmium "$@"); }
  importer() { node "src/$1" "${@:2}"; }
else
  case $OSM in data/*) IN_OSM=/app/$OSM ;; *) echo "OSM_DIR must be under data/ (the folder the backend sees)" >&2; exit 1 ;; esac
  IN_DATA=${OSM_OUT:-/app/data}                    # as seen inside the container
  docker build -q -t squadrats-osmium tools/osmium >/dev/null
  osmium() { docker run --rm --cpus "${OSM_CPUS:-3}" --user "$(id -u):$(id -g)" -v "$PWD/$OSM:/data" squadrats-osmium "$@"; }
  # a container of its own (same image and folders as the backend), so that a
  # long import neither loads the running app nor dies when it is restarted
  importer() { docker compose run --rm --no-deps -T backend node "src/$1" "${@:2}" 2> >(grep -vE 'attribute .version. is obsolete|Container [^ ]+ +Creat' >&2); }
fi

log() { echo "[$(date '+%F %T')] $*"; }

# One region → data/osm/cache/<key>/{pois.geojsonseq,reach.db,timestamp,stamp}.
# Exit status: 0 rebuilt, 3 cache is up to date, anything else = failed.
build_region() {
  local key=$1 path=$2 primary=$3
  local dir=$OSM/cache/$key rel=cache/$key pbf=$OSM/$key-latest.osm.pbf url=$MIRROR/$path-latest.osm.pbf
  mkdir -p "$dir"
  local have=0
  [ -f "$dir/stamp" ] && [ -s "$dir/pois.geojsonseq" ] && [ -s "$dir/reach.db" ] && have=1

  if [ "$have" = 1 ]; then
    # a newer extract? (a .pbf left on disk is the newest one we have)
    local ref=$dir/stamp; [ -f "$pbf" ] && ref=$pbf
    if [ "$primary" = 1 ] || [ -n "$(find "$dir/stamp" -mtime +"$REFRESH_DAYS")" ]; then
      curl -fsSL --retry 3 -z "$ref" -o "$pbf.part" "$url"
    fi
    if [ -s "$pbf.part" ]; then mv "$pbf.part" "$pbf"; else rm -f "$pbf.part"; return 3; fi
  elif [ ! -f "$pbf" ]; then
    log "$key: downloading $url"
    curl -fsSL --retry 3 -o "$pbf.part" "$url"
    mv "$pbf.part" "$pbf"
  fi

  log "$key: places"
  osmium tags-filter -O -o "$rel/pois.osm.pbf" "$key-latest.osm.pbf" \
    nwr/amenity=restaurant,cafe,fast_food,bar,bakery,drinking_water,bicycle_repair_station,bicycle_rental,fuel \
    nwr/shop=supermarket,convenience,bakery,sports,bicycle \
    nwr/tourism=viewpoint,attraction,museum,artwork,hotel,motel,guest_house,hostel,apartment,chalet,camp_site,alpine_hut,wilderness_hut \
    nwr/historic=castle,monument,church
  osmium export -O -f geojsonseq -a type,id --format-option print_record_separator=false \
    -o "$rel/pois.new.geojsonseq" "$rel/pois.osm.pbf"
  osmium fileinfo -g header.option.osmosis_replication_timestamp "$key-latest.osm.pbf" >"$dir/timestamp.new" 2>/dev/null || true
  local ts; ts=$(cat "$dir/timestamp.new")

  if [ "$primary" = 1 ]; then
    # Cycling infrastructure for the "Popularne" planning mode: ways of signed
    # cycle routes, and cycleways / bicycle=designated ways.
    log "$key: cycle routes"
    osmium tags-filter -O -o "$rel/cycroutes.osm.pbf" "$key-latest.osm.pbf" r/route=bicycle
    osmium export -O -f geojsonseq --geometry-types=linestring --format-option print_record_separator=false \
      -o "$rel/cycroutes.geojsonseq" "$rel/cycroutes.osm.pbf"
    osmium tags-filter -O -o "$rel/cycways.osm.pbf" "$key-latest.osm.pbf" w/highway=cycleway w/bicycle=designated
    osmium export -O -f geojsonseq --geometry-types=linestring --format-option print_record_separator=false \
      -o "$rel/cycways.geojsonseq" "$rel/cycways.osm.pbf"
    importer popular-import.js "$IN_OSM/$rel/cycroutes.geojsonseq" "$IN_OSM/$rel/cycways.geojsonseq" "$IN_DATA/popular.db" "$ts"
    rm -f "$dir"/cycroutes.* "$dir"/cycways.*
  fi

  # Squadratinhos without any road or path: suggested as impossible to
  # collect. The extract's boundary tells where the data is complete.
  log "$key: roads"
  curl -fsSL --retry 3 -o "$dir/extract.poly" "$MIRROR/$path.poly"
  osmium tags-filter -O -o "$rel/highways.osm.pbf" "$key-latest.osm.pbf" w/highway
  osmium export -f geojsonseq --geometry-types=linestring --format-option print_record_separator=false \
    -o - "$rel/highways.osm.pbf" \
    | importer reach-import.js - "$IN_OSM/$rel/extract.poly" "$IN_OSM/$rel/reach.db" "$ts"

  mv -f "$dir/pois.new.geojsonseq" "$dir/pois.geojsonseq"
  mv -f "$dir/timestamp.new" "$dir/timestamp"
  touch -r "$pbf" "$dir/stamp"
  rm -f "$dir/pois.osm.pbf" "$dir/highways.osm.pbf"
  [ "${OSM_KEEP_PBF:-}" = 1 ] || rm -f "$pbf"
  return 0
}

changed=0 failed=0 primary=1 names="" pois="" reach=() ts=""
for r in "${REGIONS[@]}"; do
  case $r in */*) path=$r ;; *) path=europe/$r ;; esac
  key=${r//\//_}
  # a subshell, so that one region failing (set -e) does not stop the others
  set +e; ( set -e; build_region "$key" "$path" "$primary" ); rc=$?; set -e
  case $rc in
    0) changed=1 ;;
    3) ;;
    *) failed=1; log "$key: FAILED (status $rc)" ;;
  esac
  if [ -s "$OSM/cache/$key/pois.geojsonseq" ] && [ -s "$OSM/cache/$key/reach.db" ]; then
    names=${names:+$names,}$r
    pois=${pois:+$pois,}$IN_OSM/cache/$key/pois.geojsonseq
    reach+=("$IN_OSM/cache/$key/reach.db")
    [ -n "$ts" ] || ts=$(cat "$OSM/cache/$key/timestamp" 2>/dev/null || true)
  fi
  primary=0
done

[ -n "$names" ] || { log "no region could be built"; exit 1; }
if [ "$changed" = 1 ] || [ "$names" != "$(cat "$OSM/cache/built" 2>/dev/null || true)" ]; then
  importer poi-import.js "$pois" "$IN_DATA/pois.db" "$ts" "$names"
  importer reach-import.js --merge "$IN_DATA/reach.db" "$ts" "$names" "${reach[@]}"
  echo "$names" >"$OSM/cache/built"
  log "done: $names"
else
  log "up to date: $names"
fi
exit "$failed"
