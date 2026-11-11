# Squadrats Planner

A self-hosted cycling route planner for [Squadrats](https://squadrats.com) players. It builds loops through squares you have not collected yet and avoids riding home on the road you came out on.

Squadrats Planner is an independent project and is not affiliated with squadrats.com.

It runs on two platforms:

- **Linux** with Docker Compose
- **OpenShift** with the manifests in `ocp/`. The images are tested locally, but the manifests have not yet been applied to a live cluster.

## Features

- Loops and A→B routes that maximise new squadrats (zoom 14) or squadratinhos (zoom 17), or grow your Yard and Yardinho
- Six bike profiles plus walking and running, seven optimisation goals, and point-by-point route drawing
- Weather and wind along the route, with loops planned into the wind first
- Priority layer that ranks missing squares near your home
- Surface breakdown, elevation profile, points of interest, photos and Street View along the route
- One-click Strava sign-in and sync, plus imports from Squadrats KML, GPX, StatsHunters (share link) and VeloViewer (KML)
- Saved routes with GPX export, hand-off to Garmin Connect, public share links and import of other people’s GPX
- Installable (PWA) with an offline copy of your squares and routes, and spoken turn announcements while riding
- A Connect IQ data field for Garmin Edge 1040 and 1050
- Interface in Polish, English, German, Dutch, French and Czech; desktop and phone layouts

Routes can be planned anywhere in Europe. Points of interest and the “no road here” layer are built for the regions listed in `data/osm/regions.txt` (Poland by default); the Polish geoportal overlays are Poland only.

## Architecture

```
browser ──> frontend (nginx) :8081 ──> backend (Node 20, Express, SQLite) :3000 ──> BRouter :17777
```

| Path | Contents |
|---|---|
| `backend/src/` | API, route planner, Strava sync, map and photo proxies |
| `frontend/` | Single-page app (`index.html`, Leaflet, no build step) and `docs/` |
| `brouter/` | BRouter image and custom bike profiles |
| `garmin/` | Connect IQ data field |
| `tools/` | Rebuilds the OpenStreetMap databases |
| `ocp/` | OpenShift manifests |
| `data/` | Databases and routing segments (not in git) |

## Linux with Docker Compose

You need Docker Engine with the Compose plugin, and about 1 GB of free disk space.

### 1. Clone the repository

```bash
git clone https://github.com/bigbert73/squadrats-planner.git
cd squadrats-planner
```

### 2. Create `.env`

| Variable | Required | Purpose |
|---|---|---|
| `JWT_SECRET` | recommended | Signs login sessions. Without it a random key is created once in `data/.jwt-secret`. Generate one with `openssl rand -hex 32` |
| `STRAVA_REDIRECT_URI` | for Strava and Google sign-in | `<base-url>/auth/callback` |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` | for one-click Strava | The installation’s Strava application, from <https://www.strava.com/settings/api>. Everyone signs in and connects with “Continue with Strava”; without it each rider pastes their own keys in the profile |
| `STRAVA_SHARED` | optional | `0` keeps the keys above private to the first admin (no one-click connecting) |
| `STRAVA_DAILY_BUDGET` | optional | Background-sync requests per day on the shared application (default 600) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google sign-in | Authorized redirect URI: `<base-url>/auth/google/callback` |
| `GOOGLE_MAPS_KEY` | optional | Street View and Places |
| `MAPY_API_KEY` | optional | Mapy.com base maps |
| `MAPILLARY_TOKEN` | optional | Mapillary photos |
| `COOKIE_SECURE` | behind HTTPS | Set to `true` |
| `APP_NAME`, `APP_SHORT_NAME` | optional | The name shown in the app, the install manifest, e-mails and shared pages (default “Squadrats Route Planner”) |
| `APP_BASE_URL` | optional | Public address put into e-mailed links, e.g. `https://planner.example.org` (default: the base of `STRAVA_REDIRECT_URI`, which sign-in redirects always use) |
| `SMTP_URL`, `MAIL_FROM` | for password reset | `smtp[s]://user:password@host:port` and the sender address. Without `SMTP_URL` the “forgot my password” link is hidden |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` or `APPLE_PRIVATE_KEY_FILE` | for Sign in with Apple | Services ID, team, key id and the `.p8` key from the Apple Developer account. Return URL: `<base-url>/auth/apple/callback` |
| `WEATHER_USER_AGENT` | recommended | How the app identifies itself to MET Norway (their terms ask for an app name and a contact address or URL) |

Never commit `.env`.

In the Strava application set **Authorization Callback Domain** to the host of `<base-url>`. A new Strava application accepts one athlete (its owner) until Strava approves a higher athlete capacity, and its request limits (by default 200 per 15 minutes and 2,000 per day) are shared by everyone who connects through it. Riders who want a limit of their own can still save their own keys in the profile.

### 3. Download the routing segments

```bash
tools/update-segments.sh                               # all of Europe: 73 tiles, about 3 GB
SEGMENTS_BBOX="10 45 25 55" tools/update-segments.sh   # or just an area: west south east north
```

Routes can be planned where these tiles are; elsewhere the app says the area is outside the coverage (`GET /api/coverage` lists it). Run the script again to refresh the data: it downloads only newer tiles and restarts BRouter.

### 4. Start the app

```bash
docker compose up -d --build
```

Open <http://localhost:8081>.

### 5. Build the OpenStreetMap databases

```bash
tools/update-pois.sh
```

This downloads the Geofabrik extracts of the regions in `data/osm/regions.txt` (one Geofabrik name per line, e.g. `poland`, `germany`, `netherlands`; Poland when the file is missing) and builds `pois.db`, `popular.db` and `reach.db`. It is safe to run while the app is up, so it also works as a scheduled refresh: the first region is checked for a newer extract on every run, the others every 28 days. The “Popular” index is built for the first region only.

### Everyday commands

```bash
docker compose logs -f backend      # follow backend logs
docker compose restart backend      # restart the backend
docker compose up -d --build        # rebuild and restart
```

To back up user data, stop the backend and copy `data/squadrats.db`.

## OpenShift

The manifests create everything in the `squadrats` namespace. Images are built from this repository.

```bash
oc new-project squadrats

# Secrets: fill in ocp/manifests/01-secret.yaml, or create them from your .env
oc create secret generic squadrats-strava --from-env-file=.env -n squadrats

oc apply -f ocp/manifests/02-backend.yaml
oc apply -f ocp/manifests/03-frontend.yaml
oc apply -f ocp/manifests/04-route.yaml
oc apply -f ocp/manifests/05-brouter.yaml
oc apply -f ocp/manifests/06-brouter-build.yaml
oc apply -f ocp/manifests/07-osm.yaml

oc start-build squadrats-backend -n squadrats
oc start-build squadrats-frontend -n squadrats
oc start-build squadrats-brouter -n squadrats
oc start-build squadrats-osm -n squadrats
```

Copy the routing segments to the BRouter volume:

```bash
oc get pods -n squadrats
oc cp data/brouter-segments/. <brouter-pod>:/brouter-data/segments4 -n squadrats
```

Find the public host, then set `STRAVA_REDIRECT_URI` to `https://<host>/auth/callback` in the secret and in your Strava app:

```bash
oc get route squadrats -n squadrats -o jsonpath='{.spec.host}'
oc rollout restart deployment/squadrats-backend -n squadrats
```

Build the OpenStreetMap databases once. After that, the `squadrats-osm` CronJob refreshes them every Sunday at 04:00:

```bash
oc create job --from=cronjob/squadrats-osm squadrats-osm-first -n squadrats
```

## Tests

```bash
tests/stack.sh up            # a separate backend with an empty database, plus stand-ins for Strava, StatsHunters, MET Norway, Apple and SMTP
node tests/api.mjs           # API tests
node tests/e2e.mjs desktop   # browser scenarios (also: mobile)
tests/stack.sh down
```

The tests never touch `data/squadrats.db` and never call Strava or other outside services. The plan is in `tests/PLAN.md` (Polish).

## Documentation

The user manual has English and Polish versions, with desktop and phone screenshots. Once the app is running, open `/docs/en.html` for English or `/docs/` for Polish.

The source is in `frontend/docs/tools/`:

```bash
node frontend/docs/tools/build.mjs    # regenerates index.html (PL) and en.html (EN)
```

`docshots.mjs` and `steps.mjs` produce the screenshots.

## Languages

Polish is the source language and English lives in `frontend/i18n.js`. German, Dutch, French and Czech are files in `frontend/i18n/<code>.js` (machine-translated, loaded only when chosen); a text missing there is shown in English. To add a language, add its file, its code to `LANGS`/`LOCALE` in `frontend/i18n.js` and an `<option>` to the two language lists in `frontend/index.html`, then bump `PACK_VER`. `node tests/api.mjs I18N` checks every file for completeness.

## Garmin data field

The Connect IQ SDK is required. Generate a personal key in your profile, then:

```bash
SQUADRATS_URL=https://your-server GARMIN_KEY=<key> garmin/build.sh edge1040
```

`garmin/resources-local/` holds the private settings. Never commit it.

## Data sources

Map data © OpenStreetMap contributors. Routing by [BRouter](https://github.com/abrensch/brouter). Activity sync through the Strava API. Weather forecast from [MET Norway](https://api.met.no/) (CC BY 4.0).
