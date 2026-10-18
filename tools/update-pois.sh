#!/usr/bin/env bash
# Rebuild the local POI database (data/pois.db) and the cycling-network index
# (data/popular.db) from the Geofabrik extract of Poland. Safe to run while
# the app is up: each import builds a new file and swaps it in; the backend
# notices and reopens it.
#
#   tools/update-pois.sh            # download if newer, filter, import
#
# Keep the tag list in sync with POI_CATS in frontend/index.html.
set -euo pipefail
cd "$(dirname "$0")/.."

OSM=data/osm
PBF=$OSM/poland-latest.osm.pbf
URL=https://download.geofabrik.de/europe/poland-latest.osm.pbf
mkdir -p "$OSM"

if [ -f "$PBF" ]; then
  curl -fsSL --retry 3 -z "$PBF" -o "$PBF.part" "$URL"
else
  curl -fsSL --retry 3 -o "$PBF.part" "$URL"
fi
[ -s "$PBF.part" ] && mv "$PBF.part" "$PBF" || rm -f "$PBF.part"

docker build -q -t squadrats-osmium tools/osmium >/dev/null
osmium() { docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/$OSM:/data" squadrats-osmium "$@"; }

osmium tags-filter -O -o pois.osm.pbf poland-latest.osm.pbf \
  nwr/amenity=restaurant,cafe,fast_food,bar,bakery,drinking_water,bicycle_repair_station,bicycle_rental \
  nwr/shop=supermarket,convenience,bakery,sports,bicycle \
  nwr/tourism=viewpoint,attraction,museum,artwork \
  nwr/historic=castle,monument,church
osmium export -O -f geojsonseq -a type,id --format-option print_record_separator=false \
  -o pois.geojsonseq pois.osm.pbf
TS=$(osmium fileinfo -g header.option.osmosis_replication_timestamp poland-latest.osm.pbf 2>/dev/null || true)

docker compose exec -T backend node src/poi-import.js /app/data/osm/pois.geojsonseq /app/data/pois.db "$TS"
rm -f "$OSM/pois.osm.pbf" "$OSM/pois.geojsonseq"

# Cycling infrastructure for the "Popularne" planning mode (data/popular.db):
# ways of signed cycle routes, and cycleways / bicycle=designated ways.
osmium tags-filter -O -o cycroutes.osm.pbf poland-latest.osm.pbf r/route=bicycle
osmium export -O -f geojsonseq --geometry-types=linestring --format-option print_record_separator=false \
  -o cycroutes.geojsonseq cycroutes.osm.pbf
osmium tags-filter -O -o cycways.osm.pbf poland-latest.osm.pbf w/highway=cycleway w/bicycle=designated
osmium export -O -f geojsonseq --geometry-types=linestring --format-option print_record_separator=false \
  -o cycways.geojsonseq cycways.osm.pbf
docker compose exec -T backend node src/popular-import.js /app/data/osm/cycroutes.geojsonseq \
  /app/data/osm/cycways.geojsonseq /app/data/popular.db "$TS"
rm -f "$OSM"/cycroutes.* "$OSM"/cycways.*
