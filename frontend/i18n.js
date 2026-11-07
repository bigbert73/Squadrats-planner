// UI language (PL / EN).
//
// The app is written in Polish. In English mode every Polish text that reaches
// the DOM (static markup, innerHTML/textContent set by the app, server errors
// shown in toasts) is swapped for its English counterpart from EN / EN_RX by a
// MutationObserver; the original is remembered per node, so switching back to
// Polish restores it without a reload. Strings that never hit the DOM
// (confirm/alert, input values, locale-formatted dates) go through t()/tl().
(function(){
const KEY='sq-lang';
let lang=null;
try{lang=localStorage.getItem(KEY);}catch(e){}
if(lang!=='pl'&&lang!=='en') lang=/^pl\b/i.test(navigator.language||'pl')?'pl':'en';

// Exact texts (whitespace-collapsed, trimmed)
const EN={
  // header, menu
  'Trasa':'Route','Kwadraty':'Squares','Nakładki':'Overlays','Opcje':'Options',
  'Menu':'Menu','Przypnij / odepnij panel':'Pin / unpin panel','Zamknij':'Close',
  'Profil i Strava':'Profile & Strava','Panel admina':'Admin panel','Wyloguj':'Log out',
  'Podręcznik':'User manual','Język':'Language',
  '⚡ Administrator':'⚡ Administrator','👤 Użytkownik':'👤 User',
  // plan panel
  'Dodaj punkt startu, by zacząć':'Add a start point to begin','Zaplanuj trasę':'Plan a route',
  'nowe SQ':'new SQ','nowe SQI':'new SQI','Średnia prędkość (km/h)':'Average speed (km/h)',
  'Pobierz GPX dla Garmina':'Download GPX for Garmin','Wyślij':'Send','Profil':'Profile','Zapisz':'Save',
  'Dodaj powrót inną drogą':'Add a different way back','Usuń powrót':'Remove way back',
  'Przelicz':'Recalculate','Ustawienia':'Settings','Nazwa trasy':'Route name','Anuluj':'Cancel',
  'GPX z wysokościami — import jako kurs w Garmin Connect':'GPX with elevation — import as a course in Garmin Connect',
  'Udostępnij plik GPX aplikacji licznika (np. Wahoo ELEMNT)':'Share the GPX file with your bike computer app (e.g. Wahoo ELEMNT)',
  'Skąd? Wpisz adres startu…':'From? Type the start address…','Szukaj adresu':'Search address',
  'Dokąd? Wpisz adres mety…':'To? Type the finish address…',
  'Oblicz trasę':'Calculate route','Pętla':'Loop','Profil roweru':'Bike profile',
  'Ogólny':'General','Szosowy':'Road','Gravel':'Gravel','Spokojny':'Quiet','Bezpieczny':'Safe','MTB':'MTB',
  'Profile inne niż Ogólny wymagają BRouter.':'Profiles other than General need BRouter.',
  'OSRM — ogólny rower':'OSRM — general bike','BRouter — szybka trasa, asfalt':'BRouter — fast route, asphalt',
  'BRouter — gravel, szuter':'BRouter — gravel','BRouter — spokojne drogi, ścieżki':'BRouter — quiet roads, paths',
  'BRouter — ścieżki rowerowe priorytet':'BRouter — prefers cycle paths','BRouter — MTB, terenowy':'BRouter — MTB, off-road',
  'Zaawansowane':'Advanced','Optymalizacja':'Optimisation','Nowe SQ':'New SQ','Priorytety':'Priorities',
  'Bez kwadratów':'No squares','Popularne':'Popular',
  'Maks. nowe Squadrats':'Max new Squadrats','Maks. Squadratinhos':'Max Squadratinhos','Rozszerz Yard':'Grow the Yard',
  'Rozszerz Yardinho (Yard z squadratinhos)':'Grow the Yardinho (Yard of squadratinhos)',
  'Pętla przez priorytetowe squadratinhos (warstwa Priorytety): najwięcej punktów w limicie km':'Loop through priority squadratinhos (Priorities layer): the most points within the km limit',
  'Zwykła trasa — kwadraty nie mają wagi':'Plain route — squares carry no weight',
  'Drogi, którymi jeździ najwięcej ludzi: gęste ślady GPS z OpenStreetMap i oznakowane szlaki rowerowe':'Roads most people ride: dense OpenStreetMap GPS traces and signposted cycle routes',
  'Punkty pośrednie':'Waypoints','Brak punktów — kliknij mapę lub ustaw tryb edycji':'No points — click the map or pick an edit mode',
  'Dodaj punkt pośredni':'Add waypoint','Cofnij':'Undo','Odwróć':'Reverse','Wyczyść trasę':'Clear route',
  'Cofnij ostatni punkt (Ctrl+Z)':'Undo last point (Ctrl+Z)',
  'Moje trasy':'My routes','Ładowanie…':'Loading…','Podsumowanie trasy':'Route summary','Punkty na trasie':'Points along the route',
  'Wybierz Start i kliknij mapę':'Choose Start and click the map','Dom':'Home','Start ustawiony':'Start set',
  'Szczegóły':'Details','Wczytaj trasę':'Load route','Usuń trasę':'Delete route','Usuń?':'Delete?',
  'Brak zapisanych tras. Wyznacz trasę i kliknij „Zapisz” w jej karcie.':'No saved routes yet. Plan a route and click “Save” on its card.',
  'Nie udało się wczytać tras':'Could not load routes',
  // squares panel
  'Squadrats (zoom 14)':'Squadrats (zoom 14)','Nowe (trasa)':'New (route)','Squadratinhos (zoom 17)':'Squadratinhos (zoom 17)',
  'Warstwy':'Layers','Zdobyte SQ':'Collected SQ','Zdobyte SQI':'Collected SQI','Nowe SQI':'New SQI','Über SQI':'Über SQI',
  'Siatka zoom 14':'Grid zoom 14','Siatka zoom 17':'Grid zoom 17','Bez dróg (sugestie)':'No roads (suggestions)',
  'Kwadraty zoom 14, które już zdobyłeś':'Zoom 14 squares you have already collected',
  'Kwadraty, które zdobędziesz przejeżdżając zaplanowaną trasę':'Squares you will collect by riding the planned route',
  'Zdobyte kwadraty otoczone zdobytymi z 4 stron':'Collected squares surrounded by collected ones on all 4 sides',
  'Największy pełny kwadrat ze zdobytych kwadratów':'The largest full square made of collected squares',
  'Squadratinhos (zoom 17), które już zdobyłeś':'Squadratinhos (zoom 17) you have already collected',
  'Squadratinhos, które zdobędziesz na zaplanowanej trasie':'Squadratinhos you will collect on the planned route',
  'Zdobyte squadratinhos otoczone zdobytymi z 4 stron':'Collected squadratinhos surrounded by collected ones on all 4 sides',
  'Największy pełny kwadrat ze zdobytych squadratinhos':'The largest full square made of collected squadratinhos',
  'Niezdobyte squadratinhos, które najbardziej powiększą Übersquadratinho i Yardinho — blisko domu i z drogą':'Uncollected squadratinhos that grow your Übersquadratinho and Yardinho the most — close to home and reachable by road',
  'Squadratinhos, przez które w OpenStreetMap nie biegnie żadna droga ani ścieżka — prawdopodobnie niezdobywalne (woda, tereny zamknięte, pola bez dróg)':'Squadratinhos with no road or path in OpenStreetMap — probably uncollectable (water, closed areas, fields without tracks)',
  'Trzy szybkie kliknięcia w kwadrat SQI na mapie (tryb Widok, zoom 14+) oznaczają go jako niezdobywalny — trasy go pominą. Trzy kolejne kliknięcia odznaczają.':'Three quick clicks on an SQI square on the map (View mode, zoom 14+) mark it as uncollectable — routes will skip it. Three more clicks unmark it.',
  'Jedno przekreślenie = sugestia: w OpenStreetMap nie ma tam żadnej drogi ani ścieżki (widać od zoomu 13). Trzy kliknięcia zatwierdzają pojedynczy kwadrat, albo zatwierdź wszystkie widoczne:':'A single cross = suggestion: OpenStreetMap has no road or path there (visible from zoom 13). Three clicks confirm one square, or confirm all visible ones:',
  'Oznacz sugerowane w widoku jako niezdobywalne':'Mark suggested squares in view as uncollectable',
  'Zasięg zdobywalnych SQI':'Collectable SQI coverage','Synchronizacja':'Sync','Inicjalizacja…':'Initialising…',
  'Synchronizuj z Strava':'Sync with Strava','Importuj GPX':'Import GPX','Importuj z Squadrats.com (KML)':'Import from Squadrats.com (KML)',
  "Oficjalny eksport kwadratów ze squadrats.com — 'Pobierz KML' w ich aplikacji":"The official square export from squadrats.com — 'Download KML' in their app",
  'Liczę priorytety…':'Calculating priorities…','Nie udało się policzyć priorytetów':'Could not calculate priorities',
  'Brak priorytetowych kwadratów w promieniu 30 km od domu.':'No priority squares within 30 km of home.',
  'Najcenniejsze kwadraty':'Most valuable squares','Zaplanuj pętlę w trybie':'Plan a loop in',
  '— zbierze ich najwięcej w ustawionym limicie km. Po synchronizacji ze Stravą priorytety przeliczą się same.':'mode — it collects as many as fit in the km limit. Priorities recalculate themselves after a Strava sync.',
  'Kwadrat bez drogi w OSM — dojdź pieszo z roweru':'Square with no road in OSM — walk in from the bike',
  'Brak indeksu dróg (tools/update-pois.sh).':'No road index (tools/update-pois.sh).',
  'Nie udało się policzyć zasięgu':'Could not calculate coverage',
  'W promieniu':'Within','od domu masz':'of home you have','od środka mapy masz':'of the map centre you have','zdobywalnych SQI':'of collectable SQI',
  'Połącz Stravę w profilu, a nowe jazdy będą synchronizowane automatycznie.':'Connect Strava in your profile and new rides will sync automatically.',
  // overlays panel
  'Nakładka rowerowa':'Cycling overlay','Trasy rowerowe z OpenStreetMap (Waymarked Trails). Publiczna, bez logowania.':'Cycle routes from OpenStreetMap (Waymarked Trails). Public, no login.',
  'Pokaż trasy rowerowe':'Show cycle routes','Ukryj':'Hide','Ślady GPS (OpenStreetMap)':'GPS traces (OpenStreetMap)',
  'Publiczne nagrania GPS użytkowników OSM — im grubszy i gęstszy pas, tym więcej przejazdów. Z tego (i ze szlaków) korzysta tryb „Popularne”.':'Public GPS recordings by OSM users — the thicker and denser the band, the more rides. The “Popular” mode uses this (and the signposted routes).',
  'Pokaż ślady GPS':'Show GPS traces','Teren i dostęp (Polska)':'Terrain & access (Poland)',
  'Publiczne mapy GUGiK, Lasów Państwowych i GDOŚ — do oceny kwadratów bez drogi w OSM: czy jest tam ścieżka i czy wolno wejść.':'Public maps from GUGiK, the State Forests and GDOŚ — to judge squares without a road in OSM: is there a path, and are you allowed in.',
  'Lidar (rzeźba)':'Lidar (relief)','Ortofotomapa':'Orthophoto','Oddziały leśne':'Forest compartments','Rezerwaty':'Nature reserves','Działki':'Land parcels',
  'Cieniowanie numerycznego modelu terenu z lotniczego skanowania laserowego (1 m). Widać ścieżki, dukty, rowy i nasypy także pod koronami drzew. Od zoomu 11.':'Hillshade of the terrain model from airborne laser scanning (1 m). Paths, forest tracks, ditches and embankments show even under tree cover. From zoom 11.',
  'Zdjęcia lotnicze Geoportalu (do ~10 cm/px), zwykle nowsze niż satelita Esri. Przykrywa mapę bazową.':'Geoportal aerial photos (down to ~10 cm/px), usually newer than Esri satellite. Covers the base map.',
  'Granice oddziałów leśnych z Banku Danych o Lasach — to zwykle przejezdne dukty (linie oddziałowe). Od zoomu 12.':'Forest compartment boundaries from the Forest Data Bank — usually rideable forest tracks. From zoom 12.',
  'Rezerwaty, parki narodowe i użytki ekologiczne (GDOŚ). W rezerwacie zwykle nie wolno schodzić ze szlaku.':'Nature reserves, national parks and ecological sites (GDOŚ). In a reserve you usually must stay on the trail.',
  'Działki ewidencyjne z numerami (Krajowa Integracja Ewidencji Gruntów). Pozwala sprawdzić, czy polna droga to osobna działka drogowa. Od zoomu 16.':'Cadastral parcels with numbers (national land register). Shows whether a field track is a separate road parcel. From zoom 16.',
  'Strava blokuje dostęp z zewnętrznych stron (SameSite cookies). Otwórz bezpośrednio:':'Strava blocks access from other sites (SameSite cookies). Open it directly:',
  'Otwórz w Strava':'Open in Strava',
  // options panel
  'Mapa bazowa':'Base map','🛰️ Satelita (ESRI)':'🛰️ Satellite (ESRI)','🥾 Turystyczna (Mapy.com)':'🥾 Outdoor (Mapy.com)','✈️ Lotnicza (Mapy.com)':'✈️ Aerial (Mapy.com)',
  'Squadrats — specyfikacja':'Squadrats — specification',': każdy tile ma 4 sąsiadów (N,E,S,W)':': every tile has 4 neighbours (N,E,S,W)',
  ': największy kwadrat N×N':': the largest N×N square','Kafelki: OSM Slippy Map (Mercator)':'Tiles: OSM Slippy Map (Mercator)','Baza: SQLite →':'Database: SQLite →',
  'Rysuj':'Draw','Rysuj ·':'Draw ·','Gotowe':'Done','Do startu':'Back to start','Zakończ rysowanie':'Finish drawing',
  'Rysuj trasę: stukaj kolejne punkty, odcinki wyznaczą się po drogach':'Draw a route: tap point after point, each leg follows the roads',
  'Wróć do startu inną drogą':'Back to the start on other roads','Rysowanie — stukaj kolejne punkty':'Drawing — tap point after point',
  'Stukaj kolejne punkty — trasa wydłuża się po drogach':'Keep tapping — the route grows along the roads',
  'Stuknij punkt startu, potem kolejne punkty':'Tap the start, then the next points',
  'Chwila — liczę ostatni odcinek…':'One moment — routing the last leg…','Nie da się tu dojechać — punkt usunięty':"Can't get there by road — point removed",
  'Nie da się tu dojechać':"Can't get there by road",'Przygotowuję trasę…':'Preparing the route…','Przeliczam odcinek…':'Recalculating leg…',
  'Skróty':'Shortcuts','Start ·':'Start ·','Meta ·':'Finish ·','Punkt ·':'Waypoint ·','Widok':'View','Oblicz ·':'Calculate ·',
  // map
  'Meta':'Finish','Punkt':'Waypoint','Tryb widoku':'View mode','Narzędzia':'Tools','Profil wysokości':'Elevation profile',
  'Ciekawe miejsca (Wikipedia)':'Places of interest (Wikipedia)','Zdjęcia z trasy':'Photos along the route',
  'Rowerowa (CyclOSM)':'Cycling (CyclOSM)','Topograficzna':'Topographic','Satelita':'Satellite','Ciemna':'Dark',
  'Turystyczna (Mapy.com)':'Outdoor (Mapy.com)','Lotnicza (Mapy.com)':'Aerial (Mapy.com)','Teren i dostęp (PL)':'Terrain & access (PL)',
  'Lidar (rzeźba terenu)':'Lidar (terrain relief)','Przybliż':'Zoom in','Oddal':'Zoom out','Moja lokalizacja':'My location',
  'Jadę: moja pozycja na trasie':'Riding: my position on the route','Pokaż całą trasę':'Show the whole route','Mapa bazowa i narzędzia':'Base map and tools',
  'Szukam sygnału GPS…':'Looking for GPS signal…','Wycentruj':'Centre','Zakończ':'Stop','Profil wysokościowy':'Elevation profile',
  'Kliknij dowolne miejsce na mapie':'Click anywhere on the map','aby zobaczyć Street View Google Maps':'to see Google Maps Street View',
  'Trasa pokryta Street View':'Route covered by Street View','Wymaga klucza Google Maps API':'Needs a Google Maps API key','dla sprawdzenia pokrycia':'to check coverage',
  'Kliknij — punkt startu':'Click — start point','Kliknij — punkt mety':'Click — finish point','Kliknij — punkt pośredni':'Click — waypoint',
  'Kliknij — Street View':'Click — Street View','Kliknij — dodaj punkt pośredni':'Click — add a waypoint','Street View — kliknij na mapie':'Street View — click on the map',
  'Brak Street View w tym miejscu':'No Street View here','Otwórz Google Maps':'Open Google Maps','Brak klucza Google Maps API.':'No Google Maps API key.',
  'Otwórz Street View w nowej karcie':'Open Street View in a new tab',
  'Dodaj GOOGLE_MAPS_KEY do pliku .env i odtwórz kontener backendu, aby włączyć podgląd w aplikacji.':'Add GOOGLE_MAPS_KEY to .env and recreate the backend container to enable the in-app preview.',
  'Brak danych wysokościowych (OSRM)':'No elevation data (OSRM)','Dane wysokościowe dostępne tylko dla tras BRouter':'Elevation data is available for BRouter routes only',
  'm n.p.m.':'m a.s.l.','Brak danych nawierzchni (OSRM)':'No surface data (OSRM)',
  'Ścieżka rowerowa':'Cycle path','Droga nieutwardzona':'Unpaved road','Kostka brukowa':'Cobblestones','Ścieżka / Szlak':'Path / trail',
  'Droga gruntowa':'Dirt track','Chodnik':'Footway','Droga lokalna':'Local road','Nieznana':'Unknown','Asfalt':'Asphalt','Droga główna':'Main road','Szuter':'Gravel',
  // POI, photos, wiki
  'Jedzenie':'Food','Woda':'Water','Sklepy':'Shops','Noclegi':'Accommodation','Rower':'Bike','Atrakcje':'Sights',
  'Tylko przy trasie':'Only along the route','Pobieranie punktów na trasie…':'Fetching points along the route…',
  'Brak punktów na tej trasie':'No points on this route','Brak punktów blisko trasy':'No points close to the route',
  'Brak punktów przy samej trasie':'No points right by the route','Spróbuj ponownie':'Try again','przy trasie':'on the route',
  'Google Maps — opinie, zdjęcia':'Google Maps — reviews, photos','Czytaj na Wikipedii →':'Read on Wikipedia →',
  'Restauracja':'Restaurant','Kawiarnia':'Café','Piekarnia':'Bakery','Woda pitna':'Drinking water','Sklep spożywczy':'Grocery',
  'Sklep sportowy':'Sports shop','Sklep rowerowy':'Bike shop','Stacja naprawy rowerów':'Bike repair station','Wypożyczalnia rowerów':'Bike rental',
  'Punkt widokowy':'Viewpoint','Atrakcja':'Attraction','Muzeum':'Museum','Dzieło sztuki':'Artwork','Zamek':'Castle','Pomnik':'Monument',
  'Kościół':'Church','Stacja Orlen':'Orlen station','Pensjonat':'Guest house','Apartament':'Apartment','Domek':'Chalet','Kemping':'Campsite',
  'Schronisko':'Mountain hut','Wiata/chatka':'Shelter/hut',
  // ride
  'Daleko od trasy':'Far from the route','Pozycja GPS niedostępna':'GPS position unavailable',
  'Brak zgody na pozycję GPS — zezwól w ustawieniach przeglądarki':'No permission for GPS position — allow it in the browser settings',
  'Pozycja GPS działa tylko przez połączenie HTTPS — otwórz aplikację adresem https://':'GPS position only works over HTTPS — open the app at an https:// address',
  'Ta przeglądarka nie udostępnia pozycji GPS':'This browser does not provide a GPS position',
  // toasts, loading
  'Ładowanie kwadratów z bazy…':'Loading squares from the database…','Przybliż mapę (zoom 13+), żeby zobaczyć sugestie':'Zoom in (zoom 13+) to see suggestions',
  'Brak sugestii w widoku':'No suggestions in view','Połącz konto Strava w Profilu':'Connect your Strava account in Profile',
  'Importuję GPX…':'Importing GPX…','Importuję KML ze Squadrats.com…':'Importing KML from Squadrats.com…',
  'Dodaj punkt startu!':'Add a start point!','Dodaj start i metę!':'Add a start and a finish!',
  'Szukam najlepszej pętli (kilka sekund)…':'Looking for the best loop (a few seconds)…','Obliczam trasę…':'Calculating route…',
  'Sesja wygasła — zaloguj się ponownie':'Session expired — log in again','Brak trasy':'No route','Brak trasy powrotnej':'No way back found',
  'Przeliczam segment…':'Recalculating segment…','Błąd przeliczania segmentu':'Error recalculating segment','Trasa wyczyszczona':'Route cleared',
  'Obliczam powrót…':'Calculating way back…','Brak trasy do eksportu':'No route to export','Brak trasy do wysłania':'No route to send',
  'GPX dla Garmina pobrany — zaimportuj w connect.garmin.com → Kursy':'GPX for Garmin downloaded — import it at connect.garmin.com → Courses',
  'Ta przeglądarka nie udostępnia plików — GPX został pobrany':'This browser cannot share files — the GPX was downloaded instead',
  'Najpierw wyznacz trasę':'Plan a route first','Podaj nazwę trasy':'Enter a route name','Nie udało się usunąć trasy':'Could not delete the route',
  'Wczytuję trasę…':'Loading route…','Przybliż mapę (z14+), żeby oznaczać pojedyncze SQI':'Zoom in (z14+) to mark single SQI',
  'Ten SQI jest już zdobyty':'This SQI is already collected','SQI oznaczony jako niezdobywalny — trasy będą go pomijać':'SQI marked as uncollectable — routes will skip it',
  'Odznaczono — ten SQI znów jest do zdobycia':'Unmarked — this SQI can be collected again','Wpisz adres':'Enter an address',
  'Wyszukuję adres…':'Searching address…','Nie znaleziono adresu':'Address not found','Błąd geokodowania':'Geocoding error',
  'Potrzebny start i meta':'Start and finish needed','✅ Trasy rowerowe załadowane':'✅ Cycle routes loaded','✅ Ślady GPS z OpenStreetMap':'✅ GPS traces from OpenStreetMap',
  'Ślady GPS ©':'GPS traces ©','Działki ©':'Parcels ©','Ortofotomapa ©':'Orthophoto ©',
  '✅ Strava połączona!':'✅ Strava connected!','⚠️ Dodaj Client ID i Secret Strava w profilu':'⚠️ Add the Strava Client ID and Secret in your profile',
  'Skonfiguruj API Strava w Profilu aby zsynchronizować aktywności':'Set up the Strava API in Profile to sync activities',
  'Sprawdzam pokrycie trasy przez Google Street View…':'Checking Google Street View coverage of the route…',
  'Wylogowano':'Logged out','Dom usunięty':'Home removed','✅ Dom zapisany — będzie startem tras':'✅ Home saved — routes will start here',
  'Stuknij mapę w miejscu domu':'Tap the map where your home is',
  // auth
  'planuj trasy • zbieraj kwadraty • jeździj':'plan routes • collect squares • ride','Logowanie':'Log in','Rejestracja':'Sign up',
  'Nazwa użytkownika':'Username','Hasło':'Password','Zaloguj się':'Log in','Nazwa użytkownika *':'Username *',
  'Email (opcjonalny)':'Email (optional)','Hasło * (min. 8 znaków, 1 cyfra)':'Password * (min. 8 characters, 1 digit)','Powtórz hasło *':'Repeat password *',
  'min. 3 znaki':'min. 3 characters','twoj@email.com':'you@email.com','Min. 8 znaków i co najmniej 1 cyfra':'Min. 8 characters and at least 1 digit',
  'Konfiguracja Strava API':'Strava API setup','(opcjonalne)':'(optional)','Jak uzyskać klucze API Strava?':'How to get Strava API keys?',
  '1. Przejdź na':'1. Go to','2. Utwórz aplikację — w polu':'2. Create an app — in the','wpisz:':'field enter:','3. Skopiuj':'3. Copy',
  'i':'and','poniżej':'below','2. Utwórz lub edytuj aplikację':'2. Create or edit an app','4. Skopiuj':'4. Copy',
  'np. 12345':'e.g. 12345','Zarejestruj się':'Sign up','lub':'or','Kontynuuj z Google':'Continue with Google',
  'Zakładając konto lub logując się, akceptujesz':'By creating an account or logging in you accept the','Regulamin':'Terms','Politykę prywatności':'Privacy policy',
  'Loguję…':'Logging in…','Rejestruję…':'Signing up…','Błąd logowania':'Login error','Błąd rejestracji':'Sign-up error','Błąd sieci':'Network error',
  'Hasła nie są zgodne':'Passwords do not match','Błąd':'Error',
  // profile
  'Profil użytkownika':'User profile','Konto':'Account','Użytkownik':'User','Rola':'Role','Email':'Email',
  'Punkt startowy (Home)':'Start point (Home)','Domyślny punkt startu trasy — ustawiany automatycznie po zalogowaniu.':'Default route start — set automatically after you log in.',
  'Adres':'Address','np. Warszawa, Marszałkowska 10':'e.g. 10 Downing Street, London','Wskaż na mapie':'Pick on the map','Usuń Home':'Remove Home',
  'Nie ustawiono':'Not set','Połącz ze Stravą':'Connect with Strava','Prywatność i konto':'Privacy & account','Polityka prywatności':'Privacy policy',
  'Usunięcie konta jest nieodwracalne: kasuje aktywności, kwadraty, trasy, oznaczenia i klucz Garmina oraz odłącza aplikację od Twojego konta Strava.':'Deleting your account cannot be undone: it erases activities, squares, routes, markings and the Garmin key, and disconnects the app from your Strava account.',
  'Usuń konto':'Delete account','Usuń na zawsze':'Delete forever','Podaj hasło, aby potwierdzić':'Enter your password to confirm',
  'Wpisz nazwę użytkownika':'Type the username',', aby potwierdzić':'to confirm','Nie udało się usunąć konta':'Could not delete the account',
  'Nowe hasło (min. 8 znaków, 1 cyfra)':'New password (min. 8 characters, 1 digit)','Powtórz hasło':'Repeat password','Ustaw hasło':'Set password',
  'Obecne hasło':'Current password','Nowe hasło':'New password','Powtórz nowe hasło':'Repeat new password','Zmień hasło':'Change password',
  '✅ Połączona':'✅ Connected','jako':'as','⚠️ Klucze zapisane — kliknij':'⚠️ Keys saved — click','Nie skonfigurowana — dodaj Client ID i Secret':'Not set up — add the Client ID and Secret',
  '✅ Konfiguracja Strava zapisana':'✅ Strava setup saved','Najpierw zapisz Client ID i Secret':'Save the Client ID and Secret first',
  'Wpisz nowe hasło':'Enter a new password','Hasło min. 8 znaków i co najmniej 1 cyfra':'Password: min. 8 characters and at least 1 digit',
  '✅ Hasło ustawione':'✅ Password set','✅ Hasło zmienione':'✅ Password changed','Wypełnij wszystkie pola':'Fill in all fields',
  // admin
  'Panel Administratora':'Admin panel','Błąd ładowania':'Loading error','Brak użytkowników':'No users','✓ Połączona':'✓ Connected',
  'Klucze OK':'Keys OK','Nie':'No','Usuń':'Delete','To Ty':'You','Usuń admina':'Remove admin','Nadaj admina':'Make admin',
  'Login':'Login','Data':'Date','Akcje':'Actions',
  // backend errors
  'Nie zalogowany':'Not logged in','Nieprawidłowy token':'Invalid token','Tylko administrator':'Administrators only',
  'Zbyt wiele prób rejestracji. Spróbuj ponownie za godzinę.':'Too many sign-up attempts. Try again in an hour.',
  'Zbyt wiele prób logowania. Spróbuj ponownie za 15 minut.':'Too many login attempts. Try again in 15 minutes.',
  'Nazwa użytkownika i hasło są wymagane':'Username and password are required','Nazwa użytkownika min. 3 znaki':'Username: min. 3 characters',
  'Nazwa użytkownika jest zajęta':'Username is taken','Email jest już zarejestrowany':'Email is already registered',
  'Wymagana nazwa i hasło':'Username and password required','Nieprawidłowe dane logowania':'Invalid login details',
  'Użytkownik nie istnieje':'User does not exist','Wymagane oba hasła':'Both passwords are required',
  'Konto social login nie ma hasła. Możesz ustawić nowe hasło bez podawania obecnego.':'A social-login account has no password. You can set a new one without the current password.',
  'Nieprawidłowe obecne hasło':'Incorrect current password','Nieprawidłowe koordynaty':'Invalid coordinates',
  'Konto ma już hasło. Użyj opcji zmiany hasła.':'The account already has a password. Use change password.',
  'Nieprawidłowe hasło':'Incorrect password','Wpisz swoją nazwę użytkownika, aby potwierdzić':'Type your username to confirm',
  'Jesteś jedynym administratorem. Najpierw nadaj komuś rolę admina.':'You are the only administrator. Make someone else an admin first.',
  'Nie możesz zmienić własnej roli':'You cannot change your own role','Nieprawidłowa rola':'Invalid role',
  'Nie możesz usunąć własnego konta':'You cannot delete your own account','Nie ma takiej trasy':'No such route',
  'Brak trasy do zapisania':'No route to save','Brak punktów trasy':'No route points','Pusty plik KML':'Empty KML file',
  'Błędne zapytanie Overpass':'Bad Overpass query','Serwery OpenStreetMap (Overpass) są teraz przeciążone':'OpenStreetMap (Overpass) servers are overloaded right now',
  'Brak lokalnej bazy POI':'No local POI database','Zapisany:':'Saved:',
  'Asfalt / Beton':'Asphalt / concrete','Szuter / Gravel':'Gravel','brak trasy':'no route',
  'Konto i wszystkie dane zostały usunięte.':'The account and all its data have been deleted.',
};

// Texts with variable parts: {} matches anything; $1.. in the English template
// receive the captured parts, themselves translated when they match.
const EN_RX=[
  ['Załadowano: {} SQ, {} SQI','Loaded: $1 SQ, $2 SQI'],
  ['Błąd ładowania danych: {}','Error loading data: $1'],
  ['Oznaczyć {} SQI bez dróg jako niezdobywalne? Trasy będą je pomijać. Każdy możesz odznaczyć trzema kliknięciami.','Mark $1 SQI without roads as uncollectable? Routes will skip them. You can unmark each one with three clicks.'],
  ['Oznaczono {} SQI jako niezdobywalne','Marked $1 SQI as uncollectable'],
  ['brakuje {} ({} bez drogi) · +{}','$1 missing ($2 without a road) · +$3'],
  ['brakuje {} · +{}','$1 missing · +$2'],
  ['najcenniejsze {} ·','most valuable $1 ·'],['dobre {} ·','good $1 ·'],
  ['pozostałe {}. Przerywana ramka — brak drogi w OSM.','other $1. Dashed frame — no road in OSM.'],
  ['Najbliższe cele Über (Übersquadratinho {})','Nearest Über goals (Übersquadratinho $1)'],
  ['{} z {} · bez dróg: {} · oznaczone: {}','$1 of $2 · no roads: $3 · marked: $4'],
  ['Pobieranie aktywności: {}…','Fetching activities: $1…'],
  ['✅ Gotowe! +{} SQ, +{} SQI','✅ Done! +$1 SQ, +$2 SQI'],
  ['Sync: {} aktywności · +{} nowych SQ · +{} nowych SQI','Sync: $1 activities · +$2 new SQ · +$3 new SQI'],
  ['❌ Błąd: {}','❌ Error: $1'],['Błąd sync: {}','Sync error: $1'],['Błąd: {}','Error: $1'],
  ['GPX: {} pts → +{} SQ, +{} SQI · łącznie {} SQ','GPX: $1 pts → +$2 SQ, +$3 SQI · $4 SQ in total'],
  ['Błąd GPX: {}','GPX error: $1'],
  ['Squadrats KML: brak nowych kwadratów — już zsynchronizowane (masz {} SQ / {} SQI)','Squadrats KML: no new squares — already in sync (you have $1 SQ / $2 SQI)'],
  ['Squadrats KML: +{} nowych SQ, +{} nowych SQI · łącznie {} SQ / {} SQI','Squadrats KML: +$1 new SQ, +$2 new SQI · $3 SQ / $4 SQI in total'],
  ['Błąd importu KML: {}','KML import error: $1'],['Błąd parsowania KML: {}','KML parse error: $1'],
  ['⚠️ OSRM (BRouter niedostępny)','⚠️ OSRM (BRouter unavailable)'],
  ['✅ {}km · {} nowych SQ · {} nowych SQI · {}','✅ $1 km · $2 new SQ · $3 new SQI · $4'],
  ['✅ {}km · {} nowych SQ · {} nowych SQI','✅ $1 km · $2 new SQ · $3 new SQI'],
  ['✅ {}km · popularne drogi {} · {}','✅ $1 km · popular roads $2 · $3'],
  ['✅ A→B {}km · {}','✅ A→B $1 km · $2'],
  ['✅ Pętla {}km · {} SQ · {} SQI · {}','✅ Loop $1 km · $2 SQ · $3 SQI · $4'],
  ['Błąd powrotu: {}','Way back error: $1'],
  ['Nie udało się udostępnić: {}','Could not share: $1'],['Nie udało się zapisać: {}','Could not save: $1'],
  ['Usunięto: {}','Deleted: $1'],['Wczytano: {} · teraz +{} nowych SQI','Loaded: $1 · now +$2 new SQI'],
  ['Nie udało się wczytać trasy: {}','Could not load the route: $1'],
  ['Dokładność {} m · zaplanuj trasę, by widzieć postęp','Accuracy $1 m · plan a route to see progress'],
  ['Poza trasą: {} m · najbliżej km {}','Off route: $1 m · nearest km $2'],
  ['km {} z {} · zostało {} km · {} m od trasy','km $1 of $2 · $3 km to go · $4 m off route'],
  ['km {} z {} · zostało {} km','km $1 of $2 · $3 km to go'],
  ['Nowe kwadraty z ostatniej jazdy: +{} SQ, +{} SQI','New squares from your last ride: +$1 SQ, +$2 SQI'],
  ['Start ustawiony: {}','Start set: $1'],['Meta ustawiony: {}','Finish set: $1'],
  ['Widoczne od zoomu {} — przybliż mapę','Visible from zoom $1 — zoom in'],
  ['Rola zmieniona → {}','Role changed → $1'],['Zmienić rolę na "{}"?','Change the role to "$1"?'],
  ['Usunąć użytkownika "{}"?\nUsuwa też WSZYSTKIE jego dane (kwadraty, aktywności)!','Delete user "$1"?\nThis also deletes ALL their data (squares, activities)!'],
  ['Użytkownik {} usunięty','User $1 deleted'],['Użytkownicy ({})','Users ($1)'],
  ['Logujesz się przez {} — możesz ustawić hasło awaryjne:','You log in with $1 — you can set a backup password:'],
  ['Ta sama droga dwa razy: {} trasy','Same road twice: $1 of the route'],
  ['Popularne drogi: {} trasy · szlaki/DDR {}','Popular roads: $1 of the route · signposted routes/cycle paths $2'],
  ['· {} nowe SQ · {} nowe SQI','· $1 new SQ · $2 new SQI'],
  ['Start: {} · Pętla · {} km','Start: $1 · Loop · $2 km'],['Start: {} · A → B · {} km','Start: $1 · A → B · $2 km'],
  ['Start ustawiony · Pętla · {} km','Start set · Loop · $1 km'],['Start ustawiony · A → B · {} km','Start set · A → B · $1 km'],
  ['📚 {} ciekawych miejsc z Wikipedii','📚 $1 places of interest from Wikipedia'],
  ['{} · przy trasie','$1 · on the route'],
  ['Dane: OpenStreetMap, stan na {}','Data: OpenStreetMap, as of $1'],
  ['{} m od trasy','$1 m off route'],['{} km od trasy','$1 km off route'],
  ['Tylko punkty najwyżej {} m od trasy — bez zjeżdżania','Only points at most $1 m off the route — no detours'],
  ['Obejrzyj panoramę w {} →','View the panorama on $1 →'],['Zobacz w {} →','View on $1 →'],
];

// Fragments inside longer texts (Leaflet joins map attributions into one node)
const EN_SUB=[['Ślady GPS ©','GPS traces ©'],['Ortofotomapa ©','Orthophoto ©'],['Działki ©','Parcels ©'],['Bank Danych o Lasach','Forest Data Bank']];

const esc=s=>s.replace(/[.*+?^$()|[\]\\]/g,'\\$&');
const RX=EN_RX.map(([pl,en])=>[new RegExp('^'+pl.split('{}').map(esc).join('(.+?)')+'$','s'),en]);
const NUM=/(\d),(\d)/g;  // Polish decimal comma
// localStorage 'sq-i18n-debug' collects texts left untranslated in window.i18nMiss
let MISS=null;
try{if(localStorage.getItem('sq-i18n-debug')) MISS=window.i18nMiss=new Set();}catch(e){}

function trKey(k,depth){
  let r=EN[k];
  if(r!=null) return r;
  if(depth>2) return null;
  for(const [re,tpl] of RX){
    const m=k.match(re);
    if(m) return tpl.replace(/\$(\d)/g,(_,i)=>{const p=m[+i]; return (trKey(p,depth+1)??p).replace(NUM,'$1.$2');});
  }
  let out=k;
  for(const [pl,en] of EN_SUB) out=out.split(pl).join(en);
  return out===k?null:out;
}
// English for a Polish text, keeping its surrounding whitespace; null if unknown
function tr(s){
  if(lang!=='en'||!/[A-Za-zÀ-ž]/.test(s)) return null;
  const k=s.replace(/\s+/g,' ').trim();
  const r=trKey(k,0);
  if(r==null){ if(MISS&&/[a-ząćęłńóśźż]{3}/i.test(k)) MISS.add(k); return null; }
  return s.match(/^\s*/)[0]+r+s.match(/\s*$/)[0];
}

// DOM translation; originals are kept so the language can switch both ways
const ATTRS=['title','placeholder','aria-label','alt'];
const SKIP=/^(SCRIPT|STYLE|CODE|TEXTAREA|PRE)$/;
const textOrig=new WeakMap(), attrOrig=new WeakMap();
function doText(n){
  const rec=textOrig.get(n);
  const src=rec&&n.data===rec.t?rec.o:n.data;
  const t=tr(src)??src;
  textOrig.set(n,{o:src,t});
  if(n.data!==t) n.data=t;
}
function doAttr(el,a){
  const v=el.getAttribute(a); if(v==null) return;
  let m=attrOrig.get(el); if(!m) attrOrig.set(el,m={});
  const rec=m[a], src=rec&&v===rec.t?rec.o:v;
  const t=tr(src)??src;
  m[a]={o:src,t};
  if(v!==t) el.setAttribute(a,t);
}
function walk(root){
  if(root.nodeType===3){ if(!root.parentNode||!SKIP.test(root.parentNode.nodeName)) doText(root); return; }
  if(root.nodeType!==1||SKIP.test(root.nodeName)||root.classList?.contains('notranslate')) return;
  for(const a of ATTRS) if(root.hasAttribute(a)) doAttr(root,a);
  for(let c=root.firstChild;c;c=c.nextSibling) walk(c);
}
const obs=new MutationObserver(list=>{
  for(const m of list){
    if(m.type==='characterData') walk(m.target);
    else if(m.type==='attributes') doAttr(m.target,m.attributeName);
    else m.addedNodes.forEach(walk);
  }
});
// Observing from <head> on also catches the markup as the parser adds it,
// so the Polish original never gets painted in English mode
function start(){
  obs.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:ATTRS});
  if(document.body) walk(document.body);
}

// Public API
window.LANG=lang;
// Translate a string used outside the DOM (confirm, alert, input values)
window.t=s=>(lang==='en'&&trKey(s,0))||s;
// Pick between a Polish and an English variant built in code
window.tl=(pl,en)=>lang==='en'?en:pl;
window.locale=()=>lang==='en'?'en-GB':'pl-PL';
window.setLang=l=>{
  if(l===lang||(l!=='pl'&&l!=='en')) return;
  lang=window.LANG=l;
  try{localStorage.setItem(KEY,l);}catch(e){}
  document.documentElement.lang=l;
  syncUi();
  walk(document.body);
  window.dispatchEvent(new Event('langchange'));
};
function syncUi(){
  document.querySelectorAll('[data-lang]').forEach(b=>b.classList.toggle('on',b.dataset.lang===lang));
  const ml=document.getElementById('manual-link'); if(ml) ml.href=lang==='en'?'/docs/en.html':'/docs/';
}
document.documentElement.lang=lang;
start();
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>{syncUi();walk(document.body);}); else syncUi();
})();
