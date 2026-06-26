# Squadrats Route Planner v2

Aplikacja rowerowa łącząca Strava API z systemem kwadratów Squadrats.com.
Lokalna baza SQLite — kwadraty zapisane raz, synchronizacja tylko nowych aktywności.

## Architektura

```
docker-compose
├── backend   (Node.js + Express + SQLite)  :3000
└── frontend  (nginx + HTML/JS)             :8080
         ↓ proxy /api/* i /auth/*
         ↓
    backend:3000

Dane: ./data/squadrats.db  (SQLite, persystuje między restartami)
```

## Wymagania

- **Docker Desktop** (Windows 11) — https://www.docker.com/products/docker-desktop
- **VS Code** — https://code.visualstudio.com
- **Konto Strava** z subskrypcją

---

## Instalacja krok po kroku

### 1. Docker Desktop

1. Pobierz i zainstaluj Docker Desktop: https://www.docker.com/products/docker-desktop
2. Uruchom Docker Desktop — poczekaj aż ikona w zasobniku przestanie się kręcić
3. Sprawdź w PowerShell: `docker --version` (powinno pokazać wersję)

### 2. Pobierz projekt

Wypakuj archiwum do folderu, np. `C:\Users\TwojeImie\squadrats-planner\`

### 3. Skonfiguruj Strava API

Edytuj plik `.env` w głównym folderze projektu:

```
STRAVA_CLIENT_ID=123456
STRAVA_CLIENT_SECRET=abcdef...
```

(Instrukcja uzyskania kluczy: patrz instrukcja Strava API)

> **Ważne:** W ustawieniach aplikacji Strava ustaw:
> - Authorization Callback Domain: `localhost`
> - Website: `http://localhost:3000`

### 4. Otwórz w VS Code

1. Otwórz VS Code
2. Zainstaluj rozszerzenia (VS Code zaproponuje je automatycznie):
   - **Docker** (ms-azuretools.vscode-docker)
   - **SQLite Viewer** (alexcvzz.vscode-sqlite)
3. W VS Code: File → Open Workspace from File → wybierz `squadrats.code-workspace`

### 5. Uruchom

Opcja A — terminal VS Code (`Ctrl+~`):
```powershell
docker compose up --build
```

Opcja B — Task Runner: `Ctrl+Shift+P` → "Tasks: Run Task" → "Docker: Start"

Opcja C — kliknij dwukrotnie `START.bat`

### 6. Otwórz aplikację

Przeglądarka: **http://localhost:8080**

---

## Pierwsze użycie

1. Kliknij **"Zaloguj Strava"** → zaakceptuj uprawnienia
2. Zakładka **Kwadraty** → kliknij **"Synchronizuj z Strava"**
   - Pierwsza synchronizacja pobiera wszystkie aktywności (może potrwać kilka minut)
   - Postęp widoczny w pasku
3. Kwadraty pojawią się na mapie
4. Kolejne synchronizacje dodają tylko nowe aktywności

## Planowanie trasy

1. Zakładka **Trasa** → wybierz tryb Start/Meta
2. Kliknij punkt startu i mety na mapie
3. Wybierz optymalizację (np. "Maks. nowe Squadrats")
4. Kliknij **Oblicz trasę**
5. Pomarańczowe kwadraty = nowe, które zdobędziesz

---

## Struktura projektu

```
squadrats-planner/
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js     ← Express API + routing
│       ├── db.js        ← SQLite schema + queries
│       ├── tiles.js     ← OSM tile math + algorytmy
│       └── strava.js    ← OAuth + sync
├── frontend/
│   ├── index.html       ← Cała aplikacja SPA
│   └── nginx.conf       ← Proxy /api → backend
├── data/                ← SQLite DB (tworzy się automatycznie)
├── .env                 ← Twoje klucze API (NIE commituj!)
├── docker-compose.yml
└── squadrats.code-workspace
```

## Baza danych

Plik `data/squadrats.db` — możesz go otworzyć w VS Code z rozszerzeniem SQLite Viewer.

Tabele:
- `tiles_sq`   — zoom-14 Squadrats (tx, ty)
- `tiles_sqi`  — zoom-17 Squadratinhos (tx, ty)
- `activities` — przetworzone aktywności Strava
- `tokens`     — tokeny OAuth (nie usuwaj!)

## Przydatne komendy

```powershell
# Sprawdź logi backendu
docker compose logs -f backend

# Restart bez przebudowy
docker compose restart backend

# Całkowity reset (zachowuje bazę!)
docker compose down && docker compose up --build

# Backup bazy
copy data\squadrats.db data\squadrats_backup.db
```

## Rozwiązywanie problemów

| Problem | Rozwiązanie |
|---------|-------------|
| Port 3000/8080 zajęty | Zmień port w docker-compose.yml |
| Docker nie startuje | Upewnij się że WSL2 jest włączony |
| Błąd logowania Strava | Sprawdź .env i callback URL |
| Kwadraty nie widoczne | Kliknij "Dopasuj widok" lub odsuń mapę |
| Sync się zatrzymuje | Limit API Strava (200/15min) — poczekaj |
