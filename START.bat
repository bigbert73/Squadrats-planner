@echo off
title Squadrats Route Planner v2
color 0A
echo.
echo  ╔═══════════════════════════════════════════╗
echo  ║   Squadrats Route Planner v2.0 - Docker  ║
echo  ╚═══════════════════════════════════════════╝
echo.

:: Check Docker
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo  ❌ Docker nie działa! Uruchom Docker Desktop i spróbuj ponownie.
    pause
    exit /b 1
)

:: Check .env
findstr /C:"YOUR_CLIENT_ID" .env >nul 2>&1
if %errorlevel% equ 0 (
    echo  ⚠️  Uzupełnij plik .env (STRAVA_CLIENT_ID i STRAVA_CLIENT_SECRET)
    echo  Otwórz .env w Notatniku i wpisz swoje dane.
    echo.
    pause
)

:: Create data dir
if not exist data mkdir data

:: Start containers
echo  🚀 Uruchamianie kontenerów...
docker compose up --build -d

:: Wait and open browser
echo  ⏳ Oczekiwanie na start serwera...
timeout /t 4 >nul
start http://localhost:8080

echo.
echo  ✅ Aplikacja dostępna: http://localhost:8080
echo.
echo  Aby zatrzymać: docker compose down
echo  Aby zobaczyć logi: docker compose logs -f backend
echo.
pause
