# Sepur Live

**Peta langsung, jadwal lengkap, dan perencana perjalanan kereta api Indonesia.** A live map, full timetables and a journey planner for Indonesian trains: KRL Commuter Line, MRT Jakarta, LRT Jakarta, LRT Jabodebek, KA Bandara Soekarno-Hatta and Skytrain, Whoosh and KA Feeder, plus intercity (KA antarkota) and regional commuter trains across Java.

Live: **https://sepur-live.vercel.app**

Every train on the map is **computed from a timetable** and moved along real OpenStreetMap track geometry. Nothing is a GPS position, and the app says so on every screen ("Menurut jadwal"). Estimated services are labelled "Perkiraan".

> Inspired by the interaction design of [trafik.live](https://trafik.live). Sepur Live is an independent re-implementation with its own code, name, icons and data pipeline, and is not affiliated with trafik.live, KAI, KAI Commuter, MRT Jakarta, LRT Jakarta, KCIC or InJourney.

## Features

| Area | What it does |
|---|---|
| Animated map | MapLibre GL map (OpenFreeMap tiles). Train positions are recomputed **every animation frame** (requestAnimationFrame) along OSM track with the speed profile below: trains accelerate out of stations, brake into stops, wait at each stop, and run at constant speed through stations they pass. Each train shows a heading arrow rotated to the track direction. The frame rate adapts (60 → 30 → 15 fps if frames get slow, lower when zoomed out) and only trains inside the viewport are drawn, so the ~230 trains of the morning rush stay smooth. |
| Journey planner (tab **Rute**) | Pick origin and destination (type or tap a station on the map), date and departure time, or "Berangkat sekarang". Routing uses the **Connection Scan Algorithm** over every timetable in the app (KRL, MRT, LRT, KA Bandara, Skytrain, Whoosh, KA Feeder, intercity, regional) for the chosen day plus the day before and after, with a 3-minute minimum change at the same station and walking time between linked stations computed from distance. It returns up to 5 Pareto-optimal options (later departure or earlier arrival) with departure, arrival, duration and transfers. |
| Journey detail | Every leg with train, direction, number of stops, the full stop list with times, change waits and walks, the route drawn on the map in line colours, a link to each train, and **Simulasikan**: plays the journey at 60× with the map following whichever leg is running. |
| Train detail + prediction | Live status ("Menuju Cikini, prediksi tiba 07.32 (2 mnt)"), progress bar, full stop list with arrival and departure times and a live countdown to every remaining stop. For GAPEKA trains you can also show the stations they pass without stopping. **Ikuti di peta** follows the train; **Putar cepat** replays it at 30× (120× for intercity). |
| Station timetables | Departure board for the next 12 hours, then **Jadwal lengkap sehari**: every train that stops on the chosen date, grouped by direction, with train number and time, filterable per line, with a 7-day date strip and a date picker (weekday, weekend and national holiday timetables are chosen automatically). |
| Line timetables | **Tabel jadwal** per line: a grid of stations × trips for one direction, in 2-hour windows, with direction toggle, date picker, passing points marked "|", and estimated columns marked "~". |
| Train card | Tap or click a train: name, number, type, destination ("Tujuan"), where it is now, next stop with countdown, **estimated speed**, trip average and peak, a picture of the typical rolling stock, and buttons for full details or following it. Hover on desktop shows name, destination and speed; at high zoom trains are labelled on the map. |
| Rolling-stock pictures | Each service is mapped to the rolling stock it typically uses (KRL JR 205 / CLI-125, MRT Jakarta Nippon Sharyo, LRT Jakarta Hyundai Rotem, LRT Jabodebek INKA, Whoosh KCIC400AF, KA Bandara EA203, Skytrain, CC 206 + Stainless Steel New Generation for Argo trains, CC 206 / CC 201 hauled trains). Labelled **"Ilustrasi: tipe armada yang umum dipakai"**: the exact unit on a trip is not public. Photos from Wikimedia Commons (CC0 / CC BY / CC BY-SA), resized to 640×360 WebP (~45 KB each), with author, licence and source link on every picture and in [`ATTRIBUTION.md`](ATTRIBUTION.md). `scripts/fetch_fleet.py` re-downloads them. |
| Speed estimate | Speed is derived from the timetable and the OSM track length between stations. Each section gets a trapezoid profile (accelerate, cruise, brake) with typical acceleration per system (KRL 0.7, MRT 0.9, intercity 0.25 m/s²…); trains pass non-stop stations at speed. Timetables are rounded to whole minutes, so running time is shared over ≥10-minute windows by distance before fitting, and shown speeds are capped at each system's top service speed. Train detail shows speed now, average with and without stops, estimated peak, track distance, a **speed chart** over the trip with a "now" marker, and the estimated peak for each section. Everything is labelled **"perkiraan dari jadwal, bukan GPS"**. The same profile drives the map animation, so the marker motion and the shown speed agree. |
| Level crossings (JPL) | **Perlintasan sebidang** layer (off by default, × button or layers panel, saved + `#jpl=1`). Built from OpenStreetMap and cleaned: of 6,622 raw OSM crossing nodes, 533 on disused/abandoned/tram/construction track, 335 on industrial-only track, 130 with no road through them and 2 on bridges/tunnels were dropped, and 2,190 multi-track duplicates (one node per track) were merged, giving **3,396 level crossings** with the number of tracks. Plus **1,304 grade separations** detected from geometry (409 flyovers, 895 underpasses: road and track cross without a shared node and bridge/tunnel/layer tags say which is on top). Status names follow DJKA/168railway where OSM tags allow: dijaga petugas (26), berpalang otomatis, berpalang · penjagaan belum terdata (279), tidak dijaga · lampu/bel (25), tidak dijaga · tanpa palang & sinyal (135), liar (5), ditutup (8), pejalan kaki (148), **pengaman belum terdata (2,770)**. **Filters** by status and by **Daop/Divre** (chips in the layers panel, clickable desktop legend, saved + `#js=…&jd=Daop2`). Card: photo or "Belum ada foto" with Mapillary / Street View / Commons links, road and class, barrier, light, bell, attendant, Daop, **KM estimate** (e.g. Jalan Braga ± 155+884), tracks, the stations it lies between, routes, next trains passing, data completeness (tinggi/sedang/rendah) and source. JPL numbers and gatekeepers are never invented: "Nomor JPL" shows only OSM `ref` (28) else "Belum ada di data terbuka". `jpl.json` ~160 KB gzipped, loaded only when needed. |
| Station photos | 448 of 483 stations (92.8 %) show a photo from Wikimedia Commons (Wikidata P18 via the OSM `wikidata` tag, fallback Wikidata station code P296), with author and licence, in the station panel and in a popup when you tap a station; Daop (435) and km position (434) from the Indonesian Wikipedia infobox. Thumbnails (500 px) are loaded lazily from Wikimedia; `stations_x.json` ~32 KB gzipped. |
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
| Level crossings | OpenStreetMap (ODbL), Geofabrik Java extract; km and Daop from id.wikipedia station infoboxes (CC BY-SA 4.0) scaled by GAPEKA station distances; photos Wikimedia Commons | Mapped by OSM volunteers: coverage and tags are incomplete ("belum terdata" does not mean unprotected). KM is an estimate (station km + position along the section), Daop comes from the stations at both ends (marked "perkiraan" when inferred). Official JPL numbers, gatekeeper (KAI/Dishub/swadaya) and EWS status are not open data and are not shown. Government portals that list JPLs (DJKA e-Perlintasan, SIMARLIN Lumajang, SIMINFRA Grobogan) publish no reuse licence, so they are not imported; 168railway data is not used. Crossing photos: only 26 crossings (+10 grade separations) have a geotagged Commons photo within 60 m whose title says it shows a crossing/railway. |
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
# 4) level crossings (needs public/data from step 3)
python3 scripts/fetch_stations.py                       # station photos, Daop, km -> public/data/stations_x.json
python3 scripts/extract_jpl.py java-latest.osm.pbf raw/osm_rail.json raw/jpl_osm2.json   # one pass, node index on disk
python3 scripts/fetch_commons_geo.py raw/jpl_osm2.json raw/commons_geo.json            # geotagged Commons files near crossings
python3 scripts/build_jpl.py raw/jpl_osm2.json         # clean, merge, status, km, Daop, photos -> public/data/jpl.json
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
scripts/extract_jpl.py OSM .pbf -> crossings, rail/road ways at them, road pieces near the track
scripts/build_jpl.py   clean + merge + status + flyover/underpass + km + Daop + photos -> public/data/jpl.json
scripts/fetch_stations.py   Wikidata/Commons station photos + Wikipedia Daop/km -> public/data/stations_x.json
scripts/fetch_commons_geo.py geotagged Commons files near crossings
scripts/fetch_fleet.py rolling-stock photos from Wikimedia Commons -> public/img/fleet + ATTRIBUTION.md
tests/                 unit tests and headless smoke test
```

## Licence

Code: MIT © 2026 Hendra Bangun Dwi R (see `LICENSE`). Photos in `public/img/fleet/` are not MIT: each keeps its Wikimedia Commons licence and author, listed in `ATTRIBUTION.md` (modified: cropped to 16:9, resized, WebP). Data in `public/data/` keeps the licences of its sources: OpenStreetMap (ODbL 1.0), Open-KRL (CC-BY 4.0), ShioriLabs commute (ODbL 1.0). GAPEKA timetable facts are KAI's; Gapeka-parser is used as a parsing tool.

## Ringkasan (Bahasa Indonesia)

Sepur Live menampilkan semua kereta yang jalan menurut jadwal di peta, bergerak halus di atas rel OpenStreetMap dengan panah arah. Tab **Rute** mencari perjalanan tercepat dari stasiun mana ke mana pada tanggal dan jam pilihanmu, termasuk pindah KRL, MRT, LRT, KA Bandara, Whoosh, dan KA antarkota, lalu bisa disimulasikan di peta. Setiap stasiun punya jadwal lengkap sehari, setiap jalur punya tabel jadwal, dan setiap kereta punya daftar berhenti dengan prediksi tiba. Jadwal KRL, KA antarkota (GAPEKA 2026), MRT hari kerja, LRT, dan Skytrain adalah jadwal resmi; Whoosh dan MRT akhir pekan masih perkiraan dan ditandai "Perkiraan". Lapisan **perlintasan sebidang (JPL)** dari OpenStreetMap bisa dimunculkan/disembunyikan lewat tombol × atau panel lapisan (pilihan disimpan, juga lewat `#jpl=1`); datanya sudah dibersihkan (perlintasan ganda per jalur digabung, rel mati/industri dan jembatan dibuang), punya status (dijaga, berpalang, tidak dijaga, liar, ditutup, flyover, underpass), filter per status dan Daop, perkiraan KM, serta foto Wikimedia bila ada (kalau belum: "Belum ada foto" + tautan Mapillary/Street View). Klik titiknya untuk melihat jenis pengaman, jalan, letak di antara stasiun, dan perkiraan kereta yang lewat berikutnya. Stasiun juga punya foto (448 dari 483) dari Wikimedia Commons dengan kredit dan lisensi. Klik kereta untuk melihat nama, tujuan, stasiun berikutnya, gambar tipe armada yang umum dipakai (foto Wikimedia Commons, kredit di setiap gambar dan di ATTRIBUTION.md), serta perkiraan kecepatan; detail kereta punya grafik kecepatan sepanjang perjalanan. Semua posisi, prediksi, dan kecepatan dihitung dari jadwal dan panjang rel, bukan GPS.
