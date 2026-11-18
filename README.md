# Sepur Live

**Peta langsung, jadwal lengkap, dan perencana perjalanan kereta api Indonesia.** A live map, full timetables and a journey planner for Indonesian trains: KRL Commuter Line, MRT Jakarta, LRT Jakarta, LRT Jabodebek, KA Bandara Soekarno-Hatta and Skytrain, Whoosh and KA Feeder, plus intercity (KA antarkota) and regional commuter trains across Java.

Live: **https://sepur-live.vercel.app**

Every train on the map is **computed from a timetable** and moved along real OpenStreetMap track geometry. Nothing is a GPS position, and the app says so on every screen ("Menurut jadwal"). Estimated services are labelled "Perkiraan".

> Inspired by the interaction design of [trafik.live](https://trafik.live). Sepur Live is an independent re-implementation with its own code, name, icons and data pipeline, and is not affiliated with trafik.live, KAI, KAI Commuter, MRT Jakarta, LRT Jakarta, KCIC or InJourney.

## Features

| Area | What it does |
|---|---|
| Animated map | MapLibre GL map (OpenFreeMap tiles). Train positions are recomputed **every animation frame** (requestAnimationFrame) along OSM track: trains accelerate out of stations, brake into stops, wait at each stop, and run at constant speed through stations they pass. Each train shows a heading arrow rotated to the track direction. The frame rate adapts (60 → 30 → 15 fps if frames get slow, lower when zoomed out) and only trains inside the viewport are drawn, so the ~230 trains of the morning rush stay smooth. |
| Journey planner (tab **Rute**) | Pick origin and destination (type or tap a station on the map), date and departure time, or "Berangkat sekarang". Routing uses the **Connection Scan Algorithm** over every timetable in the app (KRL, MRT, LRT, KA Bandara, Skytrain, Whoosh, KA Feeder, intercity, regional) for the chosen day plus the day before and after, with a 3-minute minimum change at the same station and walking time between linked stations computed from distance. It returns up to 5 Pareto-optimal options (later departure or earlier arrival) with departure, arrival, duration and transfers. |
| Journey detail | Every leg with train, direction, number of stops, the full stop list with times, change waits and walks, the route drawn on the map in line colours, a link to each train, and **Simulasikan**: plays the journey at 60× with the map following whichever leg is running. |
| Train detail + prediction | Live status ("Menuju Cikini, prediksi tiba 07.32 (2 mnt)"), progress bar, full stop list with arrival and departure times and a live countdown to every remaining stop. For GAPEKA trains you can also show the stations they pass without stopping. **Ikuti di peta** follows the train; **Putar cepat** replays it at 30× (120× for intercity). |
| Station timetables | Departure board for the next 12 hours, then **Jadwal lengkap sehari**: every train that stops on the chosen date, grouped by direction, with train number and time, filterable per line, with a 7-day date strip and a date picker (weekday, weekend and national holiday timetables are chosen automatically). |
| Line timetables | **Tabel jadwal** per line: a grid of stations × trips for one direction, in 2-hour windows, with direction toggle, date picker, passing points marked "|", and estimated columns marked "~". |
| Simulation clock | A time bar appears whenever the clock is not "now" (deep link, simulation, replay) with 1× / 10× / 60× / 300× and "Sekarang". |
| Also | Search (stations, lines, intercity train names, train numbers such as `1000` or `KA 5`, places via Photon), favourite station board, nearest stations, 3D buildings, underground view, layer toggles, deep links (`#station=MRI`, `#line=krl-b`, `#train=1000&td=2026-11-19`, `#tab=rute&from=BOO&to=BST&pd=2026-11-19&pt=0700`, time travel `#t=0730&d=2026-11-19&x=60`), PWA manifest, offline banner. |

Platform numbers are not shown anywhere: none of the open sources below publishes them, and the app says so.

## Data: what is real and what is estimated

| Service | Source | Status |
|---|---|---|
| KRL Commuter Line (Bogor, Cikarang, Rangkasbitung, Tangerang, Tanjung Priok, KA Lokal Merak) | [Open-KRL](https://github.com/open-krl/pipeline) captures of public KAI Commuter station boards (CC-BY 4.0): weekday 2026-10-12, Sunday 2026-10-11 | Real planned times. Arrival = departure − 25 s dwell. |
| KA antarkota and commuter daerah in Java (107 services, 580 daily trips), KA Bandara Soekarno-Hatta, KA Feeder Whoosh | **GAPEKA 2026** (KAI's official working timetable) parsed with [transportforbandung/Gapeka-parser](https://github.com/transportforbandung/Gapeka-parser) | Real planned arrival and departure times at stops. GAPEKA has no day-of-operation field, so trains are assumed to run every day (shown in the UI); *Fakultatif* services are flagged. Times at stations a train passes without stopping are parser or distance estimates, marked "~". |
| MRT Jakarta | [ShioriLabs commute](https://github.com/ShioriLabs/commute) (ODbL 1.0), from the MRT Jakarta feed | Weekdays real. **Weekends and holidays: frequency estimate**, labelled Perkiraan. Arrival at the terminus estimated. |
| LRT Jakarta, LRT Jabodebek (weekday + weekend), Skytrain Soekarno-Hatta | ShioriLabs commute (ODbL 1.0) | Real departure times; arrival at the terminus estimated from distance (marked "~"). |
| Whoosh (KCIC) | Published frequency pattern | **Estimate** ("Perkiraan"), with Sepur Live trip numbers. No open timetable was found. |
| Track geometry, stations | OpenStreetMap (ODbL), Geofabrik Java extract | 488 of 494 station-to-station sections follow real track; 6 short ones are straight lines. 26 GAPEKA station codes have no coordinates and are skipped. |

Positions, ETAs and journey plans are **predictions from the timetable**: delays, cancellations and disruptions are not visible.

## Run locally

```bash
npm ci
npm run build        # bundles src/ -> dist/
npm run serve        # http://localhost:5173
```

Open `http://localhost:5173/#t=0730&d=2026-11-19` to see the weekday morning rush at any hour.

## Tests

```bash
sh ./test.sh         # build + unit tests + headless smoke test
npm test             # engine + planner unit tests only (node:test)
```

Unit tests cover the Jakarta clock and day types, real KRL and GAPEKA times, rush-hour and night counts, continuous positions (no jumps), station boards and full-day timetables, line grids, and journeys (Bogor → Bandara with a transfer, Gambir → Surabaya Gubeng by intercity, MRT → LRT). The smoke test (`tests/smoke.mjs`, playwright-core + Chrome) checks the animation loop, home counts, station board and full timetable with the date picker, train ETAs, the line grid, source labels, search, the planner, journey detail and simulation, the night view and the mobile sheet, with zero page errors.

## Data pipeline (rebuild the data)

```bash
# 1) OSM railways from the Geofabrik Java extract (~900 MB)
curl -LO https://download.geofabrik.de/asia/indonesia/java-latest.osm.pbf
python3 scripts/extract_osm.py java-latest.osm.pbf raw/osm_rail.json
# 2) timetables
git clone --depth 1 https://github.com/open-krl/pipeline openkrl
curl -L -o raw/gapeka/gapeka.db https://github.com/transportforbandung/Gapeka-parser/raw/main/gapeka.db
# ShioriLabs commute timetable SQL + stations_lat_lng.sql into raw/shiori/
# 3) build public/data/
python3 scripts/build_data.py --osm raw/osm_rail.json --krl openkrl --gapeka raw/gapeka/gapeka.db --shiori raw/shiori
```

Output: `network.json` (lines, stations, track sections; 167 KB gzipped), `trips.json` (KRL, MRT, LRT, Bandara, Feeder; 125 KB gzipped) and `kai.json` (intercity and regional, loaded after first paint; ~150 KB gzipped). Trips are packed as `[id, line, headsign, stations, dep[], arr[]|null, flags[]|null]`, where flag bit 0 = stops, bit 1 = estimated time.

## Project layout

```
index.html             app shell (pane, controls, time bar, loader, sheets)
src/main.js            UI, animated map layers, planner, timetables, search, URL state, bottom sheet
src/sched.js           engine: Jakarta clock, day types, trips, positions, boards, timetables, CSA planner
src/app.css            styles
scripts/build_data.py  data pipeline (OSM + Open-KRL + GAPEKA + ShioriLabs -> JSON)
scripts/extract_osm.py OSM .pbf -> railway ways, stations, route relations
scripts/build.mjs      esbuild bundle -> dist/
scripts/serve.mjs      tiny static server with gzip
tests/                 unit tests and headless smoke test
```

## Licence

Code: MIT © 2026 Hendra Bangun Dwi R (see `LICENSE`). Data in `public/data/` keeps the licences of its sources: OpenStreetMap (ODbL 1.0), Open-KRL (CC-BY 4.0), ShioriLabs commute (ODbL 1.0). GAPEKA timetable facts are KAI's; Gapeka-parser is used as a parsing tool.

## Ringkasan (Bahasa Indonesia)

Sepur Live menampilkan semua kereta yang jalan menurut jadwal di peta, bergerak halus di atas rel OpenStreetMap dengan panah arah. Tab **Rute** mencari perjalanan tercepat dari stasiun mana ke mana pada tanggal dan jam pilihanmu, termasuk pindah KRL, MRT, LRT, KA Bandara, Whoosh, dan KA antarkota, lalu bisa disimulasikan di peta. Setiap stasiun punya jadwal lengkap sehari, setiap jalur punya tabel jadwal, dan setiap kereta punya daftar berhenti dengan prediksi tiba. Jadwal KRL, KA antarkota (GAPEKA 2026), MRT hari kerja, LRT, dan Skytrain adalah jadwal resmi; Whoosh dan MRT akhir pekan masih perkiraan dan ditandai "Perkiraan". Semua posisi dan prediksi dihitung dari jadwal, bukan GPS.
