#!/usr/bin/env bash
# Isolated test stack: a second backend container from the same image, with its
# own empty database in a docker volume. It never touches ./data/squadrats.db.
#
#   tests/stack.sh up      start (fresh database every time)
#   tests/stack.sh down    stop and delete the test database
#   tests/stack.sh logs    backend log of the test stack
#
# The app is then at http://localhost:${SQ_TEST_PORT:-3100} (backend serves the
# frontend itself). Routing uses the BRouter container of the normal stack.
# Strava is played by tests/strava-mock.mjs (container sq-test-strava, also at
# http://localhost:${SQ_TEST_STRAVA_PORT:-3101}): no real account or token.
# StatsHunters, the weather service, Apple and the mail server are played by
# tests/services-mock.mjs (container sq-test-services, also at
# http://localhost:${SQ_TEST_SERVICES_PORT:-3102}).
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=sq-test-backend
MOCK=sq-test-strava
MOCK_PORT="${SQ_TEST_STRAVA_PORT:-3101}"
SVC=sq-test-services
SVC_PORT="${SQ_TEST_SERVICES_PORT:-3102}"
VOL=sq-test-data
PORT="${SQ_TEST_PORT:-3100}"
IMAGE="${SQ_TEST_IMAGE:-squadrats-v2-backend}"
NET="${SQ_TEST_NET:-squadrats-v2_default}"
ENVF=tests/.stack.env

down() {
  docker rm -f "$NAME" "$MOCK" "$SVC" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  rm -f "$ENVF"
}

case "${1:-}" in
  up)
    down
    docker volume create "$VOL" >/dev/null
    # Read-only side databases (POI, popularity, reachability) are copied in
    # when present, so those features work; the photo cache starts empty.
    docker run --rm -v "$VOL":/t -v "$PWD/data":/src:ro "$IMAGE" sh -c '
      for f in pois.db popular.db reach.db; do [ -f /src/$f ] && cp /src/$f /t/ || true; done
      # a throw-away key for the pretend "Sign in with Apple"
      node -e "require(\"fs\").writeFileSync(\"/t/apple-test.p8\", require(\"crypto\").generateKeyPairSync(\"ec\", { namedCurve: \"P-256\" }).privateKey.export({ type: \"pkcs8\", format: \"pem\" }))"
      chmod -R a+rwX /t'
    umask 077
    {
      echo "SQ_TEST_URL=http://localhost:$PORT"
      echo "SQ_TEST_ADMIN=admin"
      echo "SQ_TEST_ADMIN_PASSWORD=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')9"
      echo "SQ_TEST_JWT_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      echo "SQ_TEST_STRAVA=http://localhost:$MOCK_PORT"
      echo "SQ_TEST_SERVICES=http://localhost:$SVC_PORT"
    } > "$ENVF"
    . "$ENVF"
    # TRUST_PROXY=1 lets the tests act as many client addresses
    # (X-Forwarded-For), so the per-address rate limits can be exercised
    # without blocking the rest of the suite.
    docker run -d --name "$MOCK" --network "$NET" -p "127.0.0.1:$MOCK_PORT:3999" \
      -v "$PWD/tests/strava-mock.mjs":/mock.mjs:ro "$IMAGE" node /mock.mjs >/dev/null
    docker run -d --name "$SVC" --network "$NET" -p "127.0.0.1:$SVC_PORT:3998" \
      -v "$PWD/tests/services-mock.mjs":/mock.mjs:ro "$IMAGE" node /mock.mjs >/dev/null
    # The shared Strava application of the test stack is the mock's (id 424242);
    # the routing tiles are mounted so the coverage answers match BRouter's.
    docker run -d --name "$NAME" --network "$NET" -p "127.0.0.1:$PORT:3000" \
      -v "$VOL":/tdata -v "$PWD/backend/src":/app/src:ro -v "$PWD/frontend":/frontend:ro \
      -v "$PWD/data/brouter-segments":/segments:ro -e SEGMENTS_DIR=/segments \
      -e NODE_ENV=development -e PORT=3000 -e DB_PATH=/tdata/squadrats.db \
      -e BROUTER_URL=http://brouter:17777 -e TRUST_PROXY=1 \
      -e STRAVA_CLIENT_ID=424242 -e STRAVA_CLIENT_SECRET=test-secret \
      -e STRAVA_REDIRECT_URI="http://localhost:$PORT/auth/callback" \
      -e STRAVA_API_BASE="http://$MOCK:3999" -e STRAVA_AUTH_BASE="http://localhost:$MOCK_PORT" \
      -e STATSHUNTERS_BASE="http://$SVC:3998" -e WEATHER_API_BASE="http://$SVC:3998" \
      -e SMTP_URL="smtp://$SVC:2525" \
      -e APPLE_CLIENT_ID=com.example.planner.web -e APPLE_TEAM_ID=TESTTEAM01 -e APPLE_KEY_ID=TESTKEY001 \
      -e APPLE_PRIVATE_KEY_FILE=/tdata/apple-test.p8 \
      -e APPLE_API_BASE="http://$SVC:3998" -e APPLE_AUTH_BASE="http://localhost:$SVC_PORT" \
      -e JWT_SECRET="$SQ_TEST_JWT_SECRET" \
      -e ADMIN_USERNAME="$SQ_TEST_ADMIN" -e ADMIN_PASSWORD="$SQ_TEST_ADMIN_PASSWORD" \
      ${SQ_TEST_EXTRA_ENV:-} "$IMAGE" node src/index.js >/dev/null
    for i in $(seq 1 40); do
      curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1 && { echo "test stack up: http://localhost:$PORT"; exit 0; }
      sleep 0.5
    done
    echo "test stack did not start" >&2; docker logs --tail 30 "$NAME" >&2; exit 1 ;;
  down) down; echo "test stack removed" ;;
  logs) docker logs --tail "${2:-80}" "$NAME" ;;
  *) echo "usage: $0 up|down|logs" >&2; exit 2 ;;
esac
