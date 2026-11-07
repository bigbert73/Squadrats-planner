// Builds the Squadrats user manual in two languages from one source:
//   node frontend/docs/tools/build.mjs   →  frontend/docs/index.html (PL), frontend/docs/en.html (EN)
// Every text is a [pl, en] pair, so both versions always share the same structure.
// Screenshots live in frontend/docs/img (d-* computer, m-* phone; English UI in img/en);
// refresh them with tools/docshots.mjs + tools/steps.mjs (DOCS_LANG=en for img/en).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let commit = '';
try { commit = execSync('git rev-parse --short HEAD', { cwd: DIR }).toString().trim(); } catch {}
const today = new Date();

const ICON = {
  desk: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
};

function build(L) {
  const T = (pair) => (Array.isArray(pair) ? pair[L === 'pl' ? 0 : 1] : pair);
  const pl = L === 'pl';
  // English pages show the English UI when that shot exists
  const IMG = (name) => (!pl && fs.existsSync(path.join(DIR, 'img/en', name + '.webp')) ? `img/en/${name}.webp` : `img/${name}.webp`);

  const desk = (name, cap) => `<figure><div class="frame-desk"><div class="bar"><i></i><i></i><i></i><span>squadrats · ${T(['komputer', 'computer'])}</span></div><img class="shot" src="${IMG(name)}" alt="${T(cap)}" loading="lazy" width="2160" height="1350"></div><figcaption><b>${T(['Komputer', 'Computer'])}</b>${T(cap)}</figcaption></figure>`;
  const phone = (name, cap) => `<figure><div class="frame-phone"><img class="shot" src="${IMG(name)}" alt="${T(cap)}" loading="lazy" width="975" height="2110"></div><figcaption><b>${T(['Telefon', 'Phone'])}</b>${T(cap)}</figcaption></figure>`;
  const screens = (d, p) => `<div class="screens${p ? '' : ' solo'}">${d ? desk(...d) : ''}${p ? phone(...p) : ''}</div>`;
  const howto = (d, p) => `<div class="howto">
      <section><h4>${ICON.desk}${T(['Na komputerze', 'On a computer'])}</h4><ol>${d.map(x => `<li>${T(x)}</li>`).join('')}</ol></section>
      <section><h4>${ICON.phone}${T(['Na telefonie', 'On a phone'])}</h4><ol>${p.map(x => `<li>${T(x)}</li>`).join('')}</ol></section>
    </div>`;
  const benefits = (items) => `<ul class="benefits">${items.map(([b, t]) => `<li><b>${T(b)}</b>${T(t)}</li>`).join('')}</ul>`;
  const chapter = (id, accent, eyebrow, title, lead, body) => ({ id, title, eyebrow, html: `
  <section class="chapter" id="${id}" style="--accent:var(${accent})">
    <header><span class="eyebrow">${T(eyebrow)}</span><h2>${T(title)}</h2><p class="lead">${T(lead)}</p></header>
    ${body}
  </section>` });

  // ── chapters ──────────────────────────────────────────────────────────────
  const chapters = [
    chapter('kwadraty', '--sqi', ['Zasady gry', 'How the game works'], ['Czym są kwadraty', 'What squares are'],
      ['Squadrats dzieli mapę świata na stałą siatkę. Każdy kwadrat, przez który przejedziesz, zostaje Twój. Planer zna tę siatkę co do metra i liczy, ile zdobędziesz, zanim wyjedziesz z domu.',
       'Squadrats divides the world map into a fixed grid. Every square you ride through becomes yours. The planner knows this grid to the metre and counts what you will collect before you leave home.'],
      `<div class="concept">
        <svg viewBox="0 0 400 300" role="img" aria-label="${T(['Jeden squadrat to 8 na 8 squadratinhos', 'One squadrat is 8 by 8 squadratinhos'])}">
          ${(() => { let g = ''; for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { const own = (i + j * 3) % 5 < 3 || (i > 1 && i < 6 && j > 1 && j < 6); g += `<rect x="${40 + i * 27}" y="${40 + j * 27}" width="26" height="26" fill="${own ? 'var(--sq)' : 'var(--panel-2)'}" fill-opacity="${own ? .55 : 1}"/>`; } return g; })()}
          <rect x="40" y="40" width="216" height="216" fill="none" stroke="var(--sqi)" stroke-width="3"/>
          <rect x="94" y="94" width="108" height="108" fill="none" stroke="var(--uber)" stroke-width="3" stroke-dasharray="7 5"/>
          <rect x="121" y="121" width="54" height="54" fill="none" stroke="var(--yard)" stroke-width="3"/>
          <path d="M20 270 C 90 220, 120 150, 180 130 S 300 60, 380 30" fill="none" stroke="var(--route)" stroke-width="4" stroke-linecap="round"/>
          <text x="270" y="60" fill="var(--ink-2)" font-family="JetBrains Mono, monospace" font-size="13">z14 · 1524 m</text>
          <text x="270" y="80" fill="var(--muted)" font-family="JetBrains Mono, monospace" font-size="13">= 8 × 8 · z17</text>
          <text x="270" y="230" fill="var(--muted)" font-family="JetBrains Mono, monospace" font-size="13">z17 · 191 m</text>
        </svg>
        <ul class="legend">
          <li><span class="sw" style="border-color:var(--sqi)"></span><span><b>Squadrat (SQ)</b>${T(['Kafel mapy na zoomie 14, bok ok. <span class="num">1,5 km</span>. Duża skala: zdobywasz nowe okolice.', 'A map tile at zoom 14, about <span class="num">1.5 km</span> across. The big scale: new areas.'])}</span></li>
          <li><span class="sw" style="border-color:var(--sq);background:color-mix(in srgb,var(--sq) 45%,transparent)"></span><span><b>Squadratinho (SQI)</b>${T(['Kafel na zoomie 17, bok ok. <span class="num">191 m</span>. W jednym squadracie jest ich <span class="num">64</span>. Tu liczy się każda uliczka.', 'A tile at zoom 17, about <span class="num">191 m</span> across. One squadrat holds <span class="num">64</span> of them. Every lane counts here.'])}</span></li>
          <li><span class="sw" style="border-color:var(--yard)"></span><span><b>Yard / Yardinho</b>${T(['Zdobyte kwadraty, które mają zdobytych sąsiadów ze wszystkich czterech stron. Mierzą, jak „pełne” jest Twoje terytorium.', 'Collected squares whose four neighbours are all collected too. They measure how solid your territory is.'])}</span></li>
          <li><span class="sw" style="border-color:var(--uber);border-style:dashed"></span><span><b>Übersquadrat / Übersquadratinho</b>${T(['Największy pełny kwadrat N×N bez ani jednej dziury, np. <span class="num">25 × 25</span>. Najtrudniejszy wynik do podbicia.', 'The largest solid N×N square without a single gap, e.g. <span class="num">25 × 25</span>. The hardest score to grow.'])}</span></li>
        </ul>
      </div>`),

    chapter('start', '--sq', ['Szybki start', 'Quick start'], ['Pierwsza trasa w czterech krokach', 'Your first route in four steps'],
      ['Od założenia konta do trasy na liczniku mija kilka minut. Kolejne razy to już tylko jedno kliknięcie, bo planer pamięta Twój dom i ustawienia.',
       'From sign-up to a route on your bike computer takes a few minutes. After that it is a single tap, because the planner remembers your home and settings.'],
      `<ol class="steps">
        <li><b>${T(['Załóż konto', 'Create an account'])}</b>${T(['Login i hasło albo „Kontynuuj z Google”.', 'Username and password, or “Continue with Google”.'])}</li>
        <li><b>${T(['Wczytaj swoje przejazdy', 'Load your rides'])}</b>${T(['Połącz Stravę albo zaimportuj KML ze Squadrats.com lub pliki GPX.', 'Connect Strava, or import the Squadrats.com KML or GPX files.'])}</li>
        <li><b>${T(['Ustaw dom', 'Set your home'])}</b>${T(['W profilu wpisz adres lub wskaż go na mapie. Każda trasa zacznie się tam sama.', 'Type your address in the profile or pick it on the map. Every route will start there.'])}</li>
        <li><b>${T(['Zaplanuj i jedź', 'Plan and ride'])}</b>${T(['Wybierz dystans, kliknij „Oblicz trasę”, pobierz GPX na Garmina.', 'Pick a distance, press “Calculate route”, download the GPX for your Garmin.'])}</li>
      </ol>
      ${screens(['d-login', ['Ekran logowania: konto, Google, regulamin i polityka prywatności.', 'Sign-in screen: account, Google, terms and privacy policy.']], ['m-map', ['Po zalogowaniu: Twoje kwadraty na mapie i licznik w nagłówku.', 'After signing in: your squares on the map and the counters in the header.']])}`),

    chapter('planowanie', '--route', ['Planowanie trasy', 'Route planning'], ['Pętla, która zbiera kwadraty i nie wraca tą samą drogą', 'Loops that collect squares and never ride back the same road'],
      ['Podajesz start i dystans. Planer sprawdza dziesiątki wariantów pętli na prawdziwych drogach, liczy nowe kwadraty każdego z nich i wybiera ten, który daje najwięcej, z jak najmniejszym powtarzaniem odcinków.',
       'You give a start and a distance. The planner tries dozens of loop variants on real roads, counts the new squares of each and keeps the one that collects most with as little repeated road as possible.'],
      `${benefits([
        [['Pętla albo A → B', 'Loop or A → B'], ['Pętla z domu na zadany dystans (5–200 km) albo przejazd z punktu do punktu, z opcjonalnym powrotem inną drogą.', 'A loop from home over a set distance (5–200 km), or a point-to-point ride with an optional return by a different road.']],
        [['Wynik od razu', 'Results at a glance'], ['Karta trasy: kilometry, czas przy Twojej średniej, nowe SQ i SQI, przewyższenia i odsetek drogi przejechanej dwa razy.', 'Route card: distance, time at your average speed, new SQ and SQI, climbing, and the share of road ridden twice.']],
        [['Pełna kontrola', 'Full control'], ['Przeciągaj punkty, klikaj w trasę, by dodać punkt pośredni, cofaj, odwracaj kierunek, zapisuj ulubione trasy.', 'Drag points, click the route to add a via point, undo, reverse the direction, save favourite routes.']],
      ])}
      ${screens(['d-form', ['Formularz trasy: adres, pętla lub A → B, dystans, sześć profili roweru i zaawansowane tryby.', 'Route form: address, loop or A → B, distance, six bike profiles and advanced modes.']], ['m-sheet', ['Na telefonie formularz wysuwa się z dołu ekranu.', 'On a phone the form slides up from the bottom.']])}
      ${howto([
        ['Kliknij <b>Start</b> na pasku nad mapą i kliknij punkt na mapie albo wpisz adres w polu „Skąd?”.', 'Press <b>Start</b> on the bar above the map and click the map, or type an address in “From?”.'],
        ['Wybierz <b>Pętla</b> lub <b>A → B</b> i ustaw suwakiem dystans.', 'Choose <b>Loop</b> or <b>A → B</b> and set the distance with the slider.'],
        ['Wybierz profil roweru, a w sekcji <b>Zaawansowane</b> cel optymalizacji.', 'Choose a bike profile and, under <b>Advanced</b>, what to optimise for.'],
        ['Kliknij <b>Oblicz trasę</b> (albo naciśnij <kbd>Enter</kbd>).', 'Press <b>Calculate route</b> (or hit <kbd>Enter</kbd>).'],
        ['Przeciągnij dowolny punkt albo kliknij linię trasy, by dodać punkt pośredni. Przelicza się tylko zmieniony odcinek.', 'Drag any point, or click the route line to add a via point. Only the changed leg is recalculated.'],
      ], [
        ['Dotknij <b>Zaplanuj trasę</b> na dolnym pasku. Gdy dom jest ustawiony, start jest już wpisany.', 'Tap <b>Plan route</b> on the bottom bar. With a home set, the start is already filled in.'],
        ['Wybierz pętlę lub A → B, dystans i profil roweru.', 'Pick loop or A → B, the distance and a bike profile.'],
        ['Dotknij <b>Oblicz trasę</b>. Arkusz zwija się i pokazuje kartę wyniku.', 'Tap <b>Calculate route</b>. The sheet folds down to the result card.'],
        ['Przytrzymaj i przeciągnij punkt na mapie, by poprawić przebieg.', 'Press and drag a point on the map to adjust the course.'],
        ['Przesuń arkusz w górę, by zobaczyć podsumowanie, punkty i zapisane trasy.', 'Swipe the sheet up for the summary, points and saved routes.'],
      ])}
      <h3>${T(['Sześć profili roweru', 'Six bike profiles'])}</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>${T(['Profil', 'Profile'])}</th><th>${T(['Dla kogo', 'For'])}</th><th>${T(['Silnik', 'Engine'])}</th></tr></thead>
        <tbody>
          <tr><td>${T(['Bezpieczny', 'Safe'])}</td><td>${T(['Domyślny. Ścieżki rowerowe na pierwszym miejscu, drogi ekspresowe wykluczone.', 'Default. Cycle paths first, expressways ruled out.'])}</td><td><span class="tag">BRouter</span></td></tr>
          <tr><td>${T(['Spokojny', 'Quiet'])}</td><td>${T(['Boczne drogi z małym ruchem i ścieżki, profil dopasowany do Polski.', 'Low-traffic side roads and paths, a profile tuned for Poland.'])}</td><td><span class="tag">BRouter</span></td></tr>
          <tr><td>${T(['Szosowy', 'Road'])}</td><td>${T(['Szybko i po asfalcie.', 'Fast and on tarmac.'])}</td><td><span class="tag">BRouter</span></td></tr>
          <tr><td>Gravel</td><td>${T(['Szuter i drogi gruntowe mile widziane.', 'Gravel and dirt roads welcome.'])}</td><td><span class="tag">BRouter</span></td></tr>
          <tr><td>MTB</td><td>${T(['Teren, ścieżki leśne, single tracki.', 'Off-road, forest paths, single track.'])}</td><td><span class="tag">BRouter</span></td></tr>
          <tr><td>${T(['Ogólny', 'General'])}</td><td>${T(['Zwykły rower, szybkie wyliczenie.', 'A plain bike, quick to compute.'])}</td><td><span class="tag">OSRM</span></td></tr>
        </tbody></table></div>
      <h3>${T(['Siedem celów optymalizacji', 'Seven optimisation goals'])}</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>${T(['Tryb', 'Mode'])}</th><th>${T(['Co robi', 'What it does'])}</th></tr></thead>
        <tbody>
          <tr><td>SQI</td><td>${T(['Najwięcej nowych squadratinhos. Domyślny i najczęściej używany.', 'Most new squadratinhos. The default and the most used.'])}</td></tr>
          <tr><td>${T(['Nowe SQ', 'New SQ'])}</td><td>${T(['Najwięcej nowych dużych kwadratów, czyli nowe okolice.', 'Most new big squares, i.e. new areas.'])}</td></tr>
          <tr><td>Yard</td><td>${T(['Wypełnia luki tak, by urósł Yard.', 'Fills gaps so your Yard grows.'])}</td></tr>
          <tr><td>Yardinho</td><td>${T(['To samo na poziomie squadratinhos.', 'The same at squadratinho level.'])}</td></tr>
          <tr><td>${T(['Priorytety', 'Priorities'])}</td><td>${T(['Pętla przez najcenniejsze kwadraty z warstwy Priorytety (rozdział niżej).', 'A loop through the most valuable squares from the Priorities layer (next chapter).'])}</td></tr>
          <tr><td>${T(['Popularne', 'Popular'])}</td><td>${T(['Drogi, którymi jeździ najwięcej ludzi: gęste ślady GPS z OpenStreetMap i oznakowane szlaki.', 'Roads most people ride: dense OpenStreetMap GPS traces and signed cycle routes.'])}</td></tr>
          <tr><td>${T(['Bez kwadratów', 'No squares'])}</td><td>${T(['Zwykła trasa, gdy kwadraty nie mają znaczenia.', 'A plain route when squares don’t matter.'])}</td></tr>
        </tbody></table></div>
      <h3>${T(['Wynik i profil wysokości', 'Result and elevation profile'])}</h3>
      <p>${T(['Karta trasy pokazuje najważniejsze liczby, a pod nią podsumowanie nawierzchni: ile kilometrów asfaltu, ścieżek rowerowych, szutru i kostki. Profil wysokości otwiera się pod mapą. Przesuwając palcem lub myszą po wykresie, widzisz ten punkt na trasie. Na samej trasie co kilka kilometrów są znaczniki kilometrów, a ich gęstość dopasowuje się do przybliżenia mapy.', 'The route card shows the key numbers, with a surface summary below: kilometres of tarmac, cycle paths, gravel and cobbles. The elevation profile opens under the map. Slide a finger or the mouse along the chart and the point moves along the route. The route itself carries kilometre markers whose spacing adapts to the map zoom.'])}</p>
      ${screens(['d-elev', ['Pętla 37 km: 52 nowe SQI, nawierzchnie i profil wysokości.', 'A 37 km loop: 52 new SQI, surfaces and the elevation profile.']], ['m-elev', ['Profil wysokości na telefonie.', 'Elevation profile on a phone.']])}
      ${screens(['d-ab', ['Trasa A → B przez miasto. Po wyliczeniu przycisk „Dodaj powrót inną drogą” domyka ją w pętlę.', 'An A → B ride across town. Afterwards “Add a return by another road” closes it into a loop.']], ['m-card', ['Karta trasy na telefonie: GPX dla Garmina, Wyślij, Zapisz.', 'Route card on a phone: GPX for Garmin, Send, Save.']])}
      <h3>${T(['Rysowanie trasy punkt po punkcie', 'Drawing a route point by point'])}</h3>
      <p>${T(['Gdy wiesz, którędy chcesz jechać, narysuj trasę sam, jak w kreatorze tras Stravy. Stukasz punkt startu, potem kolejne punkty, a każdy odcinek od razu wyznacza się po drogach według wybranego profilu roweru. Kilometry, nowe kwadraty i profil wysokości rosną na bieżąco. Gdy odcinek jeszcze się liczy, widać przerywaną linię. Możesz stukać dalej, kolejne odcinki ustawią się w kolejce.', 'When you know where you want to ride, draw the route yourself, like in Strava’s route builder. Tap the start, then each next point, and every leg is routed on roads straight away with your bike profile. Kilometres, new squares and the elevation profile grow as you go. A dashed line marks a leg still being routed. Keep tapping, the next legs queue up.'])}</p>
      ${howto([
        ['Kliknij <b>Rysuj</b> na pasku nad mapą (albo klawisz <code>D</code>).', 'Click <b>Draw</b> on the bar above the map (or press <code>D</code>).'],
        ['Kliknij punkt startu, a potem kolejne punkty. Trasa dokleja się odcinek po odcinku.', 'Click the start, then the next points. The route grows leg by leg.'],
        ['<b>Cofnij</b> (<code>Ctrl+Z</code>) usuwa ostatni punkt. Przeciągnij punkt, by przeliczyć tylko jego dwa odcinki.', '<b>Undo</b> (<code>Ctrl+Z</code>) removes the last point. Drag a point to re-route just its two legs.'],
        ['<b>Do startu</b> domyka pętlę, w miarę możliwości inną drogą niż przyjazd.', '<b>Back to start</b> closes the loop, on other roads than the way out where possible.'],
        ['<b>Gotowe</b> (albo <code>Enter</code> / <code>Esc</code>) kończy rysowanie: trasa dostaje pełną kartę, nawierzchnie, punkty i zdjęcia, GPX i zapis.', '<b>Done</b> (or <code>Enter</code> / <code>Esc</code>) finishes: the route gets the full card, surfaces, stops and photos, GPX and saving.'],
      ], [
        ['Stuknij <b>Rysuj</b> na pasku u góry mapy.', 'Tap <b>Draw</b> on the bar at the top of the map.'],
        ['Stuknij palcem punkt startu, potem kolejne punkty. Nad mapą widzisz bieżące kilometry.', 'Tap the start with your finger, then the next points. The running distance shows above the map.'],
        ['Ikony obok kilometrów: strzałka cofa ostatni punkt, kółko wraca do startu.', 'The icons by the distance: the arrow undoes the last point, the circle heads back to the start.'],
        ['Podwójne stuknięcie przybliża mapę i nie dodaje punktu. Mapę przesuwasz jak zwykle palcem.', 'A double tap zooms in without adding a point. Pan the map with your finger as usual.'],
        ['Stuknij <b>Gotowe</b>. Narysowaną trasę możesz potem wydłużyć, wracając do trybu Rysuj.', 'Tap <b>Done</b>. To extend the route later, go back into Draw.'],
      ])}
      ${screens(['d-draw', ['Rysowanie: każdy klik dokłada odcinek po drogach, kilometry i nowe kwadraty liczą się na bieżąco.', 'Drawing: each click adds a leg on roads, kilometres and new squares update live.']], ['m-draw', ['Rysowanie palcem na telefonie, z paskiem Cofnij / Do startu / Gotowe.', 'Drawing with a finger on a phone, with the Undo / Back to start / Done bar.']])}`),

    chapter('priorytety', '--new', ['Inteligentne zbieranie', 'Smart collecting'], ['Priorytety: które kwadraty warto zdobyć najpierw', 'Priorities: which squares to collect first'],
      ['Nie każdy brakujący kwadrat jest wart tyle samo. Planer ocenia każdy niezdobyty squadratinho w promieniu 30 km od domu: ile powiększy Twój Übersquadratinho i Yardinho, czy prowadzi do niego droga i jak daleko trzeba jechać.',
       'Not every missing square is worth the same. The planner scores every uncollected squadratinho within 30 km of home: how much it grows your Übersquadratinho and Yardinho, whether a road leads there and how far it is.'],
      `${benefits([
        [['Trzy poziomy', 'Three tiers'], ['Mapa koloruje kwadraty według wartości. Najcenniejsze świecą najmocniej.', 'The map colours squares by value. The most valuable glow the brightest.']],
        [['Gotowe cele', 'Ready-made goals'], ['Lista mówi wprost: „brakuje 1 kwadratu do Über 27 × 27” i ile to kilometrów od domu.', 'The list says it plainly: “1 square missing for Über 27 × 27”, and how many kilometres from home.']],
        [['Trasa jednym kliknięciem', 'A route in one click'], ['Tryb Priorytety układa pętlę, która zbiera jak najwięcej punktów w limicie kilometrów. Kwadraty bez drogi bierze „z dojściem pieszo”.', 'Priorities mode builds a loop that collects the most points within your distance limit. Squares without a road are taken “with a short walk”.']],
      ])}
      ${screens(['d-prio', ['Warstwa Priorytety i panel celów: najbliższe powiększenia Übersquadratinho.', 'The Priorities layer and goals panel: the nearest Übersquadratinho upgrades.']], ['m-prio', ['Priorytety na telefonie.', 'Priorities on a phone.']])}
      ${howto([
        ['Otwórz zakładkę <b>Kwadraty</b> i włącz warstwę <b>Priorytety</b>.', 'Open the <b>Squares</b> tab and turn on the <b>Priorities</b> layer.'],
        ['Kliknij cel na liście, a mapa przeleci do tego okna.', 'Click a goal in the list and the map flies to that window.'],
        ['W zakładce <b>Trasa</b> → <b>Zaawansowane</b> wybierz <b>Priorytety</b>, ustaw limit km i oblicz.', 'In <b>Route</b> → <b>Advanced</b>, choose <b>Priorities</b>, set the distance limit and calculate.'],
        ['Po przejechaniu i synchronizacji ranking przelicza się sam, więc kolejna pętla celuje w następne kwadraty.', 'After the ride syncs, the ranking recalculates itself, so the next loop aims at the next squares.'],
      ], [
        ['Otwórz arkusz, przejdź do <b>Kwadraty</b> i włącz <b>Priorytety</b>.', 'Open the sheet, go to <b>Squares</b> and turn on <b>Priorities</b>.'],
        ['Dotknij celu na liście, by zobaczyć go na mapie.', 'Tap a goal in the list to see it on the map.'],
        ['W <b>Trasa</b> wybierz tryb <b>Priorytety</b> i dotknij <b>Oblicz trasę</b>.', 'In <b>Route</b>, choose <b>Priorities</b> mode and tap <b>Calculate route</b>.'],
        ['Kwadraty „z dojściem pieszo” mają na mapie osobne znaczniki.', 'Squares “with a short walk” get their own markers on the map.'],
      ])}
      ${screens(['d-prio-route', ['Pętla w trybie Priorytety: zbiera najcenniejsze kwadraty w limicie kilometrów.', 'A Priorities loop: the most valuable squares within the distance limit.']])}`),

    chapter('twoje-kwadraty', '--yard', ['Twoje terytorium', 'Your territory'], ['Kwadraty, Yard i Über w jednym miejscu', 'Squares, Yard and Über in one place'],
      ['Zakładka Kwadraty to tablica wyników. Liczniki na dwóch poziomach, warstwy do włączania na mapie i narzędzia do oznaczania terenu, na który nie da się wjechać.',
       'The Squares tab is your scoreboard: counters at both levels, map layers to switch on and tools to mark ground you can’t get into.'],
      `${screens(['d-squares', ['Zdobyte squadraty, Yard i Übersquadrat 25 × 25 na mapie całej okolicy.', 'Collected squadrats, Yard and the 25 × 25 Übersquadrat across the whole area.']], ['m-squares', ['Liczniki i warstwy na telefonie.', 'Counters and layers on a phone.']])}
      ${benefits([
        [['Dwanaście warstw', 'Twelve layers'], ['Zdobyte, nowe z trasy, Yard, Über, siatki z14 i z17, Priorytety i „bez drogi”. Każda jednym przełącznikiem.', 'Collected, new from the route, Yard, Über, z14 and z17 grids, Priorities and “no road”. Each one switch.']],
        [['Niezdobywalne', 'Uncollectable'], ['Trzy szybkie kliknięcia w kwadrat oznaczają go jako niedostępny (woda, teren zamknięty). Planer go pominie, a Über liczy się bez niego.', 'Three quick taps mark a square as unreachable (water, fenced land). The planner skips it and Über is counted around it.']],
        [['Podpowiedzi „bez drogi”', '“No road” hints'], ['Przekreślone kwadraty to miejsca, przez które w OpenStreetMap nie biegnie żadna droga ani ścieżka. Możesz zatwierdzić je hurtowo dla widoku.', 'Crossed-out squares are places with no road or path in OpenStreetMap. You can accept them in bulk for the current view.']],
      ])}
      ${screens(['d-sqi', ['Poziom squadratinhos: Yardinho, Über SQI i przekreślone kwadraty bez drogi.', 'Squadratinho level: Yardinho, Über SQI and crossed-out squares with no road.']])}
      ${howto([
        ['Otwórz zakładkę <b>Kwadraty</b>. Liczniki są też zawsze w nagłówku.', 'Open the <b>Squares</b> tab. The counters are always in the header too.'],
        ['Włącz warstwy przełącznikami, np. <b>Yard</b> i <b>Übersquadrat</b>.', 'Switch on layers, e.g. <b>Yard</b> and <b>Übersquadrat</b>.'],
        ['W trybie <b>Widok</b> przy zoomie 14+ kliknij kwadrat trzy razy, by oznaczyć go jako niezdobywalny. Trzy kolejne kliknięcia cofają oznaczenie.', 'In <b>View</b> mode at zoom 14+, click a square three times to mark it uncollectable. Three more clicks undo it.'],
        ['Przycisk <b>Oznacz sugerowane w widoku</b> zatwierdza wszystkie podpowiedzi „bez drogi” na ekranie.', '<b>Mark suggested in view</b> accepts every “no road” hint on screen.'],
      ], [
        ['Liczniki SQ, Yard, Über i SQI są w górnym pasku.', 'SQ, Yard, Über and SQI counters sit in the top bar.'],
        ['W arkuszu otwórz <b>Kwadraty</b>, by przełączać warstwy.', 'Open <b>Squares</b> in the sheet to switch layers.'],
        ['Stuknij kwadrat szybko trzy razy, by oznaczyć go jako niezdobywalny. Działa na iPhonie i Androidzie.', 'Tap a square three times quickly to mark it uncollectable. Works on iPhone and Android.'],
      ])}`),

    chapter('na-trasie', '--sqi', ['Rozpoznanie trasy', 'Know your route'], ['Zobacz trasę, zanim na nią wyjedziesz', 'See the route before you ride it'],
      ['Po wyliczeniu trasy planer sam zbiera, co jest po drodze: gdzie zjeść, gdzie nalać wody, gdzie przenocować, jak wygląda droga na zdjęciach ludzi i w Street View.',
       'Once a route is calculated, the planner gathers what lies along it: where to eat, where to refill water, where to sleep, and what the road looks like in people’s photos and in Street View.'],
      `<h3>${T(['Punkty na trasie', 'Points along the route'])}</h3>
      <p>${T(['Sześć kategorii: jedzenie, woda, sklepy (i stacje Orlen), noclegi, serwis rowerowy, atrakcje. Każdy punkt ma kilometr trasy i odległość od niej, w kolejności jazdy. Filtr <b>Tylko przy trasie</b> zostawia miejsca do 60 m od trasy, czyli takie, przy których nie trzeba zjeżdżać. Dymek punktu ma przycisk <b>Google Maps</b> z opiniami i zdjęciami.', 'Six categories: food, water, shops (and Orlen fuel stations), lodging, bike service, sights. Every point shows its kilometre on the route and its distance off it, in riding order. The <b>Only by the route</b> filter keeps places within 60 m, so no detour is needed. A point’s popup has a <b>Google Maps</b> button with reviews and photos.'])}</p>
      ${screens(['d-poi', ['Lista punktów w kolejności jazdy i dymek z przyciskiem Google Maps.', 'Points in riding order and a popup with the Google Maps button.']], ['m-poi', ['Na telefonie przycisk otwiera aplikację Google Maps.', 'On a phone the button opens the Google Maps app.']])}
      <h3>${T(['Zdjęcia ludzi wzdłuż trasy', 'People’s photos along the route'])}</h3>
      <p>${T(['Niebieskie kropki to zdjęcia z Wikimedia Commons, zielone to zdjęcia z Mapillary, robione z poziomu drogi, często z roweru, czasem jako panoramy 360°. Pokazują się zdjęcia do 300 m od trasy, mniej więcej co 150 m. Widać, czy to asfalt, szuter czy piach, zanim tam dojedziesz. Zdjęcia raz pobrane dla okolicy są zapamiętywane, więc kolejne trasy ładują się natychmiast.', 'Blue dots are Wikimedia Commons photos; green dots are Mapillary street-level images, often taken from a bike, sometimes 360° panoramas. Photos within 300 m of the route are shown, about one per 150 m. You can tell tarmac from gravel or sand before you get there. Photos fetched for an area are kept, so later routes there load instantly.'])}</p>
      ${screens(['d-photos-mly', ['Zdjęcie z Mapillary: kilometr trasy, autor i data.', 'A Mapillary photo: kilometre on the route, author and date.']], ['m-photo', ['Zdjęcie z trasy na telefonie.', 'A route photo on a phone.']])}
      ${screens(['d-photos', ['Zdjęcie z Wikimedia Commons z licencją i linkiem do źródła.', 'A Wikimedia Commons photo with its licence and a link to the source.']])}
      <h3>${T(['Ciekawe miejsca z Wikipedii', 'Places of interest from Wikipedia'])}</h3>
      <p>${T(['Do 15 miejsc z artykułem na Wikipedii w pobliżu trasy: zabytki, rezerwaty, punkty widokowe. Na mapie mają miniaturę zdjęcia, a dymek pokazuje krótki opis i link do artykułu.', 'Up to 15 places near the route that have a Wikipedia article: monuments, reserves, viewpoints. On the map they show a photo thumbnail; the popup has a short summary and a link to the article.'])}</p>
      <h3>Street View</h3>
      <p>${T(['Panel Street View otwiera się obok mapy. Kliknij dowolne miejsce, a panorama Google pokaże, jak tam jest. Strzałka na mapie pokazuje, gdzie stoisz i w którą stronę patrzysz.', 'The Street View panel opens beside the map. Click any spot and the Google panorama shows what it looks like. An arrow on the map shows where you stand and which way you are looking.'])}</p>
      ${screens(['d-sv', ['Street View obok mapy: sprawdzenie ścieżki przed wyjazdem.', 'Street View beside the map: checking a path before the ride.']])}
      ${howto([
        ['Po wyliczeniu trasy przewiń panel do <b>Punkty na trasie</b> i filtruj kategoriami.', 'After calculating, scroll the panel to <b>Points along the route</b> and filter by category.'],
        ['Kliknij pozycję na liście, by przybliżyć mapę do tego miejsca.', 'Click an item to zoom the map to that place.'],
        ['Kliknij kropkę z aparatem, by zobaczyć zdjęcie. Kliknięcie w zdjęcie otwiera je w pełnym rozmiarze.', 'Click a camera dot to see the photo. Clicking the photo opens it full size.'],
        ['Przycisk menu mapy (prawa strona) → <b>Street View</b>, potem kliknij mapę.', 'Map menu button (right side) → <b>Street View</b>, then click the map.'],
      ], [
        ['Menu mapy (ikona suwaków) → <b>Punkty na trasie</b> pokazuje filtry kategorii.', 'Map menu (sliders icon) → <b>Points along the route</b> shows the category filters.'],
        ['Stuknij pinezkę, a potem <b>Google Maps — opinie, zdjęcia</b>.', 'Tap a pin, then <b>Google Maps — reviews, photos</b>.'],
        ['W tym samym menu włączysz <b>Zdjęcia z trasy</b>, <b>Ciekawe miejsca (Wikipedia)</b> i <b>Street View</b> na podzielonym ekranie.', 'The same menu toggles <b>Route photos</b>, <b>Places of interest (Wikipedia)</b> and split-screen <b>Street View</b>.'],
      ])}`),

    chapter('mapy', '--uber', ['Mapy i nakładki', 'Maps and overlays'], ['Najdokładniejsze mapy Polski w jednym planerze', 'The most detailed maps of Poland in one planner'],
      ['Gdy kwadrat nie ma drogi w OpenStreetMap, trzeba wiedzieć, co tam naprawdę jest. Planer łączy mapy bazowe z publicznymi danymi państwowymi: laserowym skanem terenu, zdjęciami lotniczymi, oddziałami leśnymi, rezerwatami i działkami.',
       'When a square has no road in OpenStreetMap, you need to know what is really there. The planner combines base maps with Polish public data: laser terrain scans, aerial photos, forest compartments, nature reserves and land parcels.'],
      `${screens(['d-lidar', ['Lidar (rzeźba terenu z lotniczego skanu, 1 m) z oddziałami leśnymi: dukty widać nawet pod drzewami.', 'Lidar (terrain relief from an airborne scan, 1 m) with forest compartments: tracks show even under trees.']], ['m-lidar', ['Lidar na telefonie przy zoomie 16.', 'Lidar on a phone at zoom 16.']])}
      <div class="table-wrap"><table>
        <thead><tr><th>${T(['Nakładka', 'Overlay'])}</th><th>${T(['Do czego', 'Use it to'])}</th><th>${T(['Źródło', 'Source'])}</th></tr></thead>
        <tbody>
          <tr><td>Lidar</td><td>${T(['Zobaczyć ścieżki, rowy i nasypy pod koronami drzew. Od zoomu 11.', 'See paths, ditches and embankments under the tree canopy. From zoom 11.'])}</td><td><span class="tag">GUGiK</span></td></tr>
          <tr><td>${T(['Ortofotomapa', 'Orthophoto'])}</td><td>${T(['Zdjęcia lotnicze do ok. 10 cm na piksel, zwykle nowsze niż satelita.', 'Aerial photos down to about 10 cm per pixel, usually newer than satellite.'])}</td><td><span class="tag">Geoportal</span></td></tr>
          <tr><td>${T(['Oddziały leśne', 'Forest compartments'])}</td><td>${T(['Granice oddziałów, czyli zwykle przejezdne dukty. Od zoomu 12.', 'Compartment boundaries, usually passable forest tracks. From zoom 12.'])}</td><td><span class="tag">BDL</span></td></tr>
          <tr><td>${T(['Rezerwaty', 'Nature reserves'])}</td><td>${T(['Rezerwaty, parki narodowe, użytki ekologiczne: gdzie nie schodzić ze szlaku.', 'Reserves, national parks, ecological sites: where to stay on the trail.'])}</td><td><span class="tag">GDOŚ</span></td></tr>
          <tr><td>${T(['Działki', 'Parcels'])}</td><td>${T(['Działki z numerami: czy polna droga to osobna działka drogowa. Od zoomu 16.', 'Numbered land parcels: is a field track its own road parcel? From zoom 16.'])}</td><td><span class="tag">KIEG</span></td></tr>
          <tr><td>${T(['Trasy rowerowe', 'Cycle routes'])}</td><td>${T(['Oznakowane szlaki rowerowe.', 'Signed cycle routes.'])}</td><td><span class="tag">Waymarked Trails</span></td></tr>
          <tr><td>${T(['Ślady GPS', 'GPS traces'])}</td><td>${T(['Publiczne nagrania użytkowników OSM: im gęściej, tym więcej przejazdów.', 'Public OSM recordings: the denser, the more rides.'])}</td><td><span class="tag">OpenStreetMap</span></td></tr>
        </tbody></table></div>
      ${screens(['d-orto', ['Ortofotomapa z granicami działek przy zoomie 17: widać ogrodzenia i przejścia.', 'Orthophoto with parcel boundaries at zoom 17: fences and gaps are visible.']])}
      ${screens(['d-gdos', ['Rezerwaty i obszary chronione GDOŚ.', 'GDOŚ nature reserves and protected areas.']])}
      <h3>${T(['Siedem map bazowych', 'Seven base maps'])}</h3>
      <p>${T(['OpenStreetMap, rowerowa CyclOSM, topograficzna OpenTopoMap, satelita Esri, ciemna Carto oraz dwie mapy Mapy.com: turystyczna, ze szlakami i ścieżkami MTB, i lotnicza.', 'OpenStreetMap, the cycling map CyclOSM, OpenTopoMap, Esri satellite, Carto dark, and two Mapy.com maps: outdoor, with trails and MTB paths, and aerial.'])}</p>
      ${screens(['d-mapy', ['Turystyczna mapa Mapy.com ze szlakami MTB i Twoimi squadratinhos.', 'The Mapy.com outdoor map with MTB trails and your squadratinhos.']])}
      ${screens(['d-popular', ['Tryb Popularne na tle śladów GPS: pętla po drogach, którymi jeździ najwięcej ludzi.', 'Popular mode over GPS traces: a loop on the roads most people ride.']])}
      ${screens(['d-routes', ['Oznakowane szlaki rowerowe wokół Warszawy.', 'Signed cycle routes around Warsaw.']])}
      ${howto([
        ['Zakładka <b>Nakładki</b> → sekcja <b>Teren i dostęp (Polska)</b> → przełączniki.', '<b>Overlays</b> tab → <b>Terrain and access (Poland)</b> → switches.'],
        ['Mapę bazową zmienisz w <b>Opcje</b> albo w menu mapy po prawej.', 'Change the base map in <b>Options</b> or in the map menu on the right.'],
        ['Włączone nakładki są zapamiętywane do następnej wizyty.', 'Overlays you turn on are remembered for your next visit.'],
      ], [
        ['Menu mapy (ikona suwaków) ma sekcje <b>Mapa bazowa</b> i <b>Teren i dostęp (PL)</b>.', 'The map menu (sliders icon) has <b>Base map</b> and <b>Terrain and access (PL)</b> sections.'],
        ['Stuknij nakładkę, by ją włączyć lub wyłączyć. Aktywne są podświetlone.', 'Tap an overlay to toggle it. Active ones are highlighted.'],
      ])}
      ${screens(null, ['m-tools', ['Menu mapy na telefonie: narzędzia, mapy bazowe i nakładki terenu.', 'The map menu on a phone: tools, base maps and terrain overlays.']])}`),

    chapter('jazda', '--sq', ['Na rowerze', 'On the bike'], ['Z planera na licznik i w drogę', 'From the planner to your bike computer'],
      ['Trasa trafia tam, gdzie jej potrzebujesz: na Garmina, Wahoo albo prosto do telefonu z podglądem Twojej pozycji na trasie.',
       'The route goes where you need it: to a Garmin, a Wahoo, or straight to your phone with your position on the route.'],
      `${benefits([
        [['GPX dla Garmina', 'GPX for Garmin'], ['Plik z wysokościami gotowy do importu jako kurs w Garmin Connect.', 'A file with elevations, ready to import as a course in Garmin Connect.']],
        [['Wyślij', 'Send'], ['Systemowe udostępnianie pliku, np. do aplikacji Wahoo ELEMNT.', 'The system share sheet, e.g. to the Wahoo ELEMNT app.']],
        [['Jadę', 'Riding'], ['Pozycja GPS na trasie: przejechany kilometr, ile zostało, ostrzeżenie o zjechaniu z trasy.', 'Your GPS position on the route: kilometre ridden, distance left, a warning when you leave the route.']],
        [['Moje trasy', 'My routes'], ['Zapisuj trasy pod nazwą i wracaj do nich jednym kliknięciem.', 'Save routes by name and reopen them in one click.']],
      ])}
      <div class="duo">
        <div>
          <h3 style="margin-top:0">${T(['Pole danych na Garmin Edge', 'A data field for Garmin Edge'])}</h3>
          <p>${T(['Squadrats ma własne pole danych Connect IQ dla liczników Edge 1040 i 1050. W trakcie jazdy pokazuje siatkę kwadratów wokół Ciebie, zdobyte i brakujące squadratinhos oraz licznik nowych kwadratów z tej jazdy. Dane okolicy pobiera przez telefon z Twojego konta, korzystając z osobistego klucza.', 'Squadrats has its own Connect IQ data field for Edge 1040 and 1050 bike computers. While you ride it shows the square grid around you, collected and missing squadratinhos, and a counter of new squares from this ride. It fetches your area through the phone from your account using a personal key.'])}</p>
          <p class="note">${T(['<b>Ilustracja.</b> Obok jest schemat ekranu pola danych, a nie zrzut z licznika.', '<b>Illustration.</b> Shown is a sketch of the data field screen, not a capture from the device.'])}</p>
        </div>
        <div class="edge"><canvas id="edge-field" aria-label="${T(['Schemat pola danych Squadrats na Garmin Edge', 'Sketch of the Squadrats data field on a Garmin Edge'])}"></canvas></div>
      </div>
      ${screens(null, ['m-ride', ['Tryb Jadę: Twoja pozycja i postęp na zaplanowanej trasie.', 'Riding mode: your position and progress on the planned route.']])}
      ${howto([
        ['Na karcie trasy kliknij <b>Pobierz GPX dla Garmina</b>, a w Garmin Connect wybierz <b>Kursy → Importuj</b>.', 'On the route card, press <b>Download GPX for Garmin</b>; in Garmin Connect choose <b>Courses → Import</b>.'],
        ['<b>Zapisz</b> dodaje trasę do listy <b>Moje trasy</b> w zakładce Trasa.', '<b>Save</b> adds the route to <b>My routes</b> in the Route tab.'],
        ['<b>GPX</b> pobiera zwykły plik dla innych aplikacji.', '<b>GPX</b> downloads a plain file for other apps.'],
      ], [
        ['<b>Wyślij</b> otwiera udostępnianie: wybierz Wahoo, Garmin Connect lub pliki.', '<b>Send</b> opens sharing: pick Wahoo, Garmin Connect or Files.'],
        ['Przycisk nawigacji po prawej włącza tryb <b>Jadę</b>. Pasek u góry pokazuje kilometr i dystans do końca.', 'The navigation button on the right starts <b>Riding</b> mode. The top bar shows your kilometre and the distance left.'],
        ['<b>Wycentruj</b> wraca do Twojej pozycji, <b>Zakończ</b> wyłącza śledzenie.', '<b>Center</b> returns to your position, <b>Stop</b> ends tracking.'],
      ])}`),

    chapter('dane', '--yard', ['Twoje przejazdy', 'Your rides'], ['Synchronizacja i import', 'Sync and import'],
      ['Kwadraty biorą się z Twoich przejazdów. Planer zapisuje je raz we własnej bazie, a potem dociąga tylko nowe aktywności.',
       'Squares come from your rides. The planner stores them once in its own database and then only fetches new activities.'],
      `${benefits([
        [['Strava, automatycznie', 'Strava, automatically'], ['Po połączeniu konta nowe jazdy pobierają się same co 30 minut. Przycisk „Synchronizuj” robi to od razu.', 'Once connected, new rides arrive by themselves every 30 minutes. “Sync” does it right away.']],
        [['KML ze Squadrats.com', 'KML from Squadrats.com'], ['Oficjalny eksport kwadratów z aplikacji Squadrats wczytasz jednym plikiem, również z historii sprzed Stravy.', 'The official squares export from the Squadrats app loads in one file, including history from before Strava.']],
        [['Pliki GPX', 'GPX files'], ['Przeciągnij pliki na mapę albo wybierz kilka naraz. Działa z każdym urządzeniem.', 'Drag files onto the map or pick several at once. Works with any device.']],
      ])}
      ${howto([
        ['<b>Profil i Strava</b> (menu konta) → wklej Client ID i Secret z strava.com/settings/api → <b>Połącz ze Stravą</b>.', '<b>Profile and Strava</b> (account menu) → paste the Client ID and Secret from strava.com/settings/api → <b>Connect with Strava</b>.'],
        ['Zakładka <b>Kwadraty</b> → <b>Synchronizuj z Strava</b>. Pasek pokazuje postęp pierwszego pobrania.', '<b>Squares</b> tab → <b>Sync with Strava</b>. A bar shows the progress of the first download.'],
        ['<b>Importuj GPX</b> lub <b>Importuj z Squadrats.com (KML)</b> w tej samej zakładce. Pliki GPX możesz też upuścić na mapę.', '<b>Import GPX</b> or <b>Import from Squadrats.com (KML)</b> in the same tab. GPX files can also be dropped on the map.'],
      ], [
        ['Połączenie ze Stravą ustawisz raz, w profilu.', 'Set up the Strava connection once, in your profile.'],
        ['Potem nic nie musisz robić: synchronizacja co 30 minut działa w tle na serwerze.', 'After that there is nothing to do: the 30-minute sync runs on the server.'],
        ['Import GPX i KML działa z plików w telefonie (Pliki, iCloud, Dysk).', 'GPX and KML import works from files on the phone (Files, iCloud, Drive).'],
      ])}`),

    chapter('konto', '--ink-2', ['Konto i prywatność', 'Account and privacy'], ['Twoje dane pod Twoją kontrolą', 'Your data under your control'],
      ['Każdy użytkownik ma osobne konto, własne klucze Stravy i własne kwadraty. Klucze do zewnętrznych map zostają na serwerze i nigdy nie trafiają do przeglądarki.',
       'Every user has their own account, their own Strava keys and their own squares. Keys for external maps stay on the server and never reach the browser.'],
      `${screens(['d-profile', ['Profil: konto, hasło, punkt startowy, klucze Stravy, prywatność i usunięcie konta (dane przykładowe).', 'Profile: account, password, home point, Strava keys, privacy and account deletion (sample data).']])}
      ${benefits([
        [['Logowanie', 'Sign-in'], ['Login i hasło (min. 8 znaków z cyfrą) albo konto Google. Sesja trwa 30 dni.', 'Username and password (8+ characters with a digit) or a Google account. Sessions last 30 days.']],
        [['Punkt startowy', 'Home point'], ['Adres albo punkt wskazany na mapie. Każda nowa trasa startuje z domu.', 'An address or a point picked on the map. Every new route starts from home.']],
        [['Usunięcie konta', 'Account deletion'], ['Jednym przyciskiem kasujesz aktywności, kwadraty, trasy i klucze, a aplikacja odłącza się od Stravy.', 'One button deletes activities, squares, routes and keys, and disconnects the app from Strava.']],
        [['Panel admina', 'Admin panel'], ['Administrator zarządza kontami użytkowników.', 'The administrator manages user accounts.']],
        [['Polski lub angielski', 'Polish or English'], ['Przełącznik PL/EN jest w menu konta i na ekranie logowania. Zmienia język od razu, bez utraty trasy, i zostaje zapamiętany. Nowa osoba dostaje język swojej przeglądarki.', 'The PL/EN switch is in the account menu and on the sign-in screen. It changes the language at once, without losing your route, and is remembered. A new visitor gets their browser’s language.']],
      ])}`),
  ];

  // ── integrations ──────────────────────────────────────────────────────────
  const C = { data: '--yard', routing: '--route', maps: '--uber', places: '--sqi', devices: '--sq', account: '--new' };
  const INT = [
    ['data', 'St', 'Strava', 'OAuth · API v3', ['Pobiera Twoje aktywności, automatycznie co 30 minut.', 'Fetches your activities, automatically every 30 minutes.']],
    ['data', 'Sq', 'Squadrats.com', 'KML', ['Import oficjalnego eksportu zdobytych kwadratów.', 'Imports the official export of collected squares.']],
    ['data', 'Gx', 'GPX', ['pliki', 'files'], ['Import przejazdów z dowolnego urządzenia, także przeciągnięciem na mapę.', 'Imports rides from any device, also by dropping them on the map.']],
    ['routing', 'BR', 'BRouter', ['własny serwer', 'self-hosted'], ['Silnik tras z pięcioma profilami rowerowymi i omijaniem już przejechanych dróg.', 'Routing engine with five bike profiles and avoidance of roads already ridden.']],
    ['routing', 'OR', 'OSRM', 'API', ['Szybkie trasy dla profilu Ogólny i jako rezerwa.', 'Fast routes for the General profile and as a fallback.']],
    ['maps', 'OSM', 'OpenStreetMap', ['mapa · baza POI · drogi', 'map · POI database · roads'], ['Mapa bazowa, lokalna baza punktów na trasie i informacja, czy przez kwadrat biegnie droga.', 'Base map, the local database of points along routes, and whether a road crosses a square.']],
    ['places', 'Nm', 'Nominatim', 'geocoding', ['Wyszukiwanie adresów i nazwy punktów trasy.', 'Address search and names of route points.']],
    ['places', 'Op', 'Overpass API', 'OSM', ['Rezerwowe źródło punktów na trasie.', 'Fallback source of points along the route.']],
    ['places', 'SV', 'Google Street View', 'Maps JS API', ['Panoramy obok mapy, ze strzałką Twojego widoku.', 'Panoramas beside the map, with an arrow for your view.']],
    ['places', 'GM', 'Google Maps', ['karty miejsc', 'place cards'], ['Opinie, zdjęcia i godziny otwarcia punktów na trasie.', 'Reviews, photos and opening hours of points along the route.']],
    ['places', 'W', 'Wikipedia', 'geosearch', ['Ciekawe miejsca przy trasie ze zdjęciem i opisem.', 'Places of interest by the route with a photo and summary.']],
    ['places', 'WC', 'Wikimedia Commons', ['zdjęcia', 'photos'], ['Zdjęcia ludzi do 300 m od trasy, zapamiętywane dla okolicy.', 'People’s photos within 300 m of the route, cached per area.']],
    ['places', 'Ml', 'Mapillary', ['zdjęcia z drogi', 'street-level'], ['Zdjęcia z poziomu drogi i panoramy 360°.', 'Street-level images and 360° panoramas.']],
    ['maps', 'My', 'Mapy.com', ['mapy turystyczne', 'outdoor maps'], ['Mapa turystyczna ze szlakami MTB i mapa lotnicza.', 'Outdoor map with MTB trails and an aerial map.']],
    ['maps', 'Bm', ['Mapy bazowe', 'Base maps'], 'CyclOSM · OpenTopoMap · Esri · Carto', ['Rowerowa, topograficzna, satelitarna i ciemna.', 'Cycling, topographic, satellite and dark.']],
    ['maps', 'GU', 'Geoportal GUGiK', ['lidar · orto · działki', 'lidar · orthophoto · parcels'], ['Rzeźba terenu z lotniczego skanu, zdjęcia lotnicze i ewidencja działek.', 'Terrain relief from airborne scans, aerial photos and the land parcel register.']],
    ['maps', 'LP', ['Bank Danych o Lasach', 'Forest Data Bank'], ['Lasy Państwowe', 'State Forests'], ['Oddziały leśne, czyli sieć duktów.', 'Forest compartments, i.e. the network of forest tracks.']],
    ['maps', 'GD', 'GDOŚ', ['ochrona przyrody', 'nature protection'], ['Rezerwaty, parki narodowe i użytki ekologiczne.', 'Reserves, national parks and ecological sites.']],
    ['maps', 'WT', 'Waymarked Trails', ['szlaki', 'routes'], ['Oznakowane szlaki rowerowe.', 'Signed cycle routes.']],
    ['maps', 'GPS', ['Ślady GPS OSM', 'OSM GPS traces'], ['heatmapa', 'heatmap'], ['Gęstość publicznych przejazdów, podstawa trybu Popularne.', 'Density of public rides, the basis of Popular mode.']],
    ['maps', 'SH', 'Strava Global Heatmap', ['link', 'link'], ['Otwiera globalną heatmapę Stravy w nowej karcie.', 'Opens the Strava global heatmap in a new tab.']],
    ['devices', 'CIQ', 'Garmin Connect IQ', 'Edge 1040 / 1050', ['Pole danych z mapą kwadratów na żywo w trakcie jazdy.', 'A data field with a live square map while you ride.']],
    ['devices', 'GC', 'Garmin Connect', ['kursy', 'courses'], ['GPX z wysokościami gotowy do importu jako kurs.', 'GPX with elevations, ready to import as a course.']],
    ['devices', 'Wa', 'Wahoo ELEMNT', ['udostępnianie', 'share sheet'], ['Wysyłka pliku trasy z telefonu jednym dotknięciem.', 'Sends the route file from the phone in one tap.']],
    ['devices', 'Loc', ['GPS telefonu', 'Phone GPS'], ['tryb Jadę', 'Riding mode'], ['Pozycja i postęp na zaplanowanej trasie.', 'Position and progress on the planned route.']],
    ['account', 'G', 'Google Sign-In', 'OAuth', ['Logowanie kontem Google bez nowego hasła.', 'Sign in with a Google account, no new password.']],
  ];
  const CATS = [['all', ['Wszystkie', 'All']], ['data', ['Dane', 'Data']], ['routing', ['Trasy', 'Routing']], ['maps', ['Mapy', 'Maps']], ['places', ['Miejsca i zdjęcia', 'Places and photos']], ['devices', ['Urządzenia', 'Devices']], ['account', ['Konto', 'Account']]];
  chapters.push(chapter('integracje', '--sq', [`${INT.length} ${pl ? 'integracje' : 'integrations'}`, `${INT.length} integrations`], ['Wszystko, z czym współpracuje planer', 'Everything the planner works with'],
    ['Planer łączy dane, które zwykle są rozsiane po kilkunastu stronach i aplikacjach. Poniżej jest pełna lista, z tym, co każda integracja daje Tobie.',
     'The planner brings together data that usually lives on a dozen sites and apps. Here is the full list, with what each one gives you.'],
    `<div class="int-filter" role="group" aria-label="${T(['Filtr integracji', 'Integration filter'])}">${CATS.map(([k, l], i) => `<button type="button" data-f="${k}" aria-pressed="${i ? 'false' : 'true'}">${T(l)}</button>`).join('')}</div>
     <div class="int-grid">${INT.map(([cat, mono, name, sub, desc]) => `<article class="int" data-cat="${cat}" style="--c:var(${C[cat]})"><header><span class="mono">${mono}</span><h4>${T(name)}<small>${T(sub)}</small></h4></header><p>${T(desc)}</p></article>`).join('')}</div>`));

  // ── technical chapter ────────────────────────────────────────────────────
  const archSvg = () => {
    const box = (x, y, w, h, cls, title, lines = [], tag = '') => `<g class="${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/>
      <text class="t" x="${x + 16}" y="${y + 26}">${title}</text>${tag ? `<text class="tag" x="${x + w - 14}" y="${y + 26}" text-anchor="end">${tag}</text>` : ''}
      ${lines.map((l, i) => `<text class="s" x="${x + 16}" y="${y + 48 + i * 18}">${l}</text>`).join('')}</g>`;
    const db = (x, y, w, name, sub) => `<g class="db"><path d="M${x} ${y + 7}v26c0 4 ${w / 2 - 4} 7 ${w / 2} 7s${w / 2} -3 ${w / 2} -7v-26"/><ellipse cx="${x + w / 2}" cy="${y + 7}" rx="${w / 2}" ry="7"/>
      <text class="d" x="${x + w / 2}" y="${y + 26}" text-anchor="middle">${name}</text><text class="ds" x="${x + w / 2}" y="${y + 52}" text-anchor="middle">${sub}</text></g>`;
    const list = (x, y, w, title, items, cls) => `<g class="${cls}"><rect x="${x}" y="${y}" width="${w}" height="${36 + items.length * 26}" rx="12"/>
      <text class="t" x="${x + 16}" y="${y + 24}">${title}</text>
      ${items.map((l, i) => `<text class="s" x="${x + 16}" y="${y + 52 + i * 26}"><tspan class="dot">●</tspan> ${l}</text>`).join('')}</g>`;
    const lbl = (x, y, t, a = 'middle') => `<text class="lbl" x="${x}" y="${y}" text-anchor="${a}">${t}</text>`;
    return `<svg class="arch" viewBox="0 0 1100 700" role="img" aria-label="${T(['Diagram architektury Squadrats', 'Squadrats architecture diagram'])}">
      <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="ahp"/></marker></defs>
      <text class="col" x="20" y="40">${T(['URZĄDZENIA', 'DEVICES'])}</text>
      <text class="col" x="300" y="40">${T(['SERWER · DOCKER COMPOSE', 'SERVER · DOCKER COMPOSE'])}</text>
      <text class="col" x="810" y="40">${T(['USŁUGI ZEWNĘTRZNE', 'EXTERNAL SERVICES'])}</text>
      <rect class="frame" x="290" y="58" width="460" height="566" rx="18"/>
      ${box(20, 80, 230, 170, 'b-dev', T(['Przeglądarka', 'Browser']), [T(['komputer i telefon', 'computer and phone']), 'index.html (SPA)', 'Leaflet 1.9.4', 'i18n.js · PL / EN', T(['brak kroku budowania', 'no build step'])])}
      ${box(20, 350, 230, 120, 'b-dev', 'Garmin Edge', [T(['pole danych Connect IQ', 'Connect IQ data field']), T(['internet przez telefon', 'internet via the phone']), '(Garmin Connect)'])}
      ${box(20, 520, 230, 100, 'b-tool', 'tools/update-pois.sh', [T(['import OSM z Geofabrik', 'OSM import from Geofabrik']), T(['Polska · .osm.pbf · osmium', 'Poland · .osm.pbf · osmium'])])}
      ${box(320, 80, 410, 66, 'b-web', 'squadrats-frontend', ['nginx:alpine · ' + T(['pliki statyczne, proxy /api i /auth', 'static files, proxy for /api and /auth'])], ':8081')}
      ${box(320, 186, 410, 196, 'b-api', 'squadrats-backend', ['Node 20 · Express · better-sqlite3', 'planner · priority · routing · tiles', 'strava · oauth · photos · mapillary', 'popular · reach · kml · db', T(['SSE: postęp synchronizacji na żywo', 'SSE: live sync progress']), T(['auto-sync Stravy co 30 min', 'Strava auto-sync every 30 min'])], ':3000')}
      ${box(320, 420, 150, 90, 'b-rt', 'squadrats-brouter', ['Java 17 · :17777', T(['profile .brf', '.brf profiles'])])}
      ${db(335, 548, 120, 'brouter-segments', T(['650 MB · rd5', '650 MB · rd5']))}
      <g class="vol"><rect x="490" y="420" width="240" height="190" rx="12"/><text class="t" x="506" y="444">${T(['wolumen ./data', 'volume ./data'])}</text></g>
      ${db(502, 458, 104, 'squadrats.db', T(['konta, kwadraty', 'accounts, squares']))}
      ${db(614, 458, 104, 'pois.db', T(['punkty POI', 'POIs']))}
      ${db(502, 530, 104, 'popular.db', T(['szlaki', 'cycle network']))}
      ${db(614, 530, 104, 'reach.db', T(['bez dróg', 'no-road index']))}
      <text class="ds" x="610" y="600" text-anchor="middle">+ photos.db · gpstiles/</text>
      ${list(800, 70, 280, T(['przez backend (klucze na serwerze)', 'via the backend (server-side keys)']), ['Strava API · OAuth', 'Google OAuth · Places', 'Google Street View', T(['OSRM (rezerwa tras)', 'OSRM (routing fallback)']), 'Overpass API', 'Wikipedia', 'Mapillary', T(['Mapy.com (proxy kafelków)', 'Mapy.com (tile proxy)']), T(['ślady GPS OSM (cache)', 'OSM GPS traces (cached)'])], 'b-ext')}
      ${list(800, 400, 280, T(['wprost z przeglądarki', 'straight from the browser']), [T(['kafelki map: OSM, Carto, Esri…', 'map tiles: OSM, Carto, Esri…']), 'Geoportal · BDL · GDOŚ', T(['Nominatim (adresy)', 'Nominatim (addresses)']), 'Wikimedia Commons'], 'b-dir')}
      <g class="ar">
        <path d="M250 112H318" marker-end="url(#ah)"/>${lbl(284, 104, 'HTTP(S)')}
        <path d="M250 410H300V136H318" marker-end="url(#ah)"/><text class="lbl" transform="translate(294 300) rotate(-90)" text-anchor="middle">/api/garmin/area</text>
        <path d="M525 146V184" marker-end="url(#ah)"/>${lbl(533, 170, T(['/api, /auth, SSE', '/api, /auth, SSE']), 'start')}
        <path d="M395 382V418" marker-end="url(#ah)"/>${lbl(403, 404, 'HTTP', 'start')}
        <path d="M395 510V546" marker-end="url(#ah)"/>
        <path d="M610 382V418" marker-end="url(#ah)"/>${lbl(618, 404, 'SQLite', 'start')}
        <path d="M730 284H760V200H798" marker-end="url(#ah)"/>${lbl(764, 280, 'HTTPS', 'start')}
        <path d="M135 250V320H270V672H940V640" marker-end="url(#ah)" class="dash"/>${lbl(600, 666, T(['kafelki map, adresy i zdjęcia pobiera przeglądarka', 'the browser fetches map tiles, addresses and photos itself']))}
        <path d="M250 600H280V650H610V612" marker-end="url(#ah)"/>${lbl(445, 644, T(['nowe pois / popular / reach.db', 'fresh pois / popular / reach.db']))}
      </g>
    </svg>`;
  };
  const tbl = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${T(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${T(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const flow = (title, steps) => `<section class="flow"><h4>${T(title)}</h4><ol>${steps.map(s => `<li>${T(s)}</li>`).join('')}</ol></section>`;

  chapters.push(chapter('technika', '--route', ['Technika', 'Under the hood'], ['Architektura: kontenery, bazy i połączenia', 'Architecture: containers, databases and connections'],
    ['Squadrats to trzy kontenery Dockera i kilka plików SQLite. Bez chmury i bez zewnętrznej bazy danych: całość działa na jednym komputerze, a w produkcji w OpenShift. Ten rozdział jest dla osób, które aplikację uruchamiają, rozwijają albo oceniają jej bezpieczeństwo.',
     'Squadrats is three Docker containers and a few SQLite files. No cloud and no external database: it all runs on one computer, and on OpenShift in production. This chapter is for people who run, develop or review the app.'],
    `<div class="arch-wrap">${archSvg()}</div><p class="swipe-hint">${T(['← przesuń diagram w bok →', '← swipe the diagram sideways →'])}</p>
    <p class="note">${T(['<b>Jak czytać diagram:</b> ciągłe strzałki to ruch przez serwer, przerywana to zapytania, które przeglądarka wysyła sama. Klucze płatnych usług (Google, Mapy.com, Mapillary, Strava) są tylko w backendzie, w pliku <code>.env</code>.', '<b>Reading the diagram:</b> solid arrows go through the server, the dashed one is requests the browser makes itself. Keys for paid services (Google, Mapy.com, Mapillary, Strava) live only in the backend, in <code>.env</code>.'])}</p>

    <h3>${T(['Kontenery', 'Containers'])}</h3>
    ${tbl([['Kontener', 'Container'], ['Technologia', 'Technology'], ['Port', 'Port'], ['Rola', 'Role']], [
      ['<code>squadrats-frontend</code>', 'nginx:alpine', '8081', ['Serwuje aplikację (<code>index.html</code>, <code>i18n.js</code>), podręcznik <code>/docs</code> i strony prawne. Przekazuje <code>/api</code> i <code>/auth</code> do backendu bez buforowania, żeby postęp synchronizacji (SSE) docierał na żywo.', 'Serves the app (<code>index.html</code>, <code>i18n.js</code>), the <code>/docs</code> manual and legal pages. Proxies <code>/api</code> and <code>/auth</code> to the backend unbuffered, so sync progress (SSE) arrives live.']],
      ['<code>squadrats-backend</code>', 'Node 20 · Express · better-sqlite3', '3000', ['Całe API: konta, kwadraty, planowanie pętli, priorytety, synchronizacja Stravy, POI, zdjęcia, pośrednik dla płatnych map. Kompresja gzip odpowiedzi.', 'The whole API: accounts, squares, loop planning, priorities, Strava sync, POIs, photos, a proxy for paid maps. Gzip-compressed responses.']],
      ['<code>squadrats-brouter</code>', 'Java 17 · BRouter', '17777', ['Silnik tras offline na mapie Polski. Własne profile <code>rowery-pl.brf</code> i <code>safety.brf</code> wykluczają drogi ekspresowe. Umie omijać już przejechane drogi.', 'Offline routing engine on the map of Poland. Custom <code>rowery-pl.brf</code> and <code>safety.brf</code> profiles rule out expressways. Can avoid roads already ridden.']],
    ])}

    <h3>${T(['Bazy danych', 'Databases'])}</h3>
    <p>${T(['Każda baza to jeden plik SQLite w wolumenie <code>./data</code>, więc kopia zapasowa to skopiowanie katalogu. Bazy OSM są przebudowywane obok i podmieniane w locie; backend sam je ponownie otwiera.', 'Each database is a single SQLite file in the <code>./data</code> volume, so a backup is a copy of the folder. OSM databases are rebuilt alongside and swapped in live; the backend reopens them by itself.'])}</p>
    ${tbl([['Plik', 'File'], ['Zawartość', 'Contents'], ['Źródło', 'Source'], ['Rozmiar', 'Size']], [
      ['<code>squadrats.db</code>', ['Konta, tokeny Stravy, aktywności, zdobyte SQ i SQI, kwadraty niezdobywalne, zapisane trasy, stan synchronizacji', 'Accounts, Strava tokens, activities, collected SQ and SQI, uncollectable squares, saved routes, sync status'], ['użytkownicy i Strava', 'users and Strava'], '5 MB'],
      ['<code>pois.db</code>', ['Punkty na trasie: jedzenie, woda, sklepy, noclegi, serwisy, atrakcje', 'Points along the route: food, water, shops, lodging, bike service, sights'], 'OSM · Geofabrik', '38 MB'],
      ['<code>popular.db</code>', ['Oznakowane szlaki i drogi rowerowe dla trybu Popularne', 'Signed cycle routes and paths for Popular mode'], 'OSM · Geofabrik', '15 MB'],
      ['<code>reach.db</code>', ['Squadratinhos, przez które nie biegnie żadna droga', 'Squadratinhos with no road through them'], 'OSM · Geofabrik', '2 MB'],
      ['<code>photos.db</code>', ['Pamięć zdjęć z Wikimedia Commons według obszarów, ważna 60 dni', 'Wikimedia Commons photo cache per area, kept for 60 days'], ['przeglądarki użytkowników', 'users’ browsers'], '1 MB'],
      ['<code>gpstiles/</code>', ['Pamięć kafelków śladów GPS OSM dla trybu Popularne', 'Cache of OSM GPS trace tiles for Popular mode'], 'openstreetmap.org', '—'],
      ['<code>brouter-segments/</code>', ['Graf drogowy Polski dla BRouter', 'Road graph of Poland for BRouter'], 'brouter.de', '650 MB'],
    ])}

    <h3>${T(['Jak płyną dane', 'How data flows'])}</h3>
    <div class="flows">
      ${flow(['Planowanie pętli', 'Planning a loop'], [
        ['Przeglądarka wysyła start, długość, profil i cel do <code>/api/route/detour</code>.', 'The browser sends the start, length, profile and goal to <code>/api/route/detour</code>.'],
        ['Planer rysuje dziesiątki kandydatów: elipsy w 16 kierunkach i „płatki” do skupisk niezdobytych kwadratów.', 'The planner draws dozens of candidates: ellipses in 16 directions and “petals” towards clusters of uncollected squares.'],
        ['Najlepsze wyznacza BRouter w dwóch połowach. Druga omija drogi pierwszej, więc powrót jest inny.', 'BRouter routes the best ones in two halves. The second avoids the first one’s roads, so the way back differs.'],
        ['Wygrywa trasa, która realnie zbiera najwięcej, trzyma długość i nie dubluje dróg.', 'The winner is the route that actually collects the most, keeps the length and doesn’t repeat roads.'],
      ])}
      ${flow(['Synchronizacja Stravy', 'Strava sync'], [
        ['Logowanie OAuth Stravy zapisuje tokeny w <code>squadrats.db</code>.', 'Strava OAuth sign-in stores tokens in <code>squadrats.db</code>.'],
        ['Co 5 minut backend sprawdza, czyja synchronizacja jest starsza niż 30 minut.', 'Every 5 minutes the backend checks whose sync is older than 30 minutes.'],
        ['Nowe aktywności zamienia na SQ i SQI i przelicza Yard, Über i priorytety.', 'New activities become SQ and SQI, and Yard, Über and priorities are recalculated.'],
        ['Ręczna synchronizacja pokazuje postęp na żywo przez SSE.', 'A manual sync shows live progress over SSE.'],
      ])}
      ${flow(['Zdjęcia z trasy', 'Photos along the route'], [
        ['Backend zwraca zdjęcia z <code>photos.db</code> dla obszarów już znanych.', 'The backend returns photos from <code>photos.db</code> for areas it already knows.'],
        ['Brakujące obszary przeglądarka pobiera z Commons i odsyła na serwer, więc następna osoba dostaje je od razu.', 'The browser fetches missing areas from Commons and posts them back, so the next person gets them at once.'],
        ['Mapillary czyta backend z kafelków wektorowych, a miniaturę dopiero po kliknięciu.', 'The backend reads Mapillary from vector tiles, and the thumbnail only on click.'],
      ])}
      ${flow(['Pole danych Garmin', 'Garmin data field'], [
        ['Profil generuje osobisty klucz Garmina.', 'The profile generates a personal Garmin key.'],
        ['Edge co 5 minut wysyła pozycję i klucz do <code>/api/garmin/area</code> przez telefon.', 'Every 5 minutes the Edge sends its position and key to <code>/api/garmin/area</code> through the phone.'],
        ['Backend odsyła mapę kwadratów wokół rowerzysty, a Edge rysuje ją w trakcie jazdy.', 'The backend returns the square map around the rider, and the Edge draws it while riding.'],
      ])}
    </div>

    <h3>${T(['API w skrócie', 'API at a glance'])}</h3>
    ${tbl([['Obszar', 'Area'], ['Endpointy', 'Endpoints'], ['Dostęp', 'Access']], [
      [['Konto', 'Account'], '<code>/api/auth/*</code> · <code>/api/profile/*</code> · <code>/auth/google</code> · <code>/auth/strava</code>', ['publiczne / zalogowany', 'public / signed in']],
      [['Kwadraty', 'Squares'], '<code>/api/tiles/sq|sqi|yard|uber|yardinho|uberinho|priority|noroad|reach-stats</code> · <code>/api/tiles/blocked/*</code>', ['zalogowany', 'signed in']],
      [['Trasy', 'Routes'], '<code>/api/route/detour</code> · <code>/api/route/preview-tiles</code> · <code>/api/routes</code> (CRUD)', ['zalogowany', 'signed in']],
      [['Dane', 'Data'], '<code>/api/sync</code> · <code>/api/sync/status</code> · <code>/api/gpx/import</code> · <code>/api/squadrats/import-kml</code>', ['zalogowany', 'signed in']],
      [['Na trasie', 'Along the route'], '<code>/api/route/pois|overpass|wiki-poi|photos</code> · <code>/api/photos/*</code> · <code>/api/poi/gplace</code> · <code>/api/mapillary/image/:id</code>', ['zalogowany', 'signed in']],
      [['Mapy', 'Maps'], '<code>/api/mapy/tile/:set/:z/:x/:y</code> · <code>/api/streetview/*</code>', ['zalogowany', 'signed in']],
      ['Garmin', '<code>/api/garmin/area</code>', ['klucz Garmina', 'Garmin key']],
      [['Administracja', 'Admin'], '<code>/api/admin/users</code> · <code>/api/log</code> · <code>/api/health</code>', ['administrator', 'administrator']],
    ])}

    <h3>${T(['Bezpieczeństwo i prywatność', 'Security and privacy'])}</h3>
    ${benefits([
      [['Sesja', 'Sessions'], ['Token JWT w ciasteczku httpOnly (SameSite=Lax) ważnym 30 dni. Skrypty strony nie mają do niego dostępu.', 'A JWT in an httpOnly cookie (SameSite=Lax) valid for 30 days. Page scripts cannot read it.']],
      [['Hasła', 'Passwords'], ['Skróty bcrypt, minimum 8 znaków z cyfrą. Logowanie: 10 prób na 15 minut, rejestracja: 5 na godzinę.', 'bcrypt hashes, at least 8 characters with a digit. Login: 10 tries per 15 minutes, sign-up: 5 per hour.']],
      [['Klucze usług', 'Service keys'], ['Google, Mapy.com, Mapillary i Strava tylko w <code>.env</code> serwera. Kafelki Mapy.com idą przez pośrednika, więc klucz nie trafia do przeglądarki.', 'Google, Mapy.com, Mapillary and Strava only in the server’s <code>.env</code>. Mapy.com tiles go through a proxy, so the key never reaches the browser.']],
      [['Logi', 'Logs'], ['Logi kontenerów mają limit 3 × 10 MB, bo zawierają adresy IP i pozycje.', 'Container logs are capped at 3 × 10 MB, as they contain IP addresses and positions.']],
    ])}

    <h3>${T(['Uruchomienie i aktualizacja', 'Running and updating'])}</h3>
    <div class="table-wrap"><table><tbody>
      <tr><td>${T(['Lokalnie', 'Locally'])}</td><td><code>docker compose up -d</code> → <code>http://localhost:8081</code></td></tr>
      <tr><td>${T(['Produkcja', 'Production'])}</td><td>${T(['Manifesty OpenShift w <code>ocp/manifests</code>: sekret, backend, frontend, route i BRouter.', 'OpenShift manifests in <code>ocp/manifests</code>: secret, backend, frontend, route and BRouter.'])}</td></tr>
      <tr><td>${T(['Dane OSM', 'OSM data'])}</td><td><code>tools/update-pois.sh</code> · ${T(['pobiera nowszy wyciąg Polski i przebudowuje pois, popular i reach.db bez zatrzymywania aplikacji', 'downloads a newer Poland extract and rebuilds pois, popular and reach.db without stopping the app'])}</td></tr>
      <tr><td>Garmin</td><td><code>garmin/build.sh</code> · ${T(['buduje pole danych Connect IQ', 'builds the Connect IQ data field'])}</td></tr>
      <tr><td>${T(['Podręcznik', 'Manual'])}</td><td><code>node frontend/docs/tools/build.mjs</code> · ${T(['zrzuty:', 'screenshots:'])} <code>tools/docshots.mjs</code></td></tr>
    </tbody></table></div>`));

  chapters.push(chapter('skroty', '--muted', ['Skróty', 'Shortcuts'], ['Szybciej klawiaturą i gestami', 'Faster with keys and gestures'],
    ['Na komputerze najczęstsze czynności mają skróty klawiszowe. Na telefonie wszystko jest pod kciukiem.', 'On a computer the most common actions have keyboard shortcuts. On a phone everything is under your thumb.'],
    `<div class="kbd-grid">
      <div><kbd>S</kbd>${T(['tryb Start', 'Start mode'])}</div><div><kbd>E</kbd>${T(['tryb Meta', 'Finish mode'])}</div>
      <div><kbd>W</kbd>${T(['punkt pośredni', 'via point'])}</div><div><kbd>Esc</kbd>${T(['tryb Widok', 'View mode'])}</div>
      <div><kbd>Enter</kbd>${T(['oblicz trasę', 'calculate route'])}</div><div><kbd>Del</kbd>${T(['wyczyść trasę', 'clear route'])}</div>
      <div><kbd>Ctrl</kbd><kbd>Z</kbd>${T(['cofnij punkt', 'undo point'])}</div><div><kbd>3×</kbd>${T(['kliknięcie: kwadrat niezdobywalny', 'click: uncollectable square'])}</div>
    </div>
    <p class="note">${T(['<b>Telefon:</b> dolny pasek „Zaplanuj trasę” otwiera arkusz, przeciągnięcie uchwytu zmienia jego wysokość, menu mapy ma wszystkie narzędzia, a trzy szybkie stuknięcia oznaczają kwadrat.', '<b>Phone:</b> the “Plan route” bar opens the sheet, dragging the handle resizes it, the map menu holds every tool, and three quick taps mark a square.'])}</p>`));

  // ── page ──────────────────────────────────────────────────────────────────
  const dateStr = today.toLocaleDateString(pl ? 'pl-PL' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!doctype html>
<html lang="${L}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="claude:viewport-fit-sides" content="cover">
<title>${T(['Podręcznik Squadrats', 'Squadrats Manual'])}</title>
<meta name="description" content="${T(['Podręcznik użytkownika Squadrats Route Planner: planowanie tras zbierających kwadraty, mapy, integracje, komputer i telefon.', 'Squadrats Route Planner user manual: planning routes that collect squares, maps, integrations, computer and phone.'])}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,600..800&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=JetBrains+Mono:wght@500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap">
<link rel="stylesheet" href="assets/docs.css">
<link rel="alternate" hreflang="${pl ? 'en' : 'pl'}" href="${pl ? 'en.html' : 'index.html'}">
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="#"><span class="brand-mark">SQ</span>Squadrats <small>${T(['podręcznik', 'manual'])}</small></a>
  <nav class="top-nav" aria-label="${T(['Główne', 'Main'])}">
    <a class="pill-link" href="#planowanie">${T(['Planowanie', 'Planning'])}</a>
    <a class="pill-link" href="#integracje">${T(['Integracje', 'Integrations'])}</a>
    <span class="lang"><a href="index.html" hreflang="pl" ${pl ? 'aria-current="page"' : ''}>PL</a><a href="en.html" hreflang="en" ${pl ? '' : 'aria-current="page"'}>EN</a></span>
    <a class="pill-link cta" href="/">${T(['Otwórz aplikację', 'Open the app'])}</a>
  </nav>
</div></header>

<section class="hero">
  <canvas id="hero-grid" aria-hidden="true"></canvas>
  <div class="wrap">
    <div>
      <span class="eyebrow rise">Squadrats Route Planner</span>
      <h1 class="rise d1">${T(['Każdy przejazd <em>zdobywa&nbsp;teren.</em>', 'Every ride <em>claims ground.</em>'])}</h1>
      <p class="lede rise d2">${T(['Planer tras rowerowych dla graczy Squadrats. Łączy Twoje przejazdy ze Stravy z siatką kwadratów, układa pętle, które zbierają najwięcej nowych kwadratów i nie wracają tą samą drogą, i pokazuje wszystko, co spotkasz po drodze. Na komputerze i na telefonie.', 'A cycling route planner for Squadrats players. It joins your Strava rides with the square grid, builds loops that collect the most new squares without riding back the same road, and shows everything you will meet on the way. On a computer and on a phone.'])}</p>
      <div class="hero-cta rise d3">
        <a class="btn primary" href="#start">${T(['Start w 4 krokach', 'Start in 4 steps'])} →</a>
        <a class="btn" href="#kwadraty">${T(['Jak działają kwadraty', 'How squares work'])}</a>
      </div>
      <div class="hud" aria-label="${T(['Animacja: pętla zdobywa kwadraty', 'Animation: a loop claims squares'])}">
        <span class="hud-chip"><i style="background:var(--new)"></i><span data-hud="sqi">+0</span>&nbsp;SQI</span>
        <span class="hud-chip"><i style="background:var(--route)"></i><span data-hud="km">0</span>&nbsp;km</span>
        <span class="hud-chip"><i style="background:var(--sqi)"></i>z14 · 1524 m</span>
        <span class="hud-chip"><i style="background:var(--sq)"></i>z17 · 191 m</span>
      </div>
    </div>
    <div class="hero-shots">
      <div class="frame-desk"><div class="bar"><i></i><i></i><i></i><span>squadrats</span></div><img class="shot" src="${IMG('d-hero')}" alt="${T(['Planer na komputerze: pętla 37 km z 52 nowymi squadratinhos', 'The planner on a computer: a 37 km loop with 52 new squadratinhos'])}" width="2160" height="1350"></div>
      <div class="frame-phone"><img class="shot" src="${IMG('m-route')}" alt="${T(['Planer na telefonie', 'The planner on a phone'])}" width="975" height="2110"></div>
    </div>
  </div>
</section>

<div class="wrap layout">
  <nav class="toc" aria-label="${T(['Rozdziały', 'Chapters'])}">
    <p>${T(['Rozdziały', 'Chapters'])}</p>
    <ol>${chapters.map((c, i) => `<li><a href="#${c.id}"><span>${String(i + 1).padStart(2, '0')}</span>${T(c.eyebrow)}</a></li>`).join('')}</ol>
  </nav>
  <main>${chapters.map(c => c.html).join('\n')}</main>
</div>

<footer class="foot"><div class="wrap">
  <span>Squadrats Route Planner · ${T(['podręcznik aktualny na', 'manual current as of'])} ${dateStr}${commit ? ` · ${T(['wersja', 'version'])} <code>${commit}</code>` : ''}</span>
  <span><a href="${pl ? 'en.html' : 'index.html'}">${pl ? 'English version' : 'Wersja polska'}</a> · <a href="/privacy.html">${T(['Prywatność', 'Privacy'])}</a> · <a href="/terms.html">${T(['Regulamin', 'Terms'])}</a></span>
</div></footer>
<script src="assets/docs.js"></script>
</body>
</html>
`;
}

fs.writeFileSync(path.join(DIR, 'index.html'), build('pl'));
fs.writeFileSync(path.join(DIR, 'en.html'), build('en'));
console.log('built', path.join(DIR, 'index.html'), path.join(DIR, 'en.html'), commit);

// Self-contained copy for sharing outside the app (e.g. a hosted page):
//   node frontend/docs/tools/build.mjs --share <outdir>
// CSS/JS inlined, no link to the local app or its legal pages; the PL page
// is written without the document skeleton (the host adds it), EN is a full page.
const si = process.argv.indexOf('--share');
if (si > 0) {
  const out = path.resolve(process.argv[si + 1]);
  fs.mkdirSync(path.join(out, 'img'), { recursive: true });
  const css = fs.readFileSync(path.join(DIR, 'assets/docs.css'), 'utf8');
  const js = fs.readFileSync(path.join(DIR, 'assets/docs.js'), 'utf8');
  const share = (html, bare) => {
    html = html.replace('<link rel="stylesheet" href="assets/docs.css">', `<style>${css}</style>`)
      .replace('<script src="assets/docs.js"></script>', `<script>${js}</script>`)
      .replace(/<a class="pill-link cta" href="\/">[^<]*<\/a>/, '')
      .replace(/ · <a href="\/privacy\.html">[^<]*<\/a> · <a href="\/terms\.html">[^<]*<\/a>/, '');
    if (bare) html = html.replace(/^<!doctype html>\n<html lang="\w+">\n<head>\n<meta charset="utf-8">\n<meta name="viewport"[^>]*>\n/, '')
      .replace('</head>\n<body>\n', '').replace(/<\/body>\n<\/html>\n$/, '');
    return html;
  };
  fs.writeFileSync(path.join(out, 'index.html'), share(build('pl'), true));
  fs.writeFileSync(path.join(out, 'en.html'), share(build('en'), false));
  fs.cpSync(path.join(DIR, 'img'), path.join(out, 'img'), { recursive: true });
  console.log('share copy in', out);
}
