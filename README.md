# Squadrats Planner

A self-hosted cycling route planner for [Squadrats](https://squadrats.com) players. It builds loops through squares you have not collected yet and avoids riding home on the road you came out on.

Squadrats Planner is an independent project and is not affiliated with squadrats.com.

It runs on two platforms:

- **Linux** with Docker Compose
- **OpenShift** with the manifests in `ocp/`. The images are tested locally, but the manifests have not yet been applied to a live cluster.

## Features

- Loops and A→B routes that maximise new squadrats (zoom 14) or squadratinhos (zoom 17), or grow your Yard and Yardinho
- Six bike profiles, seven optimisation goals, and point-by-point route drawing
- Priority layer that ranks missing squares near your home
- Surface breakdown, elevation profile, points of interest, photos and Street View along the route
- Strava sync, plus KML and GPX import
- Saved routes with GPX export and hand-off to Garmin Connect
- A Connect IQ data field for Garmin Edge 1040 and 1050
- Polish and English interface; desktop and phone layouts

Routing and points of interest currently cover Poland.

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
| `JWT_SECRET` | yes | Signs login sessions. Without it the app uses an insecure default. Generate one with `openssl rand -hex 32` |
| `STRAVA_REDIRECT_URI` | for Strava and Google sign-in | `<base-url>/auth/callback` |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` | for Strava | From <https://www.strava.com/settings/api> |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google sign-in | Authorized redirect URI: `<base-url>/auth/google/callback` |
| `GOOGLE_MAPS_KEY` | optional | Street View and Places |
| `MAPY_API_KEY` | optional | Mapy.com base maps |
| `MAPILLARY_TOKEN` | optional | Mapillary photos |
| `COOKIE_SECURE` | behind HTTPS | Set to `true` |

Never commit `.env`.

### 3. Download the routing segments

```bash
mkdir -p data/brouter-segments
for tile in E10_N45 E10_N50 E15_N45 E15_N50 E20_N45 E20_N50; do
  curl -fL -o "data/brouter-segments/$tile.rd5" "https://brouter.de/brouter/segments4/$tile.rd5"
done
```

### 4. Start the app

```bash
docker compose up -d --build
```

Open <http://localhost:8081>.

### 5. Build the OpenStreetMap databases

```bash
tools/update-pois.sh
```

This downloads the Geofabrik extract of Poland and builds `pois.db`, `popular.db` and `reach.db`. It is safe to run while the app is up, so it also works as a scheduled refresh.

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

## Documentation

The user manual has English and Polish versions, with desktop and phone screenshots. Once the app is running, open `/docs/en.html` for English or `/docs/` for Polish.

The source is in `frontend/docs/tools/`:

```bash
node frontend/docs/tools/build.mjs    # regenerates index.html (PL) and en.html (EN)
```

`docshots.mjs` and `steps.mjs` produce the screenshots.

## Garmin data field

The Connect IQ SDK is required. Generate a personal key in your profile, then:

```bash
SQUADRATS_URL=https://your-server GARMIN_KEY=<key> garmin/build.sh edge1040
```

`garmin/resources-local/` holds the private settings. Never commit it.

## Data sources

Map data © OpenStreetMap contributors. Routing by [BRouter](https://github.com/abrensch/brouter). Activity sync through the Strava API.
