# Plan testów Squadrats Route Planner

Stan: 2026-11-11. Wynik ostatniego przebiegu: **API 129/129, przeglądarka–komputer 34/34, przeglądarka–telefon 34/34**. Przed poprawkami: API 44/79, komputer 10/22, telefon 7/22.

## Jak uruchomić

```bash
tests/stack.sh up            # osobny backend na localhost:3100 z pustą bazą (nie dotyka ./data/squadrats.db) + atrapa Stravy na :3101 + atrapa pozostałych usług na :3102 (StatsHunters, MET Norway, Apple, skrzynka SMTP)
node tests/api.mjs           # 129 testów API (ok. 25 s)
node tests/e2e.mjs desktop   # 34 scenariusze w Chromium, okno 1440×900 (ok. 130 s)
node tests/e2e.mjs mobile    # te same scenariusze na ekranie telefonu 390×844, dotyk (ok. 150 s)
node tests/perf.mjs          # pomiary wydajności (ok. 2 min)
tests/stack.sh down          # usuwa stos testowy i jego bazę
```

Wymagania: Docker z obrazem `squadrats-v2-backend` i działającym kontenerem BRouter, Node 22, Chromium (`/snap/bin/chromium`). Żadnych zależności npm. Zestaw przeglądarkowy uruchamiaj zawsze w całości: scenariusze korzystają z kont założonych w pierwszych krokach.

Wyniki: `tests/results/*.json`, zrzuty ekranu: `tests/shots/`. Po zmianie w `backend/src` trzeba zrobić `docker restart sq-test-backend`; zmiany we frontendzie działają od razu.

## Zasady (metodologia)

- **Izolacja.** Testy działają wyłącznie na stosie testowym (`localhost:31xx`, sprawdzane w `lib.mjs`); zakładają i usuwają konta, więc nigdy nie idą na prawdziwą bazę. Hasło admina i klucz sesji stosu są losowe (`tests/.stack.env`, poza gitem).
- **Bez zewnętrznych usług.** Testy nie wołają Stravy, Google, Mapillary, Overpassa ani Wikipedii i nie używają prawdziwych tokenów. Trasy liczy lokalny BRouter. Stravę zastępuje atrapa `tests/strava-mock.mjs` (kontener `sq-test-strava`): ekran zgody, wymiana kodu na tokeny, lista aktywności, cofnięcie autoryzacji. Testy sterują nią przez `/__state` (kto jest „zalogowany na Stravie”, odmowa, limit kont, 429, cofnięty dostęp).
- **Piramida.** Dużo szybkich testów API (kontrakt, uprawnienia, walidacja), mniej scenariuszy w przeglądarce (to, co widzi człowiek), osobno pomiary.
- **Techniki.** Klasy równoważności i wartości brzegowe (limity długości, zakresy współrzędnych), dane śmieciowe (fuzz: `null`, tablice, obiekty, `NaN`, bardzo długie teksty) na każdym wejściu, testy negatywne uprawnień (macierz „kto co może”), współbieżność (równoległe żądania wielu kont), testy stanu (sesja wygasa, konto znika w trakcie pracy), testy regresji dla każdego znalezionego błędu.
- **Wiele kont.** Każdy test zakłada własne konta; „osoby” mają osobne adresy IP (`X-Forwarded-For`, backend testowy ma `TRUST_PROXY=1`), więc limity prób nie sprzęgają testów.
- **Waga błędu.** 1 krytyczny (awaria serwera, przejęcie konta, wyciek danych), 2 poważny (funkcja nie działa, dane innej osoby), 3 średni, 4 kosmetyczny.
- **Przeglądarka.** Prawdziwy Chromium sterowany przez CDP: kliknięcia i dotyk w prawdziwe współrzędne (element zasłonięty = błąd), błędy konsoli i nieudane żądania zbierane po każdym kroku.

## 1. API — `tests/api.mjs` (100)

### Konta i sesje (AUTH, 20)
| Id | Co sprawdza |
|---|---|
| AUTH-01 | rejestracja: konto, ciasteczko httpOnly + SameSite |
| AUTH-02 | walidacja rejestracji (krótka nazwa, słabe hasło, braki) |
| AUTH-03 | zajęta nazwa (bez względu na wielkość liter) i e-mail → 409 |
| AUTH-04 | nazwa/hasło/e-mail nie-tekstowe → 400, serwer działa dalej |
| AUTH-05 | nazwa z HTML, za długa, ze znakami sterującymi → odrzucona |
| AUTH-06 | logowanie nazwą i e-mailem; złe hasło i nieznane konto → to samo 401 |
| AUTH-07 | logowanie danymi nie-tekstowymi → 4xx, serwer działa dalej |
| AUTH-08 | logowanie hasłem na konto Google (bez hasła) → 401 |
| AUTH-09 | `/me`: brak, śmieci, zły podpis, `alg=none`, wygasły token → 401 |
| AUTH-10 | token nieistniejącego użytkownika → 401 na każdym endpoincie |
| AUTH-11 | wylogowanie czyści ciasteczko |
| AUTH-12 | zmiana hasła: złe obecne 403, słabe 400, poprawna działa |
| AUTH-13 | zmiana hasła unieważnia sesje na innych urządzeniach |
| AUTH-14 | usunięcie konta: złe hasło 403; potem brak danych i logowania |
| AUTH-15 | stary token usuniętego konta nie tworzy danych |
| AUTH-16 | limit prób logowania na adres (11. → 429), inne adresy bez wpływu |
| AUTH-17 | limit rejestracji na adres (6. → 429) |
| AUTH-18 | jedyny administrator nie usunie swojego konta |
| AUTH-19 | `set-password` tylko dla konta bez hasła |
| AUTH-20 | równoczesna rejestracja tej samej nazwy: jedno 200, reszta 409 |

### Wielu użytkowników (MU, 17)
| Id | Co sprawdza |
|---|---|
| MU-01 | trasy: B nie widzi, nie pobierze, nie zmieni i nie usunie trasy A |
| MU-02 | kwadraty: import A nie zmienia kwadratów ani statystyk B i C |
| MU-03 | ta sama trasa: dla A 0 nowych, dla B nowe (liczone z własnych kwadratów) |
| MU-04 | zablokowane SQI osobne dla każdego konta |
| MU-05 | dom, warstwy i klucz Garmin osobne |
| MU-06 | Garmin: klucz A → kwadraty A, klucz B → B; zły klucz 401; nowy unieważnia stary |
| MU-07 | sekret Strava nie wraca w żadnej odpowiedzi; `strava_own_keys` tylko u osoby z własnymi kluczami |
| MU-08 | panel admina: zwykły użytkownik 403, niezalogowany 401 |
| MU-09 | admin: lista bez haseł; nadanie/odebranie roli; własnej roli i konta nie ruszy |
| MU-10 | admin usuwa użytkownika: dane znikają, jego sesja przestaje działać |
| MU-11 | admin: nieistniejący użytkownik → 404 |
| MU-12 | admin czyta dziennik błędów przeglądarek (`/api/log`) |
| MU-13 | równoległa praca 3 kont (60 żądań): każdy kończy z własnymi danymi |
| MU-14 | dwie sesje jednego konta widzą te same dane |
| MU-15 | synchronizacja bez Stravy: błąd tylko dla tego konta |
| MU-16 | wspólna pamięć zdjęć nie przemyci HTML ani obcych adresów do innych kont |
| MU-17 | 46 aktywnych kont (więcej niż limit pamięci podręcznej 40): dane każdego poprawne i osobne |

### Funkcje (FN, 14)
| Id | Co sprawdza |
|---|---|
| FN-01 | trasa: zapis i odczyt zachowują wszystkie pola (nazwy punktów, profil, wysokości) |
| FN-02 | lista tras: najnowsza pierwsza, miniatura i przewyższenie |
| FN-03 | GPX: poprawny XML, znaki `&<>"` zabezpieczone, nazwane punkty jako `<wpt>` |
| FN-04 | zmiana nazwy trasy: przycinanie do 80 znaków, pusta → 400 |
| FN-05 | usunięcie trasy: znika z listy, drugi raz 404 |
| FN-06 | kwadraty 5×5: 25 SQ, Yard 9, Übersquadrat 5 |
| FN-07 | kwadraty w prostokącie (bbox) = filtr pełnej listy |
| FN-08 | zablokowany SQI nie liczy się jako nowy; zdobytego nie da się zablokować |
| FN-09 | priorytety i statystyka zasięgu dla konta z domem i bez |
| FN-09b | statystyka zasięgu: wynik zapamiętany, po nowych kwadratach liczony od nowa, osobno na konto |
| FN-10 | odcinek rysowany (`/route/leg`): geometria po drogach, sensowna długość |
| FN-11 | A→B „najkrócej” oraz z celem km (objazd po nowe kwadraty) |
| FN-12 | pętla z jednego punktu ok. 20 km: wraca na start, długość ±25% |
| FN-13 | POI wzdłuż trasy z lokalnej bazy |

### Walidacja wejścia (VAL, 22)
VAL-01…VAL-22: każde wejście (zapis trasy, odcinek, planowanie, blokowanie SQI pojedyncze i hurtowe, dom, warstwy, import GPX/KML, podgląd kwadratów, POI, zdjęcia, parametry w adresie, błędny JSON, nieistniejący adres, dziennik przeglądarki) dostaje dane śmieciowe i wartości brzegowe. Oczekiwane: odpowiedź 4xx w formacie JSON, nigdy 500, nigdy ślad stosu, serwer działa dalej, zapisane dane nie psują później listy ani GPX.

### Bezpieczeństwo (SEC, 8)
| Id | Co sprawdza |
|---|---|
| SEC-01 | każdy endpoint danych wymaga logowania |
| SEC-02 | nagłówki (nosniff, ramki, referrer), brak `X-Powered-By` |
| SEC-03 | duże żądanie bez logowania odrzucane (413), nie parsowane |
| SEC-04 | żądanie z obcej strony (CSRF) nie zmienia danych: przeglądarka oznacza je nagłówkiem `Sec-Fetch-Site: cross-site` → 403; ciasteczko ma dodatkowo SameSite=Lax |
| SEC-05 | `/api/health` nie zdradza liczby kont |
| SEC-06 | pokrycie Street View: liczba punktów ograniczona (każdy punkt = płatne zapytanie do Google) |
| SEC-07 | token stanu OAuth nie działa jako sesja, a sesja jako stan |
| SEC-08 | w kodzie nie ma domyślnego sekretu JWT ani logowania haseł |

### Strava jednym kliknięciem (STR, 15)
| Id | Co sprawdza |
|---|---|
| STR-01 | ekran logowania: przycisk Stravy włączony, start ustawia jednorazowe ciasteczko |
| STR-02 | „Kontynuuj ze Stravą”: nowe konto, sesja i kwadraty bez żadnej konfiguracji |
| STR-03 | ponowne logowanie Stravą: to samo konto, nic się nie dubluje |
| STR-04 | logowanie Stravą: obcy lub brakujący jednorazowy kod → brak sesji |
| STR-05 | istniejące konto: „Połącz ze Stravą” jednym kliknięciem, potem logowanie Stravą trafia na to konto |
| STR-06 | połączenie zaczęte na jednym koncie nie podepnie Stravy do innego |
| STR-07 | odmowa albo brak zgody na aktywności → czytelny komunikat, konto nie powstaje |
| STR-08 | limit kont aplikacji Strava → komunikat dla użytkownika, bez konta i bez 5xx |
| STR-09 | odłączenie: Strava cofa autoryzację, tokeny znikają, kwadraty zostają |
| STR-10 | dwa konta z tym samym sportowcem: odłączenie jednego nie psuje drugiego |
| STR-11 | własne klucze API: zasady zapisu, sekret zostaje przy pustym polu, puste pola = wspólna aplikacja |
| STR-12 | limit zapytań (429) jednej aplikacji wstrzymuje tylko ją; połączenie nowej osoby działa mimo pauzy |
| STR-13 | wygasły token odświeża się sam; cofnięty na strava.com → prośba o ponowne połączenie |
| STR-14 | tokeny i sekret aplikacji nie wracają w żadnej odpowiedzi |
| STR-15 | usunięcie konta założonego Stravą: potwierdzenie nazwą, autoryzacja cofnięta |

### Zasięg tras (COV, 4)
| Id | Co sprawdza |
|---|---|
| COV-01 | zasięg: publiczna lista obszarów tras i regionów OSM (`/api/coverage`) |
| COV-02 | trasa poza Polską: Holandia, Francja, Hiszpania |
| COV-03 | poza zasięgiem: 422 `no-routing-data` z komunikatem zamiast błędu serwera (odcinek, trasa, pętla, jeden punkt poza) |
| COV-04 | punkt na środku morza: 422 `no-road-near`, także gdy BRouter przyciąga do linii promowej 25 km dalej |

### Konto przez e-mail (ACC, 6)
| Id | Co sprawdza |
|---|---|
| ACC-01 | zapomniane hasło: list z linkiem (token we fragmencie adresu, w bazie tylko skrót), nowe hasło loguje, stare sesje i stare hasło przestają działać, link działa raz |
| ACC-02 | nieznany adres dostaje tę samą odpowiedź i żadnego listu; błędne adresy → 400 |
| ACC-03 | najwyżej 3 listy na godzinę na konto, 6 próśb z jednego adresu IP |
| ACC-04 | język listu (de, cs), nieznany język → polski; użycie jednego linku kasuje pozostałe |
| ACC-05 | śmieciowe tokeny → 400, bez 5xx |
| ACC-06 | adres e-mail w profilu: wymaga obecnego hasła, zajęty → 409, zmiana unieważnia wysłane linki, usunięcie adresu |

### Logowanie Apple (APL, 5)
| Id | Co sprawdza |
|---|---|
| APL-01 | start prowadzi do Apple z właściwymi parametrami (`form_post`) i jednorazowym ciasteczkiem |
| APL-02 | pierwsze logowanie zakłada konto, kolejne (bez adresu e-mail) trafia na to samo |
| APL-03 | odpowiedź bez ciasteczka tej przeglądarki, z cudzym albo przerobionym stanem → brak sesji |
| APL-04 | rezygnacja i zły kod → komunikat, konto nie powstaje |
| APL-05 | formularz zwrotny (jedyny wyjątek od blokady żądań z obcych stron) przepuszcza tylko code/state/error i nie daje sesji |

### Link do trasy (SHR, 4)
| Id | Co sprawdza |
|---|---|
| SHR-01 | link widoczny bez konta, bez danych autora, początek i koniec ucięte |
| SHR-02 | strona `/s/…`, GPX (te same ucięte punkty) i nazwa z HTML-em są bezpieczne |
| SHR-03 | „pokaż całą” zachowuje adres; cudzej trasy nie da się udostępnić ani wyłączyć |
| SHR-04 | wyłączony, śmieciowy i po usunięciu trasy → 404; ponowne włączenie daje nowy adres |

### Pogoda (WX, 3), importy (IMP, 4), pieszo/bieg (FOOT, 2), instalacja (PWA, 1), wiatr (WND, 1), języki (I18N, 3)
| Id | Co sprawdza |
|---|---|
| WX-01 | prognoza godzinowa z wiatrem, źródło podane, wymaga logowania, błędne współrzędne → 400 |
| WX-02 | jedno zapytanie do MET na komórkę 0,1° (pamięć podręczna), User-Agent bez adresu e-mail |
| WX-03 | awaria MET → 502 z komunikatem dla nowego miejsca; zapamiętana prognoza nadal działa |
| IMP-01 | StatsHunters: kwadraty ze wszystkich stron listy, drugi import nic nie dubluje, nic nie trafia na cudze konto |
| IMP-02 | StatsHunters: pusty link, nieistniejący kod i cudze adresy (SSRF) → 400, serwer nie pyta nikogo innego |
| IMP-03 | VeloViewer: KML z kafelkami Explorer → te same kwadraty z14, bez duplikatów |
| IMP-04 | VeloViewer: pusty i śmieciowy plik → 400 |
| FOOT-01 | profil pieszy i biegowy: trasa po ścieżkach; wskazówki skrętów wskazują punkty trasy i leżą na zakrętach linii |
| FOOT-02 | zapisana trasa przechowuje wskazówki i profil; błędne wskazówki są odrzucane |
| PWA-01 | manifest, ikony (rozmiary zgodne z manifestem) i service worker serwowane poprawnie |
| WND-01 | pętla „pod wiatr na początek” leży po stronie, z której wieje (wiatr z N i z S) |
| I18N-01 | każdy plik języka (de, nl, fr, cs) ma wszystkie teksty, z tymi samymi polami i znacznikami |
| I18N-02 | teksty składane w kodzie i komunikaty serwera wychodzą w wybranym języku; każdy komunikat serwera ma wersję angielską |
| I18N-03 | pliki języków są serwowane |

## 2. Przeglądarka — `tests/e2e.mjs` (34 scenariusze × komputer i telefon)

| Id | Scenariusz |
|---|---|
| E-01 | bez logowania widać tylko okno logowania, aplikacja pod spodem niedostępna |
| E-02 | rejestracja: niezgodne hasła → komunikat, konto nie powstaje |
| E-03 | rejestracja przez formularz: wejście do aplikacji, nazwa w nagłówku, brak przycisku admina |
| E-04 | logowanie: złe hasło → komunikat; dobre → wejście (po wylogowaniu z menu) |
| E-05 | trasa A→B: start i meta na mapie, „Wyznacz trasę”, kilometry przy punktach |
| E-06 | zapis trasy z karty trasy i lista „Moje trasy” |
| E-07 | „Moje trasy”: zmiana nazwy, otwarcie na mapie, usunięcie z potwierdzeniem |
| E-08 | rysowanie: trzy punkty, cofnij, ponów, „Gotowe” |
| E-09 | import GPX z pliku: kwadraty pojawiają się na koncie |
| E-10 | wygasła sesja: okno logowania z wyjaśnieniem, trasa zostaje, po zalogowaniu da się ją zapisać |
| E-11 | zmiana konta w tej samej przeglądarce: nic po poprzedniej osobie |
| E-12 | panel admina: złośliwa nazwa użytkownika nie uruchamia kodu (XSS) |
| E-13 | po wylogowaniu admina zwykły użytkownik nie widzi „Panelu admina” |
| E-14 | warstwy zapamiętane na koncie; na innym koncie domyślne |
| E-15 | profil: zmiana hasła i usunięcie konta z aplikacji |
| E-16 | błąd serwera i brak sieci przy liczeniu trasy: zrozumiały komunikat, ekran odblokowany, bez wylogowania |
| E-17 | język EN: brak polskich napisów w widocznym interfejsie |
| E-18 | układ na 360, 390, 820, 1280 i 1440 px: nic nie wystaje, przyciski na mapie nie zasłaniają się nawzajem |
| E-19 | dotyk: każdy przycisk ma co najmniej 40 px w 9 stanach aplikacji i w oknie logowania (telefon) |
| E-20 | ładowanie strony: wielkość i czas (pomiar) |
| E-21 | dwie osoby naraz (komputer + telefon): każda widzi tylko swoje trasy i kwadraty |
| E-22 | admin usuwa konto w trakcie sesji: użytkownik trafia do logowania |
| E-23 | Strava jednym kliknięciem: przycisk na ekranie logowania → konto, kwadraty i mapa na miejscu jazd; odłączenie i ponowne połączenie w Profilu |
| E-24 | Strava: odmowa na ekranie Stravy → komunikat na ekranie logowania, bez konta |
| N-01 | zapomniane hasło: prośba z ekranu logowania, link z listu, nowe hasło i od razu zalogowany; token znika z paska adresu |
| N-02 | Apple: przycisk na ekranie logowania → konto i wejście do aplikacji |
| N-03 | profil: zmiana adresu e-mail wymaga hasła, nowy adres widać od razu |
| N-04 | profil pieszy: zakres km i tempo przestawione; skręty na trasie, zapowiedź z wyprzedzeniem, komenda przy skręcie, „poza trasą” i „wracasz na trasę” |
| N-05 | link do trasy: tworzenie w „Moje trasy”, strona odbiorcy bez konta (bez autora, bez przewijania w poziomie), otwarcie w planerze na innym koncie, wyłączenie |
| N-06 | cudzy GPX jako trasa: plik wczytuje się do planera; zepsuty plik daje komunikat i niczego nie zmienia |
| N-07 | pogoda na karcie trasy i pętla pod wiatr: planer dostaje kierunek wiatru, pętla leży po stronie wiatru |
| N-08 | import kwadratów ze StatsHunters (link) i VeloViewer (plik KML) |
| N-09 | bez sieci (także service worker): aplikacja otwiera się z kopii z kontem, kwadratami i zapisaną trasą, znacznik „Offline”, planowanie mówi o braku połączenia; wylogowanie czyści kopie danych |
| N-10 | języki: wybór z listy (de, nl, fr, cs), brak polskich napisów, teksty z kodu i komunikaty głosowe w wybranym języku, język zostaje po odświeżeniu |

## 3. Wydajność — `tests/perf.mjs`

Konto z 4 500 SQ i 52 000 SQI (jak po kilku latach jazdy), potem 25 takich kont naraz.

| Pomiar | Przed | Po |
|---|---|---|
| statystyka zasięgu, promień 50 km (panel Kwadraty) | 415 ms, serwer zablokowany | 20 ms pierwszy raz, potem 1 ms |
| statystyka zasięgu, promień 100 km | 1 970 ms, serwer zablokowany | 60 ms, potem 1 ms |
| kwadraty bez drogi (400×400) | 405 ms | 46 ms |
| priorytety, pierwsze liczenie | 280–320 ms | 140–220 ms |
| 25 osób liczy priorytety naraz | 6,7 s | 2,8 s |
| pamięć backendu po 25 dużych kontach | 607 MB, bez limitu | 462 MB, limit 40 kont |
| wczytanie kwadratów (`/api/tiles/all`) | 33 ms, 1,3 MB (135 kB po kompresji) | bez zmian |
| pętla 30 km / 80 km | 2,2 s / 9,4 s (inni czekają najwyżej 0,16 s) | bez zmian (czas BRoutera) |
| strona na komputerze | pierwszy obraz 0,15–0,19 s, kwadraty po 0,2 s | — |
| strona na telefonie 4G | pierwszy obraz 0,55 s, kwadraty po 1,3 s, load 2,1 s | — |

## 4. Czego testy nie obejmują

- Prawdziwych usług StatsHunters, VeloViewer, Apple i poczty: testy idą na atrapach (`tests/services-mock.mjs`). Format odpowiedzi StatsHunters i pliku KML z VeloViewer przyjęto z opisu, bez sprawdzenia na prawdziwym koncie.
- Prawdziwej syntezy mowy: sprawdzane jest, co aplikacja każe powiedzieć, nie to, czy telefon to wypowiada.
- Jakości tłumaczeń de/nl/fr/cs (są maszynowe): sprawdzana jest kompletność i zgodność pól, nie styl.
- Prawdziwego logowania przez Google (wymaga zewnętrznego konta; sprawdzane są tylko zabezpieczenia wokół niego) i prawdziwej Stravy: cały przepływ idzie na atrapie, więc zmiany po stronie Stravy (wygląd ekranu zgody, limity, nowe pola) trzeba sprawdzić ręcznie na własnym koncie.
- Garmin Connect IQ na zegarku/liczniku (sprawdzany jest tylko endpoint danych).
- Jakości tras (czy trasa jest „ładna”) — tylko poprawność: po drogach, długość w tolerancji, powrót na start.
- Safari na iOS — testy idą w Chromium z emulacją dotyku; zachowania specyficzne dla Safari (arkusz udostępniania, klawiatura) trzeba sprawdzić ręcznie na telefonie.
