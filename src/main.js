import maplibregl from 'maplibre-gl';
import { Engine, jakartaClock, dayType, fmt, dur, addDays, VMAX } from './sched.js';
import FLEET from '../public/data/fleet.json';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app'), view = $('#view'), pbody = $('#pbody');
const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const SYS_LABEL = { krl: 'KRL', mrt: 'MRT', lrtj: 'LRT Jakarta', jbdb: 'LRT Jabodebek', bandara: 'Bandara', whoosh: 'Whoosh', regional: 'Commuter daerah', kai: 'KA antarkota' };
const CHIP_SYS = [['all', 'Semua'], ['krl', 'KRL'], ['mrt', 'MRT'], ['lrt', 'LRT'], ['bandara', 'Bandara'], ['whoosh', 'Whoosh'], ['kai', 'Antarkota']];
const chipOf = (sys) => (sys === 'lrtj' || sys === 'jbdb' ? 'lrt' : sys === 'regional' ? 'kai' : sys);
const QUICK = ['MRI', 'THB', 'SUD', 'JNG', 'DU', 'GMR', 'PSE', 'BD', 'YK', 'SGU'];
const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('sepur:' + k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('sepur:' + k, JSON.stringify(v)); } catch {} } };
const A_SH = '<a href="https://github.com/ShioriLabs/commute" target="_blank" rel="noopener">ShioriLabs commute</a> (ODbL 1.0)';
const SRC = {
  krl: () => `Jadwal resmi KAI Commuter dari papan keberangkatan publik, dihimpun <a href="https://github.com/open-krl/pipeline" target="_blank" rel="noopener">Open-KRL</a> (CC-BY 4.0; hari kerja ${esc(NET.meta.krl.weekday)}, akhir pekan ${esc(NET.meta.krl.weekend)}).`,
  gapeka: () => `GAPEKA 2026 (grafik perjalanan resmi KAI) wilayah Jawa, dibaca dengan <a href="https://github.com/transportforbandung/Gapeka-parser" target="_blank" rel="noopener">Gapeka-parser</a>. Hari operasi tidak tercantum, jadi kereta dianggap jalan setiap hari. Sebagian waktu lewat di stasiun tanpa berhenti ditaksir.`,
  'shiori-mrt': () => `Jadwal hari kerja MRT Jakarta dari data terbuka ${A_SH}, berasal dari feed MRT Jakarta. Akhir pekan &amp; libur: <b>perkiraan</b> dari pola frekuensi.`,
  'shiori-lrtj': () => `Jadwal LRT Jakarta dari ${A_SH}. Waktu tiba di stasiun akhir ditaksir.`,
  'shiori-jbdb': () => `Jadwal LRT Jabodebek hari kerja dan akhir pekan dari ${A_SH}. Waktu tiba di stasiun akhir ditaksir.`,
  'shiori-apcgk': () => `Jadwal Skytrain Bandara Soekarno-Hatta dari poster jadwal, via ${A_SH}.`,
  freq: (l) => `<b>Perkiraan.</b> Jadwal resmi per kereta belum tersedia sebagai data terbuka. Kereta dibuat dari pola frekuensi yang diumumkan operator (kira-kira tiap ${esc((l.freq?.weekday || []).map((b) => b[2]).filter((v, i, a) => a.indexOf(v) === i).join('/'))} menit) dan kecepatan rata-rata. Nomor perjalanan buatan Sepur Live.`,
};
const srcOf = (l) => (l.sched === 'frequency' ? 'freq' : l.src || (l.sys === 'krl' ? 'krl' : 'gapeka'));

let NET, TRIPS, E, map;
const S = {
  tab: 'peta', detail: null, filter: 'all', follow: false, threeD: false, ug: false,
  q: '', at: null, layers: LS.get('layers', { krl: true, mrt: true, lrtj: true, jbdb: true, bandara: true, whoosh: true, regional: true, kai: true, stations: true, net: true, labels: true }),
  fav: LS.get('fav', null), recent: LS.get('recent', []), me: null, places: [], placeQ: '',
  plan: LS.get('plan', { from: null, to: null }), planRes: null, pick: null, pickQ: '',
  ttDate: null, ttDir: 0, ttHour: null, showPass: false, kaiState: 'loading',
};
S.plan.date = null; S.plan.time = null;
let lastRunning = [];

/* ---------- time (Asia/Jakarta); #t=HHMM&d=YYYY-MM-DD time travel, &x=60 simulation speed ---------- */
function clock() {
  if (!S.at) return jakartaClock();
  const el = ((performance.now() - S.at.wall) / 1000) * (S.at.speed || 1);
  let sec = S.at.sec + el, date = S.at.date;
  while (sec >= 86400) { sec -= 86400; date = addDays(date, 1); }
  return { date, sec, dow: new Date(date + 'T00:00:00Z').getUTCDay() };
}
function setClock(date, sec, speed = 1) { while (sec < 0) { sec += 86400; date = addDays(date, -1); } S.at = { date, sec, wall: performance.now(), speed }; actT = 0; }
const mins = (s) => { const m = Math.max(0, Math.round(s / 60)); return m < 1 ? 'sekarang' : m < 60 ? `${m} mnt` : `${Math.floor(m / 60)} j ${m % 60} mnt`; };
const lineOf = (id) => E.lines.get(id);
const stOf = (id) => E.st.get(id);
const lb = (l, ring) => `<span class="lb${ring ? ' ring' : ''}" style="${ring ? 'border-color' : 'background'}:${esc(l.color)}">${esc(l.short)}</span>`;
const dots = (s) => `<span class="dots">${s.lines.map(lineOf).filter(Boolean).slice(0, 6).map((l) => `<i style="background:${esc(l.color)}"></i>`).join('')}</span>`;
const isKA = (l) => !!l && (l.sys === 'kai' || l.sys === 'regional');
const shortId = (id) => id.replace(/^(KA|MRT|LRTJ|JBDB|SKY) /, '');
function trainName(t) {
  const l = lineOf(t.line);
  if (t.est) return `${SYS_LABEL[l.sys]} · perkiraan`;
  if (isKA(l) || l.id === 'kcic-f' || l.id === 'ka-bst') return `${t.id} ${l.name}`;
  return /^\d/.test(t.id) ? `KA ${t.id}` : t.id;
}
const TYPE = { krl: 'KRL Commuter Line', mrt: 'MRT (kereta perkotaan)', lrtj: 'LRT (kereta ringan)', jbdb: 'LRT (kereta ringan)', bandara: 'Kereta bandara', whoosh: 'Kereta cepat', regional: 'KA lokal / commuter daerah', kai: 'KA antarkota' };
/** Name, number, type and class of a trip for cards and labels (names come from the timetable data). */
/* ---------- rolling stock illustration + speed ---------- */
function fleetKey(l) {
  if (l.sys === 'krl' || l.id === 'g-commuter-line-yogyakarta') return 'krl';
  if (l.sys === 'mrt' || l.sys === 'lrtj' || l.sys === 'jbdb') return l.sys;
  if (l.id === 'kcic') return 'whoosh';
  if (l.id === 'ka-bst') return 'ea203';
  if (l.id === 'apcgk') return 'sky';
  if (l.sys === 'kai') return /^Argo /.test(l.name) ? 'argo' : 'ka';
  return 'lokal';
}
function fleetFig(l, cls = '') {
  const f = FLEET[fleetKey(l)]; if (!f) return '';
  return `<figure class="fleet ${cls}"><img src="${esc(f.img)}" alt="${esc(f.caption)}" loading="lazy" decoding="async" width="640" height="360"><figcaption><b>${esc(f.model)}</b><span>Ilustrasi: tipe armada yang umum dipakai, bukan unit yang sedang jalan · Foto <a href="${esc(f.source)}" target="_blank" rel="noopener">${esc(f.author)}</a>, <a href="${esc(f.licenseUrl || f.source)}" target="_blank" rel="noopener">${esc(f.license)}</a> via Wikimedia Commons</span></figcaption></figure>`;
}
const kmh = (v, l) => Math.round(Math.min(v * 3.6, VMAX[l.sys] || 350));
/** Current estimated speed text for a trip at time t. */
function speedNow(trip, t) {
  const l = lineOf(trip.line), s = E.state(trip, t);
  if (!s || t < trip.start) return { v: null, txt: t < trip.start ? 'Belum berangkat' : 'Sudah tiba' };
  if (s.kind === 'dwell') return { v: 0, txt: 'Berhenti · 0 km/j' };
  const v = kmh(s.v, l);
  return { v, txt: `≈ ${v} km/j` };
}
function trainInfo(t) {
  if (t._info) return t._info;
  const l = lineOf(t.line);
  const name = l.id === 'kcic' ? 'Whoosh' : l.name;
  const num = t.est ? 'Nomor buatan Sepur Live' : /^\d/.test(t.id) ? `KA ${t.id}` : t.id.replace(/^SKY /, 'Skytrain ').replace(/^JBDB /, 'LRT ').replace(/^LRTJ /, 'LRT ');
  const type = l.id === 'kcic-f' ? 'KA Feeder kereta cepat' : TYPE[l.sys] || 'Kereta';
  const cls = l.sys === 'kai' && /^Argo /.test(l.name) ? 'Eksekutif (kereta Argo)' : null;
  const short = isKA(l) || l.id === 'ka-bst' || l.id === 'kcic-f' ? name : t.est ? name : `${name.replace(/^Commuter Line /, 'CL ')}`;
  return (t._info = { name, num, type, cls, short, label: `${isKA(l) ? name : num} → ${t.head}` });
}
const sysName = (s) => s.sys.map((x) => SYS_LABEL[x]).filter((v, i, a) => a.indexOf(v) === i).join(' · ');
function dayLabel(date) { const dow = new Date(date + 'T00:00:00Z').getUTCDay(); return dayType(date, NET.holidays) === 'weekend' ? (dow === 0 || dow === 6 ? 'Akhir pekan' : 'Hari libur') : 'Hari kerja'; }
const DOW = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const dateNice = (d) => { const x = new Date(d + 'T00:00:00Z'); return `${DOW[x.getUTCDay()]}, ${x.getUTCDate()}/${x.getUTCMonth() + 1}`; };

/* ---------- boot ---------- */
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }
function bar(p) { $('#load-bar').style.width = Math.round(p * 100) + '%'; }
const busyTyping = () => document.activeElement && document.activeElement.matches('input');

async function boot() {
  readHash(true);
  bar(0.1);
  try {
    let n = 0;
    const step = (j) => (bar(0.15 + 0.35 * ++n), j);
    [NET, TRIPS] = await Promise.all([getJSON('/data/network.json').then(step), getJSON('/data/trips.json').then(step)]);
  } catch (e) {
    $('#load-t').textContent = 'Jadwal belum bisa dimuat';
    $('#load-s').textContent = 'Periksa koneksimu, lalu coba lagi.';
    $('#load-retry').hidden = false;
    $('#load-retry').onclick = () => location.reload();
    return;
  }
  E = new Engine(NET, TRIPS);
  bar(0.85);
  initMap();
  bindUI();
  render();
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden && !busyTyping()) render(true); }, 15000);
  addEventListener('online', netState); addEventListener('offline', netState); netState();
  // intercity and regional timetables (GAPEKA) load after first paint
  getJSON('/data/kai.json').then((k) => {
    E.addKai(k); S.kaiState = 'ok'; act = E.active(clock()); actT = performance.now(); actKey = clock().date + 'k'; lastRunning = E.running(clock(), act);
    if (map?.getSource('lines')) { map.getSource('lines').setData(lineFeatures()); map.getSource('stations').setData(stationFeatures()); }
    if (S.planRes || (S.plan.from && S.plan.to && S.tab === 'rute')) runPlan(false);
    else if (!busyTyping()) render(true);
    if (S.detail) focusDetail(false);
    app.dataset.kai = 'ok';
  }).catch(() => { S.kaiState = 'fail'; render(true); });
}

/* ---------- map ---------- */
function lineFeatures() {
  const f = [];
  for (const l of E.allLines()) {
    const done = new Set();
    // GAPEKA lines list every track section their trains use (including stations passed without stopping)
    if (l.pairs) { for (const k of l.pairs) { const [a, b] = k.split('>'); f.push({ type: 'Feature', properties: { line: l.id, sys: l.sys, color: l.color, ka: isKA(l) ? 1 : 0 }, geometry: { type: 'LineString', coordinates: E.seg(a, b).coords } }); } continue; }
    for (const p of [l.stations, ...(l.branches || [])])
      for (let i = 1; i < p.length; i++) {
        const k = p[i - 1] < p[i] ? p[i - 1] + '>' + p[i] : p[i] + '>' + p[i - 1];
        if (done.has(k)) continue; done.add(k);
        f.push({ type: 'Feature', properties: { line: l.id, sys: l.sys, color: l.color, ka: isKA(l) ? 1 : 0 }, geometry: { type: 'LineString', coordinates: E.seg(p[i - 1], p[i]).coords } });
      }
  }
  f.sort((a, b) => b.properties.ka - a.properties.ka); // intercity drawn under urban lines
  return { type: 'FeatureCollection', features: f };
}
function stationFeatures() {
  return { type: 'FeatureCollection', features: NET.stations.map((s) => {
    const ls = s.lines.map(lineOf).filter(Boolean);
    const main = ls.find((l) => !isKA(l)) || ls[0];
    const ka = s.sys.every((x) => x === 'kai' || x === 'regional') ? 1 : 0;
    return { type: 'Feature', properties: { id: s.id, name: s.name, sys: ka ? s.sys[0] : s.sys.find((x) => x !== 'kai' && x !== 'regional'), color: main ? main.color : '#9A9AA2', big: ls.length > 2 || s.xfer.length > 0 ? 1 : 0, ka }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } };
  }) };
}
const FC = (features = []) => ({ type: 'FeatureCollection', features });

// heading arrow drawn once into a canvas, tinted with an SDF icon
function arrowImage() {
  const W = 80, c = document.createElement('canvas'); c.width = c.height = W;
  const g = c.getContext('2d'); g.fillStyle = '#000';
  g.beginPath(); g.moveTo(W / 2, 2); g.lineTo(W / 2 + 10, 17); g.lineTo(W / 2 - 10, 17); g.closePath(); g.fill();
  return g.getImageData(0, 0, W, W);
}

function initMap() {
  popups();
  const h = S.view || { lng: 106.83, lat: -6.24, z: window.innerWidth < 760 ? 9.6 : 10.4 };
  map = new maplibregl.Map({ container: 'map', style: STYLE, center: [h.lng, h.lat], zoom: h.z, attributionControl: { compact: true }, maxPitch: 70, dragRotate: true, hash: false });
  map.on('error', (e) => console.warn('map', e?.error?.message || e));
  map.once('load', () => {
    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    map.addImage('sepur-arrow', arrowImage(), { sdf: true, pixelRatio: 2 });
    map.addSource('net', { type: 'geojson', data: FC(NET.net.map((n) => ({ type: 'Feature', properties: { m: n.m }, geometry: { type: 'LineString', coordinates: n.c } }))) });
    map.addLayer({ id: 'net', type: 'line', source: 'net', paint: { 'line-color': '#B9B9C0', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 1.6, 16, 3] } }, before);
    map.addSource('tun', { type: 'geojson', data: FC(NET.tunnels.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } }))) });
    map.addLayer({ id: 'tun', type: 'line', source: 'tun', layout: { visibility: 'none' }, paint: { 'line-color': '#111', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 7], 'line-dasharray': [1.2, 0.8], 'line-opacity': 0.75 } });
    map.addSource('lines', { type: 'geojson', data: lineFeatures() });
    const kaW = (a, b) => ['case', ['==', ['get', 'ka'], 1], a, b];
    map.addLayer({ id: 'lines-case', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, kaW(1.5, 2.5), 14, kaW(6, 9)] } });
    map.addLayer({ id: 'lines', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 6, kaW(1, 1.6), 14, kaW(3.5, 5.5)], 'line-opacity': kaW(0.55, 0.9) } });
    map.addSource('route', { type: 'geojson', data: FC() });
    map.addLayer({ id: 'route-case', type: 'line', source: 'route', filter: ['==', ['get', 'walk'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#111', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5, 14, 11], 'line-opacity': 0.8 } });
    map.addLayer({ id: 'route', type: 'line', source: 'route', filter: ['==', ['get', 'walk'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3, 14, 7] } });
    map.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'walk'], 1], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#333', 'line-width': 3, 'line-dasharray': [0.6, 1.6] } });
    map.addSource('stations', { type: 'geojson', data: stationFeatures() });
    map.addLayer({ id: 'st-c', type: 'circle', source: 'stations', minzoom: 7, paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['case', ['==', ['get', 'big'], 1], 3.5, 2.5], 14, ['case', ['==', ['get', 'big'], 1], 8, 6]],
      'circle-color': '#fff', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 1.4, 14, 2.6] } });
    map.addLayer({ id: 'st-l', type: 'symbol', source: 'stations', minzoom: 11.5, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11.5, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': '#3a3a40', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } });
    map.addSource('trains', { type: 'geojson', data: FC() });
    map.addLayer({ id: 'tr-halo', type: 'circle', source: 'trains', filter: ['==', ['get', 'sel'], 1], paint: { 'circle-radius': 19, 'circle-color': ['get', 'color'], 'circle-opacity': 0.22 } });
    map.addLayer({ id: 'tr-a', type: 'symbol', source: 'trains', filter: ['==', ['get', 'mv'], 1], layout: { 'icon-image': 'sepur-arrow', 'icon-rotate': ['get', 'b'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.55, 8, 0.75, 11, 1.1, 15, 1.5] }, paint: { 'icon-color': '#1d1d22', 'icon-opacity': ['case', ['==', ['get', 'dim'], 1], 0.25, 1] } });
    map.addLayer({ id: 'tr-c', type: 'circle', source: 'trains', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3, 8, 5, 11, 8.5, 15, 12], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#1d1d22', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 14, 2.5], 'circle-opacity': ['case', ['==', ['get', 'dim'], 1], 0.25, 1], 'circle-stroke-opacity': ['case', ['==', ['get', 'dim'], 1], 0.25, 1] } });
    map.addLayer({ id: 'tr-t', type: 'symbol', source: 'trains', minzoom: 10, layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 7.5, 15, 10], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': ['get', 'tc'], 'text-opacity': ['case', ['==', ['get', 'dim'], 1], 0.3, 1] } });
    map.addLayer({ id: 'tr-n', type: 'symbol', source: 'trains', minzoom: 13, filter: ['==', ['get', 'dim'], 0], layout: { 'text-field': ['get', 'nm'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-anchor': 'left', 'text-offset': [1.5, 0], 'text-max-width': 14, 'text-optional': true, 'text-padding': 4 }, paint: { 'text-color': '#1d1d22', 'text-halo-color': '#fff', 'text-halo-width': 1.8 } });
    map.addSource('me', { type: 'geojson', data: FC() });
    map.addLayer({ id: 'me', type: 'circle', source: 'me', paint: { 'circle-radius': 7, 'circle-color': '#2F7BF6', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
    const vsrc = Object.entries(map.getStyle().sources).find(([, s]) => s.type === 'vector')?.[0];
    if (vsrc) map.addLayer({ id: 'b3d', type: 'fill-extrusion', source: vsrc, 'source-layer': 'building', minzoom: 13, layout: { visibility: 'none' }, paint: { 'fill-extrusion-color': '#DCDCE2', 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.8 } }, 'net');
    for (const id of ['tr-c', 'st-c', 'lines']) {
      map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
    }
    map.on('click', (e) => {
      const bb = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
      const f = map.queryRenderedFeatures(bb, { layers: ['tr-c', 'st-c', 'lines'] });
      const tr = f.find((x) => x.layer.id === 'tr-c'), st = f.find((x) => x.layer.id === 'st-c'), ln = f.find((x) => x.layer.id === 'lines');
      if (S.tab === 'rute' && S.pick && st) { setPlace(S.pick, st.properties.id); return; }
      if (tr) showCard(tr.properties.id, tr.properties.date);
      else if (st) open('station', st.properties.id);
      else if (ln) open('line', ln.properties.line);
      else closeCard();
    });
    if (matchMedia('(hover: hover)').matches) {
      map.on('mousemove', 'tr-c', (e) => {
        const f = e.features[0]; if (!f) return;
        const trip = E.day(f.properties.date).byId.get(f.properties.id); if (!trip) return;
        const i = trainInfo(trip);
        hoverPop.setLngLat(f.geometry.coordinates).setHTML(`<b>${esc(i.name)}</b><span>${esc(i.num)} · ke ${esc(trip.head)}</span><span>${esc(speedNow(trip, clock().sec + (trip.date === clock().date ? 0 : 86400)).txt)} <i>(perkiraan)</i></span>`).addTo(map);
      });
      map.on('mouseleave', 'tr-c', () => hoverPop.remove());
    }
    map.on('dragstart', () => { if (S.follow) { S.follow = false; toast('Berhenti mengikuti kereta'); render(true); } });
    map.on('moveend', () => writeHash());
    applyLayers();
    if (S.detail) focusDetail(false);
    else if (S.tab === 'rute' && S.planRes?.length) drawJourney(S.planRes[0], false);
    tick();
    window.__map = map; window.__sepurDebug = { E, S, clock };
    requestAnimationFrame(frame);
    app.removeAttribute('data-loading');
  });
  setTimeout(() => app.removeAttribute('data-loading'), 12000); // never trap the user behind the loader
}

function applyLayers() {
  if (!map?.getLayer('lines')) return;
  const sysOn = Object.keys(SYS_LABEL).filter((k) => S.layers[k]);
  const f = ['in', ['get', 'sys'], ['literal', sysOn]];
  map.setFilter('lines', f); map.setFilter('lines-case', f);
  map.setFilter('st-c', f); map.setFilter('st-l', f);
  map.setLayoutProperty('st-c', 'visibility', S.layers.stations ? 'visible' : 'none');
  map.setLayoutProperty('st-l', 'visibility', S.layers.stations && S.layers.labels ? 'visible' : 'none');
  map.setLayoutProperty('net', 'visibility', S.layers.net ? 'visible' : 'none');
  map.setLayoutProperty('tr-t', 'visibility', S.layers.labels ? 'visible' : 'none');
  LS.set('layers', S.layers);
}

/* ---------- animation: positions recomputed every frame, adaptive frame rate ---------- */
let act = [], actT = 0, actKey = '', lastFrame = 0, frameCost = 6, fpsCap = 60, frames = 0;
const bearings = new Map();
function frame(now) {
  requestAnimationFrame(frame);
  if (!E || !map?.getSource('trains') || document.hidden) return;
  const z = map.getZoom();
  // fewer updates when zoomed far out (movement is sub-pixel) or when frames get expensive
  const target = Math.min(fpsCap, z < 7.5 ? 6 : z < 9.5 ? 24 : 60);
  if (now - lastFrame < 1000 / target - 2) return;
  lastFrame = now;
  const t0 = performance.now();
  const c = clock();
  const key = c.date + (E.kai ? 'k' : '');
  if (now - actT > 1000 || key !== actKey) { act = E.active(c); actT = now; actKey = key; }
  lastRunning = E.running(c, act);
  drawTrains(lastRunning);
  frameCost = frameCost * 0.9 + (performance.now() - t0) * 0.1;
  fpsCap = frameCost > 14 ? 15 : frameCost > 8 ? 30 : 60;
  frames++;
  window.__sepur = { frames, fpsCap, frameCost: +frameCost.toFixed(2), trains: lastRunning.length };
}
function drawTrains(run) {
  const sel = S.card?.id || (S.detail?.type === 'train' ? S.detail.id : null);
  const selLine = S.detail?.type === 'line' ? S.detail.id : null;
  const jTrips = S.detail?.type === 'journey' && S.planRes ? new Set(S.planRes[S.detail.id]?.legs.filter((l) => !l.walk).map((l) => l.trip.id)) : null;
  const b = map.getBounds(), pad = 0.08;
  const w = b.getWest() - pad, e = b.getEast() + pad, s = b.getSouth() - pad, n = b.getNorth() + pad;
  const feats = [];
  const z13 = map.getZoom() >= 12.8;
  let selRun = null;
  for (const r of run) {
    const l = lineOf(r.trip.line);
    if (!l || !S.layers[l.sys]) continue;
    const [x, y] = r.s.p;
    const isSel = r.trip.id === sel;
    if (isSel) selRun = r;
    if (!isSel && (x < w || x > e || y < s || y > n)) continue;
    const mv = r.s.kind === 'run' ? 1 : 0;
    let br = r.s.bearing;
    if (mv) bearings.set(r.trip.key, br); else br = bearings.get(r.trip.key) ?? 0;
    const dim = (S.filter !== 'all' && chipOf(l.sys) !== S.filter) || (selLine && r.trip.line !== selLine) || (jTrips && !jTrips.has(r.trip.id)) ? 1 : 0;
    feats.push({ type: 'Feature', properties: { id: r.trip.id, date: r.trip.date, color: l.color, tc: l.text || '#fff', label: l.short.length > 3 ? '' : l.short, nm: z13 ? trainInfo(r.trip).label : '', sel: isSel ? 1 : 0, dim, mv, b: br }, geometry: { type: 'Point', coordinates: r.s.p } });
  }
  feats.sort((a, b) => a.properties.sel - b.properties.sel || b.properties.dim - a.properties.dim);
  map.getSource('trains').setData(FC(feats));
  if (S.follow && selRun && !map.isMoving()) map.jumpTo({ center: selRun.s.p });
  if (S.card && selRun && selRun.trip.id === S.card.id) cardPop.setLngLat(selRun.s.p);
}

/* once a second: text that changes with time */
function tick() {
  if (!E) return;
  const c = clock();
  const t = $('#tick-now'); if (t) t.textContent = fmt(c.sec);
  const st = $('#train-status'); if (st && S.detail?.type === 'train') st.innerHTML = trainStatus(S.detail.id, S.detail.date);
  if (S.detail?.type === 'train') updateEta();
  if (S.card) { const el = $('#tlive'); if (el) el.innerHTML = cardHtml(S.card.id, S.card.date, true); }
  const sb = $('#simbar');
  if (S.at) {
    app.dataset.sim = '1'; sb.hidden = false; $('#sim-t').innerHTML = `${fmt(c.sec)} WIB<span class="dt"> · ${dateNice(c.date)}</span>`;
    sb.querySelectorAll('[data-speed]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.speed === (S.at.speed || 1))));
  } else { sb.hidden = true; delete app.dataset.sim; }
}

/* ---------- train card (tap/click a train on the map) ---------- */
let cardPop, hoverPop;
function popups() {
  cardPop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: 'none', offset: 18, className: 'tpop', focusAfterOpen: false });
  cardPop.on('close', () => { if (S.card) { S.card = null; } });
  hoverPop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, className: 'hpop' });
}
function prevStop(trip, s) {
  const from = s.kind === 'dwell' ? s.at - 1 : s.from;
  for (let k = from; k >= 0; k--) if (trip.flags[k] & 1) return k;
  return null;
}
function cardHtml(id, date, liveOnly = false) {
  const f = E.find(id, clock(), date); if (!f) return '<div id="tcard" class="tcard"><b>Kereta tidak ditemukan</b></div>';
  const { trip, t } = f; const l = lineOf(trip.line), i = trainInfo(trip), s = E.state(trip, t);
  const st = (k) => esc(stOf(trip.sids[k]).name);
  let now = '', nxt = '';
  if (!s || t < trip.start) now = t < trip.start ? `Belum berangkat · berangkat ${fmt(trip.start)} dari ${st(0)}` : `Sudah tiba di ${st(trip.sids.length - 1)} (${fmt(trip.end)})`;
  else if (s.kind === 'dwell') {
    now = s.next == null ? `Tiba di ${st(s.at)} · stasiun terakhir` : `Berhenti di <b>${st(s.at)}</b> · berangkat ${fmt(trip.dep[s.at])}`;
    if (s.next != null) { const k = E.nextStopIdx(trip, s.at + 1); nxt = `<div class="kv"><span>Berikutnya</span><b>${st(k)} · ${fmt(trip.arr[k])} <em>(${mins(trip.arr[k] - t)})</em></b></div>`; }
  } else {
    const p = prevStop(trip, s), k = s.nextStop;
    now = p != null ? `Antara <b>${st(p)}</b> dan <b>${st(k)}</b>` : `Menuju <b>${st(k)}</b>`;
    nxt = `<div class="kv"><span>Berikutnya</span><b>${st(k)} · ${fmt(trip.arr[k])} <em>(${mins(trip.arr[k] - t)})</em></b></div>`;
  }
  const pct = Math.round((s ? s.progress : t > trip.end ? 1 : 0) * 100);
  const sp = E.speedProfile(trip), vn = speedNow(trip, t);
  const vtxt = vn.v == null ? esc(vn.txt) : vn.v === 0 ? 'Berhenti' : `≈ ${vn.v}<small> km/j</small>`;
  const live = `<div class="nowl">${now}</div>${nxt}
    <div class="prog"><i style="width:${pct}%"></i></div>
    <div class="spd"><div><span>Kecepatan</span><b>${vtxt}</b></div><div><span>Rata-rata</span><b>${kmh(sp.avg, l)}<small> km/j</small></b></div><div><span>Puncak</span><b>≈ ${kmh(sp.vmax, l)}<small> km/j</small></b></div></div>
    <div class="tags">${trip.est ? '<span class="badge est">Jadwal perkiraan</span>' : '<span class="badge real">Jadwal resmi</span>'}${l.fak ? '<span class="badge est">Fakultatif</span>' : ''}<span class="badge">Posisi &amp; kecepatan perkiraan dari jadwal, bukan GPS</span></div>
    <div class="acts"><button type="button" class="btn small primary" data-open="train:${esc(trip.id)}:${trip.date}">Detail lengkap</button><button type="button" class="btn small" data-act="card-follow">${S.follow ? 'Mengikuti' : 'Ikuti di peta'}</button></div>`;
  if (liveOnly) return live;
  const fl = FLEET[fleetKey(l)];
  const media = fl ? `<img class="thumb" src="${esc(fl.img)}" alt="${esc(fl.caption)}" width="640" height="360" decoding="async">` : '';
  const credit = fl ? `<div class="fcred"><b>${esc(fl.model)}</b> · ilustrasi tipe armada yang umum dipakai · foto <a href="${esc(fl.source)}" target="_blank" rel="noopener">${esc(fl.author)}</a>, ${esc(fl.license)}</div>` : '';
  return `<div id="tcard" class="tcard" style="--c:${esc(l.color)}" role="dialog" aria-label="${esc(i.name)}">
    <div class="th">${lb(l)}<div class="tt2"><b>${esc(i.name)}</b><span>${esc(i.num)} · ${esc(i.type)}${i.cls ? ' · ' + esc(i.cls.replace(/ \(.*\)/, '')) : ''}</span></div><button type="button" class="x" data-act="card-close" aria-label="Tutup"><svg class="i"><use href="#i-x"/></svg></button></div>
    <div class="media">${media}<div class="dest"><span>Tujuan</span><b>${esc(trip.head)}</b><small>dari ${st(0)}</small><small>${fmt(trip.start)} → ${fmt(trip.end)}</small></div></div>${credit}
    <div id="tlive">${live}</div></div>`;
}
function showCard(id, date) {
  S.card = { id, date };
  const f = E.find(id, clock(), date); if (!f) return;
  const s = E.state(f.trip, f.t);
  const p = s ? s.p : E.pos(f.trip.sids[0]);
  const mob = innerWidth < 760;
  const short = map.getContainer().clientHeight < 520 && !mob;
  cardPop.options.anchor = short ? 'left' : 'bottom';
  cardPop.setLngLat(p).setHTML(cardHtml(id, date)).addTo(map);
  hoverPop.remove();
  if (mob) sheetTo('peek');
  // keep the whole card on screen: train sits just below the card, clear of the side controls and the sheet
  requestAnimationFrame(() => {
    const el = cardPop.getElement(); if (!el) return;
    const ch = el.offsetHeight, c = map.getContainer(), W = c.clientWidth, H = c.clientHeight;
    if (short) { map.easeTo({ center: p, offset: [Math.max(40, W / 2 - el.offsetWidth / 2 - 60) - W / 2, 0], duration: 450 }); return; }
    const q = map.project(p), top = (app.dataset.sim ? 64 : 12) + ch + 22;
    const bottom = mob ? H - 230 : H - 70;
    const half = Math.min(170, (W - 70) / 2);
    const okY = q.y >= top && q.y <= bottom, okX = q.x >= half + 8 && q.x <= W - half - 64;
    if (okY && okX && !mob) return;
    const tx = mob ? W / 2 - 28 : Math.min(Math.max(q.x, half + 8), W - half - 64);
    const ty = Math.min(Math.max(top, mob ? top : q.y), bottom);
    map.easeTo({ center: p, offset: [tx - W / 2, ty - H / 2], duration: 450 });
  });
}
function closeCard() { S.card = null; cardPop?.remove(); }

/* ---------- views ---------- */
function counts() {
  const c = { all: 0 };
  for (const r of lastRunning) { const l = lineOf(r.trip.line); if (!l) continue; const k = chipOf(l.sys); c[k] = (c[k] || 0) + 1; c.all++; }
  return c;
}
function homeView() {
  const c = clock(); lastRunning = E.running(c); const n = counts();
  let h = `<div class="now"><span class="k">${S.at ? 'Waktu simulasi' : 'Sekarang'} · <span id="tick-now">${fmt(c.sec)}</span> WIB · ${dayLabel(c.date)}</span><span class="v">${n.all} kereta<small>jalan menurut jadwal</small></span></div>`;
  h += `<div class="chips" role="group" aria-label="Saring jenis kereta">${CHIP_SYS.map(([k, t]) => `<button type="button" class="chip" data-filter="${k}" aria-pressed="${S.filter === k}">${t} <b>${n[k] || 0}</b></button>`).join('')}</div>`;
  h += `<button type="button" class="card cta" data-tab="rute"><span class="art"><svg class="i"><use href="#i-route"/></svg></span><span class="tx"><b>Rencanakan perjalanan</b><span>Pilih asal, tujuan, dan jam. Termasuk pindah KRL, MRT, LRT, Bandara, dan KA antarkota.</span></span><svg class="i chev"><use href="#i-chev"/></svg></button>`;
  if (!n.all) {
    const nx = E.nextService(c);
    h += `<div class="card"><div class="ch"><span class="art"><svg class="i"><use href="#i-train"/></svg></span><div><b>Zzz… kereta sudah pulang ke dipo</b><span>${nx ? `Kereta pertama ${esc(trainName(nx.trip))} berangkat ${fmt(nx.trip.start)} dari ${esc(stOf(nx.trip.sids[0]).name)}, ${mins(nx.wait)} lagi.` : 'Belum ada jadwal.'}</span></div></div></div>`;
  }
  h += favCard(c);
  if (S.recent.length) h += `<div class="sech"><h2>Terakhir dibuka</h2></div><div class="list">${S.recent.slice(0, 5).map((r) => recentRow(r)).join('')}</div>`;
  const runningNow = lastRunning.filter((r) => S.filter === 'all' || chipOf(lineOf(r.trip.line)?.sys) === S.filter)
    .map((r) => ({ r, nt: nextTime(r.trip, r.s) })).sort((a, b) => a.nt - b.nt).slice(0, 12).map((x) => x.r);
  if (runningNow.length) h += `<div class="sech"><h2>Sedang jalan</h2><span>${S.filter === 'all' ? 'semua jenis' : esc(CHIP_SYS.find((x) => x[0] === S.filter)[1])}</span></div><div class="list">${runningNow.map((r) => trainRow(r.trip, r.s)).join('')}</div>`;
  if (S.kaiState === 'loading') h += `<div class="note">Memuat jadwal KA antarkota (GAPEKA 2026)…</div>`;
  if (S.kaiState === 'fail') h += `<div class="note est">Jadwal KA antarkota belum bisa dimuat. KRL, MRT, LRT, dan Bandara tetap tampil.</div>`;
  return h;
}
function nextTime(t, s) { if (s.kind === 'dwell') return t.dep[s.at]; const k = s.nextStop ?? s.next; return t.arr[k]; }
function favCard(c) {
  if (S.fav && stOf(S.fav)) {
    const s = stOf(S.fav), deps = E.departures(s.id, c, 4);
    return `<div class="card white"><div class="sech"><h2>Stasiunku · ${esc(s.name)}</h2><button type="button" class="chip" data-open="station:${esc(s.id)}">Papan</button></div>
      ${deps.length ? `<div class="list board">${deps.map(depRow).join('')}</div>` : `<div class="empty">Tidak ada keberangkatan dalam 6 jam ke depan.</div>`}<span class="credit">Menurut jadwal · bukan posisi GPS</span></div>`;
  }
  return `<div class="card"><div class="ch"><span class="art"><svg class="i"><use href="#i-pin"/></svg></span><div><b>Pilih stasiunmu</b><span>Simpan stasiun tempat kamu biasa naik. Sepur Live tunjukkan kereta berikutnya ke tiap arah.</span></div></div>
    <button type="button" class="btn wide" data-act="locate"><svg class="i"><use href="#i-locate"/></svg>Stasiun di dekatku</button>
    <div class="pills">${QUICK.filter(stOf).map((id) => `<button type="button" class="pill" data-open="station:${id}">${esc(stOf(id).name)}</button>`).join('')}</div></div>`;
}
function recentRow(r) {
  if (r.type === 'station' && stOf(r.id)) { const s = stOf(r.id); return `<button type="button" class="row" data-open="station:${esc(s.id)}">${dots(s)}<span class="main"><b>${esc(s.name)}</b><span>Stasiun</span></span><svg class="i chev"><use href="#i-chev"/></svg></button>`; }
  if (r.type === 'line' && lineOf(r.id)) { const l = lineOf(r.id); return `<button type="button" class="row" data-open="line:${esc(l.id)}">${lb(l)}<span class="main"><b>${esc(l.name)}</b><span>Jalur</span></span><svg class="i chev"><use href="#i-chev"/></svg></button>`; }
  return '';
}
function trainRow(t, s) {
  const l = lineOf(t.line);
  const nx = s.kind === 'dwell' ? s.at : s.nextStop ?? s.next;
  const where = s.kind === 'dwell' ? `di ${stOf(t.sids[s.at]).name}` : `menuju ${stOf(t.sids[nx]).name}`;
  const tm = s.kind === 'dwell' ? t.dep[nx] : t.arr[nx];
  return `<button type="button" class="row" data-open="train:${esc(t.id)}:${t.date}">${lb(l)}<span class="main"><b>ke ${esc(t.head)}</b><span>${esc(trainInfo(t).short)} · ${esc(trainInfo(t).num)} · ${esc(where)}</span></span><span class="side"><b>${fmt(tm)}</b><span>${nx === t.sids.length - 1 ? 'tiba akhir' : s.kind === 'dwell' ? 'berangkat' : 'tiba'}</span></span></button>`;
}
function depRow(d) {
  const t = d.trip, l = lineOf(t.line);
  return `<button type="button" class="row" data-open="train:${esc(t.id)}:${t.date}">${lb(l)}<span class="main"><b>${esc(t.head)}</b><span>${esc(trainInfo(t).short)} · ${esc(trainInfo(t).num)}</span></span><span class="side"><b>${fmt(d.dep)}</b><span class="${d.wait < 300 ? 'soon' : ''}">${mins(d.wait)}</span></span></button>`;
}
const tag = (l) => (l.sched === 'frequency' ? '<span class="badge est">Perkiraan</span>' : l.freqDays ? '<span class="badge real">Jadwal hari kerja</span><span class="badge est">Akhir pekan perkiraan</span>' : '<span class="badge real">Jadwal resmi</span>');

function linesView() {
  const n = new Map();
  for (const r of lastRunning) n.set(r.trip.line, (n.get(r.trip.line) || 0) + 1);
  let h = '';
  for (const sys of NET.systems) {
    const ls = E.allLines().filter((l) => l.sys === sys.id && (!S.q || matches(l.name + ' ' + l.short, S.q)));
    if (!ls.length) continue;
    h += `<div class="sech"><h2>${esc(sys.name)}</h2><span>${esc(sys.src)}</span></div><div class="list">${ls.map((l) => {
      const run = n.get(l.id) || 0;
      return `<button type="button" class="row" data-open="line:${esc(l.id)}">${lb(l)}<span class="main"><b>${esc(l.name)}</b><span>${isKA(l) ? `${esc(stOf(l.stations[0]).name)} – ${esc(stOf(l.stations.at(-1)).name)}` : `${l.stations.length} stasiun`} · ${run} jalan${l.fak ? ' · fakultatif' : ''}</span></span><svg class="i chev"><use href="#i-chev"/></svg></button>`;
    }).join('')}</div>`;
  }
  if (S.kaiState === 'loading') h += `<div class="note">Memuat jalur KA antarkota…</div>`;
  return h || `<div class="empty"><b>Jalur tidak ditemukan</b>Coba nama lain, misalnya Bogor, MRT, Argo, atau Whoosh.</div>`;
}

function stationsView() {
  const list = NET.stations.filter((s) => !S.q || matches(s.name + ' ' + s.id, S.q)).sort((a, b) => a.name.localeCompare(b.name));
  const urban = (s) => s.sys.some((x) => x !== 'kai' && x !== 'regional');
  const groups = [['Jabodetabek & perkotaan', list.filter(urban)], ['Stasiun KA antarkota & daerah', list.filter((s) => !urban(s))]];
  let h = '';
  for (const [t, arr] of groups) {
    if (!arr.length) continue;
    h += `<div class="sech"><h2>${t}</h2><span>${arr.length}</span></div><div class="list">${arr.slice(0, 400).map((s) => `<button type="button" class="row" data-open="station:${esc(s.id)}">${dots(s)}<span class="main"><b>${esc(s.name)}</b><span>${esc(s.id)} · ${esc(sysName(s))}</span></span><svg class="i chev"><use href="#i-chev"/></svg></button>`).join('')}</div>`;
  }
  return h || `<div class="empty"><b>Stasiun tidak ditemukan</b>Coba cari namanya, misalnya Manggarai atau Gambir.</div>`;
}

function srcNote(l) { const k = srcOf(l); return `<div class="note${k === 'freq' ? ' est' : ''}">${SRC[k](l)} Posisi di peta dihitung dari jadwal di atas rel OpenStreetMap, bukan GPS. Keterlambatan tidak terlihat.</div>`; }

function datePicker(date) {
  const c = clock();
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(c.date, i));
  return `<div class="dpick"><div class="chips">${days.map((d, i) => `<button type="button" class="chip" data-ttdate="${d}" aria-pressed="${d === date}">${i === 0 ? 'Hari ini' : i === 1 ? 'Besok' : dateNice(d)}</button>`).join('')}</div>
    <div class="drow"><label class="dfield"><span>Tanggal</span><input type="date" data-ttdate-input value="${date}"></label><span class="badge ${dayType(date, NET.holidays) === 'weekend' ? 'est' : 'real'}">${dayLabel(date)}</span></div></div>`;
}

function lineDetail(id) {
  const l = lineOf(id); if (!l) return notFound(S.kaiState === 'loading' ? 'Memuat jalur…' : 'Jalur ini tidak ada di data');
  const c = clock(); const date = S.ttDate || c.date; const span = E.lineSpan(l.id, date);
  const run = lastRunning.filter((r) => r.trip.line === l.id);
  const sys = NET.systems.find((s) => s.id === l.sys);
  let h = `<div class="dhead">${lb(l)}<div class="t"><b>${esc(l.name)}</b><span>${esc(sys?.name || '')} · ${esc(sys?.operator || '')}</span></div></div>`;
  h += `<div class="facts"><div class="fact"><span>Jalan sekarang</span><b>${run.length}</b></div><div class="fact"><span>Perjalanan</span><b>${span ? span.count : '–'}</b></div><div class="fact"><span>Pertama–terakhir</span><b>${span ? fmt(span.first) + '–' + fmt(span.last) : '–'}</b></div></div>`;
  h += `<div class="acts"><button type="button" class="btn small" data-act="fit"><svg class="i"><use href="#i-pin"/></svg>Lihat di peta</button><button type="button" class="btn small" data-act="share"><svg class="i"><use href="#i-share"/></svg>Bagikan</button>${tag(l)}${l.fak ? '<span class="badge est">Fakultatif: tidak setiap hari</span>' : ''}</div>`;
  h += srcNote(l);
  if (run.length) h += `<div class="sech"><h2>Kereta di jalur ini</h2><span>${run.length}</span></div><div class="list">${run.slice(0, 12).map((r) => trainRow(r.trip, r.s)).join('')}</div>`;
  h += lineGridHtml(l, date);
  [l.stations, ...(l.branches || [])].forEach((p, i) => {
    h += `<div class="sech"><h2>${i ? 'Cabang' : 'Stasiun'}</h2><span>${esc(stOf(p[0]).name)} – ${esc(stOf(p[p.length - 1]).name)}</span></div><div class="stops" style="--c:${esc(l.color)}">${p.map((sid) => { const s = stOf(sid); const other = s.lines.filter((x) => x !== l.id); return `<button type="button" class="stop" data-open="station:${esc(sid)}"><span class="nm">${esc(s.name)}${other.length ? dots({ lines: other }) : ''}</span></button>`; }).join('')}</div>`;
  });
  return h;
}
function lineGridHtml(l, date) {
  const g = E.lineGrid(l.id, date, S.ttDir);
  const other = E.lineGrid(l.id, date, 1 - S.ttDir).trips.length;
  const a = stOf(l.stations[0]).name, b = stOf(l.stations.at(-1)).name;
  const c = clock();
  const hours = [...new Set(g.trips.map((t) => Math.floor(t.start / 3600)))].sort((x, y) => x - y);
  const many = g.trips.length > 24;
  let hour = S.ttHour;
  if (hour == null || !hours.includes(hour)) { const want = Math.floor((date === c.date ? c.sec : 5 * 3600) / 3600); hour = hours.find((x) => x >= want) ?? hours.at(-1); }
  const cols = g.trips.map((t, i) => [t, i]).filter(([t]) => !many || (t.start >= hour * 3600 && t.start < (hour + 2) * 3600));
  let h = `<div class="sech" id="tt"><h2>Tabel jadwal</h2><span>${g.trips.length + other} perjalanan · ${dayLabel(date)}</span></div>${datePicker(date)}`;
  h += `<div class="seg mini" role="tablist" aria-label="Arah"><button type="button" role="tab" data-ttdir="0" aria-selected="${S.ttDir === 0}">ke ${esc(b)}</button><button type="button" role="tab" data-ttdir="1" aria-selected="${S.ttDir === 1}">ke ${esc(a)}</button></div>`;
  if (many) h += `<div class="chips" aria-label="Jam berangkat">${hours.map((x) => `<button type="button" class="chip" data-tthour="${x}" aria-pressed="${x === hour}">${String(x % 24).padStart(2, '0')}.00${x >= 24 ? '+' : ''}</button>`).join('')}</div>`;
  if (!cols.length) return h + `<div class="empty">Tidak ada perjalanan ke arah ini pada tanggal ini.</div>`;
  h += `<div class="ttwrap"><table class="tt"><thead><tr><th class="st">Stasiun</th>${cols.map(([t]) => `<th><button type="button" data-open="train:${esc(t.id)}:${t.date}" title="${esc(trainName(t))}">${esc(t.est ? '~' : shortId(t.id))}</button></th>`).join('')}</tr></thead><tbody>`;
  for (const r of g.rows) {
    if (!cols.some(([, i]) => r.cells[i] !== undefined)) continue;
    h += `<tr><th class="st"><button type="button" data-open="station:${esc(r.sid)}">${esc(stOf(r.sid).name)}</button></th>${cols.map(([t, i]) => { const v = r.cells[i]; return `<td${t.est ? ' class="e"' : ''}>${v === undefined ? '' : v === -1 ? '<span class="pass">|</span>' : fmt(v)}</td>`; }).join('')}</tr>`;
  }
  h += `</tbody></table></div><span class="credit">${many ? 'Menampilkan keberangkatan 2 jam mulai jam terpilih. ' : ''}${g.trips.some((t) => t.est) ? '~ = perkiraan. ' : ''}${isKA(l) || l.id === 'ka-bst' ? '| = lewat tanpa berhenti. ' : ''}Waktu = berangkat. Nomor peron belum tersedia di data terbuka.</span>`;
  return h;
}

function stationDetail(id) {
  const s = stOf(id); if (!s) return notFound('Stasiun ini tidak ada di data');
  if (S.detail.full) return stationFull(s);
  const c = clock(); const deps = E.departures(id, c, 80, 12 * 3600);
  const ls = s.lines.map(lineOf).filter(Boolean);
  const filt = S.detail.line && ls.some((l) => l.id === S.detail.line) ? S.detail.line : null;
  const shown = deps.filter((d) => !filt || d.trip.line === filt).slice(0, 24);
  let h = `<div class="dhead"><span class="lb" style="background:${esc(ls[0]?.color || '#888')}"><svg class="i" style="fill:#fff"><use href="#i-train"/></svg></span><div class="t"><b>${esc(s.name)}</b><span>${esc(s.id)} · ${esc(sysName(s))}</span></div></div>`;
  h += `<div class="acts"><button type="button" class="btn small" data-act="fav"><svg class="i"><use href="#i-star"/></svg>${S.fav === id ? 'Stasiunku ✓' : 'Jadikan stasiunku'}</button><button type="button" class="btn small" data-act="plan-from"><svg class="i"><use href="#i-route"/></svg>Rute dari sini</button><button type="button" class="btn small" data-act="plan-to">Rute ke sini</button><button type="button" class="btn small" data-act="fit"><svg class="i"><use href="#i-pin"/></svg>Peta</button></div>`;
  h += `<div class="sech"><h2>Keberangkatan</h2><span>${fmt(c.sec)} WIB · ${dayLabel(c.date)}</span></div>`;
  if (ls.length > 1) h += lineChips(ls, filt);
  h += shown.length ? `<div class="list board">${shown.map(depRow).join('')}</div>` : `<div class="empty"><b>Tidak ada keberangkatan dalam 12 jam ke depan</b>Buka jadwal lengkap untuk tanggal lain.</div>`;
  h += `<button type="button" class="btn wide" data-act="full"><svg class="i"><use href="#i-clock"/></svg>Jadwal lengkap sehari</button>`;
  const xf = (s.xfer || []).map(stOf).filter(Boolean);
  if (xf.length) h += `<div class="sech"><h2>Pindah ke</h2></div><div class="pills">${xf.map((x) => `<button type="button" class="pill" data-open="station:${esc(x.id)}">${esc(x.name)} · ${esc(sysName(x))}</button>`).join('')}</div>`;
  h += `<div class="sech"><h2>Jalur</h2><span>${ls.length}</span></div><div class="list">${ls.slice(0, 40).map((l) => `<button type="button" class="row" data-open="line:${esc(l.id)}">${lb(l)}<span class="main"><b>${esc(l.name)}</b><span>${l.sched === 'frequency' ? 'Perkiraan frekuensi' : l.freqDays ? 'Jadwal · akhir pekan perkiraan' : 'Jadwal resmi'}</span></span><svg class="i chev"><use href="#i-chev"/></svg></button>`).join('')}</div>`;
  if (s.lines.some((x) => !lineOf(x)) && S.kaiState === 'loading') h += `<div class="note">Memuat jadwal KA antarkota untuk stasiun ini…</div>`;
  h += `<div class="note">${[...new Set(ls.map(srcOf))].map((k) => SRC[k](ls.find((l) => srcOf(l) === k))).join(' ')} Nomor peron tidak tersedia di data terbuka.</div>`;
  return h;
}
const lineChips = (ls, filt) => `<div class="chips">${[['', 'Semua'], ...ls.map((l) => [l.id, l.short.length > 4 ? l.name : l.short])].map(([k, t]) => `<button type="button" class="chip" data-sline="${esc(k)}" aria-pressed="${(filt || '') === k}">${esc(t)}</button>`).join('')}</div>`;
function stationFull(s) {
  const c = clock(); const date = S.ttDate || c.date;
  const day = E.stationDay(s.id, date);
  const ls = s.lines.map(lineOf).filter(Boolean);
  const filt = S.detail.line && ls.some((l) => l.id === S.detail.line) ? S.detail.line : null;
  let h = `<div class="dhead"><span class="lb" style="background:${esc(ls[0]?.color || '#888')}"><svg class="i" style="fill:#fff"><use href="#i-clock"/></svg></span><div class="t"><b>${esc(s.name)}</b><span>Jadwal lengkap · ${day.rows.length} kereta berhenti</span></div></div>`;
  h += `<div class="acts"><button type="button" class="btn small" data-act="full-off">Papan keberangkatan</button></div>`;
  h += datePicker(date);
  if (ls.length > 1) h += lineChips(ls, filt);
  const nowSec = date === c.date ? c.sec : -1;
  let any = false;
  for (const [head, rows] of day.groups) {
    const rs = rows.filter((r) => !filt || r.trip.line === filt);
    if (!rs.length) continue; any = true;
    const byLine = [...new Set(rs.map((r) => r.trip.line))].map(lineOf);
    h += `<div class="sech"><h2>${head.startsWith('Tiba') ? esc(head) : 'ke ' + esc(head)}</h2><span>${rs.length} · ${byLine.map((l) => esc(l.short)).slice(0, 4).join(' ')}</span></div>`;
    h += `<div class="times">${rs.map((r) => { const l = lineOf(r.trip.line); const tm = r.terminates ? r.arr : r.dep; const past = nowSec >= 0 && tm < nowSec; return `<button type="button" class="tbtn${past ? ' past' : ''}${r.trip.est ? ' e' : ''}" data-open="train:${esc(r.trip.id)}:${r.trip.date}" style="--c:${esc(l.color)}" title="${esc(trainName(r.trip))}"><b>${fmt(tm)}</b><span>${esc(r.trip.est ? '~' : shortId(r.trip.id))}</span></button>`; }).join('')}</div>`;
  }
  if (!any) h += `<div class="empty"><b>Tidak ada kereta berhenti</b>Coba tanggal atau jalur lain.</div>`;
  h += `<span class="credit">Waktu berangkat (stasiun akhir: waktu tiba). Di bawah waktu: nomor kereta. ~ = perkiraan. Nomor peron belum tersedia di data terbuka.</span>`;
  return h;
}

function trainStatus(id, date) {
  const f = E.find(id, clock(), date); if (!f) return '';
  const { trip, t } = f; const s = E.state(trip, t);
  if (!s) return t < trip.start ? `Berangkat ${fmt(trip.start)} dari ${esc(stOf(trip.sids[0]).name)}, ${mins(trip.start - t)} lagi` : `Perjalanan menurut jadwal sudah selesai (${fmt(trip.end)})`;
  if (t < trip.start) return `Siap berangkat dari ${esc(stOf(trip.sids[0]).name)} ${fmt(trip.start)}`;
  if (s.kind === 'dwell') return s.next == null ? `Tiba di ${esc(stOf(trip.sids[s.at]).name)}, stasiun terakhir` : `Berhenti di ${esc(stOf(trip.sids[s.at]).name)}, berangkat ${fmt(trip.dep[s.at])}`;
  const k = s.nextStop;
  return `Menuju ${esc(stOf(trip.sids[k]).name)}, prediksi tiba ${fmt(trip.arr[k])} (${mins(trip.arr[k] - t)})`;
}
function legMax(trip, i, l) {
  const sp = E.speedProfile(trip); let k = i - 1, v = 0;
  while (k >= 0) { v = Math.max(v, sp.legs[k].vmax); if (trip.flags[k] & 1) break; k--; }
  return kmh(v, l);
}
function speedSection(trip, t, l) {
  const sp = E.speedProfile(trip), vn = speedNow(trip, t);
  const cap = VMAX[l.sys] || 350, top = Math.min(sp.vmax * 3.6, cap);
  const ymax = Math.max(40, Math.ceil((top * 1.1) / 20) * 20);
  const W = 320, H = 120, L = 30, B = 18, T0 = sp.pts[0][0], T1 = sp.pts.at(-1)[0] || T0 + 1;
  const X = (tt) => L + ((tt - T0) / (T1 - T0)) * (W - L - 4), Y = (v) => 4 + (H - B - 4) * (1 - Math.min(v * 3.6, cap) / ymax);
  const line = sp.pts.map(([tt, v]) => `${X(tt).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const grid = [0, ymax / 2, ymax].map((g) => `<line x1="${L}" x2="${W - 4}" y1="${Y(g / 3.6)}" y2="${Y(g / 3.6)}" class="g"/><text x="${L - 4}" y="${Y(g / 3.6) + 3}" text-anchor="end">${g}</text>`).join('');
  const V = E.vtimes(trip);
  const ticks = trip.sids.map((_, i) => (trip.flags[i] & 1 && i > 0 && i < trip.sids.length - 1 ? `<line x1="${X(V.arr[i]).toFixed(1)}" x2="${X(V.arr[i]).toFixed(1)}" y1="${H - B}" y2="${H - B + 4}" class="tk"/>` : '')).join('');
  const mid = T0 + (T1 - T0) / 2;
  const xl = [[T0, 'start'], [mid, 'middle'], [T1, 'end']].map(([tt, a]) => `<text x="${X(tt)}" y="${H - 3}" text-anchor="${a}">${fmt(Math.round(tt))}</text>`).join('');
  const cx = t >= T0 && t <= T1 ? X(t).toFixed(1) : -10;
  let h = `<div class="sech"><h2>Kecepatan</h2><span>perkiraan dari jadwal, bukan GPS</span></div>`;
  h += `<div class="facts f3 spdf"><div class="fact"><span>Sekarang</span><b id="spd-now">${esc(vn.txt)}</b></div><div class="fact"><span>Rata-rata (dengan berhenti)</span><b>${kmh(sp.avg, l)} km/j</b></div><div class="fact"><span>Rata-rata saat jalan</span><b>${kmh(sp.runAvg, l)} km/j</b></div><div class="fact"><span>Puncak perkiraan</span><b>≈ ${kmh(sp.vmax, l)} km/j</b></div><div class="fact"><span>Jarak di rel</span><b>${(sp.D / 1000).toFixed(sp.D < 1e4 ? 1 : 0)} km</b></div><div class="fact"><span>Waktu tempuh</span><b>${dur(sp.T)}</b></div></div>`;
  h += `<figure class="spchart" style="--c:${esc(l.color)}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafik perkiraan kecepatan ${esc(trainInfo(trip).name)} sepanjang perjalanan">${grid}<polygon points="${X(T0)},${Y(0)} ${line} ${X(T1)},${Y(0)}" class="ar"/><polyline points="${line}" class="ln"/>${ticks}${xl}<line id="spd-cur" x1="${cx}" x2="${cx}" y1="4" y2="${H - B}" class="cur"/></svg>
  <figcaption>km/j menurut waktu · garis kecil = stasiun berhenti · garis putus = sekarang. Dihitung dari jarak rel OpenStreetMap dan waktu jadwal dengan profil percepatan/pengereman khas ${esc(SYS_LABEL[l.sys] || 'kereta')}; jadwal dibulatkan per menit, jadi angka per segmen bisa meleset.</figcaption></figure>`;
  return h;
}
function trainDetail(id) {
  const f = E.find(id, clock(), S.detail.date); if (!f) return notFound(S.kaiState === 'loading' ? 'Memuat jadwal…' : 'Kereta ini tidak ada di jadwal');
  const { trip, t } = f; const l = lineOf(trip.line); const s = E.state(trip, t);
  const hasPass = trip.flags.some((x) => !(x & 1));
  const info = trainInfo(trip);
  let h = `<div class="dhead">${lb(l)}<div class="t"><b>${esc(info.name)}</b><span>${esc(info.num)} · ${esc(info.type)}</span></div></div>`;
  h += fleetFig(l, 'big');
  h += `<div class="facts f2"><div class="fact wide"><span>Tujuan</span><b>${esc(trip.head)}</b></div><div class="fact"><span>Dari</span><b>${esc(stOf(trip.sids[0]).name)}</b></div><div class="fact"><span>Berangkat → tiba</span><b>${fmt(trip.start)} → ${fmt(trip.end)}</b></div>${info.cls ? `<div class="fact"><span>Kelas</span><b>${esc(info.cls)}</b></div>` : ''}<div class="fact"><span>Berhenti</span><b>${trip.flags.filter((x) => x & 1).length} stasiun</b></div></div>`;
  h += `<div class="card white"><b id="train-status">${trainStatus(id, S.detail.date)}</b><div class="prog" style="--c:${esc(l.color)}"><i id="train-prog" style="width:${Math.round((s ? s.progress : t > trip.end ? 1 : 0) * 100)}%"></i></div><span class="credit">${trip.est ? '<span class="badge est">Perkiraan</span>' : '<span class="badge real">Jadwal resmi</span>'} ${dateNice(trip.date)} · ${dayLabel(trip.date)} · ${fmt(trip.start)}–${fmt(trip.end)} (${dur(trip.end - trip.start)})</span></div>`;
  h += `<div class="acts"><button type="button" class="btn small${S.follow ? ' primary' : ''}" data-act="follow"><svg class="i"><use href="#i-follow"/></svg>${S.follow ? 'Mengikuti' : 'Ikuti di peta'}</button><button type="button" class="btn small" data-act="sim-train"><svg class="i"><use href="#i-play"/></svg>Putar cepat</button><button type="button" class="btn small" data-act="share"><svg class="i"><use href="#i-share"/></svg>Bagikan</button></div>`;
  h += speedSection(trip, t, l);
  h += srcNote(l);
  const stops = trip.sids.map((sid, i) => ({ sid, i })).filter(({ i }) => S.showPass || trip.flags[i] & 1);
  h += `<div class="sech"><h2>Jadwal &amp; prediksi tiba</h2><span>${trip.flags.filter((x) => x & 1).length} berhenti${hasPass ? ` · ${trip.flags.filter((x) => !(x & 1)).length} dilewati` : ''}</span></div>`;
  if (hasPass) h += `<label class="tog"><input type="checkbox" data-act="pass" ${S.showPass ? 'checked' : ''}> Tampilkan stasiun yang dilewati</label>`;
  h += `<div class="stops" id="train-stops" style="--c:${esc(l.color)}">${stops.map(({ sid, i }) => {
    const stop = trip.flags[i] & 1, est = trip.flags[i] & 2;
    const a = trip.arr[i], d = trip.dep[i], first = i === 0, last = i === trip.sids.length - 1;
    const tm = !stop ? `<span class="tm pass">${est ? '~' : ''}${fmt(d)}</span>` : first ? `<span class="tm">${fmt(d)}<small>berangkat</small></span>` : last ? `<span class="tm">${est ? '~' : ''}${fmt(a)}<small>tiba</small></span>` : `<span class="tm">${fmt(a)}${d - a >= 60 ? `<small>berangkat ${fmt(d)}</small>` : ''}</span>`;
    const vl = i > 0 && stop ? legMax(trip, i, l) : '';
    return `<button type="button" class="stop${stop ? '' : ' passing'}" data-i="${i}" data-open="station:${esc(sid)}"><span class="nm">${esc(stOf(sid).name)}<small class="eta"></small>${vl ? `<small class="vleg">maks. ≈ ${vl} km/j dari stasiun sebelumnya</small>` : ''}</span>${tm}</button>`;
  }).join('')}</div>`;
  h += `<span class="credit">Prediksi tiba dihitung dari jadwal, bukan dari posisi GPS kereta. ${hasPass ? 'Waktu bertanda ~ ditaksir dari jarak. ' : ''}Nomor peron belum tersedia di data terbuka.</span>`;
  return h;
}
function updateEta() {
  const box = $('#train-stops'); if (!box) return;
  const f = E.find(S.detail.id, clock(), S.detail.date); if (!f) return;
  const { trip, t } = f; const s = E.state(trip, t);
  const cur = s && t >= trip.start ? (s.kind === 'dwell' ? s.at : s.next) : t < trip.start ? 0 : trip.sids.length;
  const sn = $('#spd-now'); if (sn) sn.textContent = speedNow(trip, t).txt;
  const sc = $('#spd-cur'); if (sc) { const sp = E.speedProfile(trip), T0 = sp.pts[0][0], T1 = sp.pts.at(-1)[0] || T0 + 1; const x = t >= T0 && t <= T1 ? (30 + ((t - T0) / (T1 - T0)) * 286).toFixed(1) : -10; sc.setAttribute('x1', x); sc.setAttribute('x2', x); }
  const pg = $('#train-prog'); if (pg) pg.style.width = Math.round((s ? s.progress : t > trip.end ? 1 : 0) * 100) + '%';
  for (const el of box.children) {
    const i = +el.dataset.i;
    el.classList.toggle('past', i < cur);
    el.classList.toggle('cur', !!s && t >= trip.start && i === cur);
    const tm = i === 0 ? trip.dep[0] : trip.arr[i];
    const eta = el.querySelector('.eta');
    eta.textContent = i >= cur && tm >= t ? (i === 0 ? `berangkat dalam ${mins(tm - t)}` : trip.flags[i] & 1 ? `tiba dalam ${mins(tm - t)}` : `lewat dalam ${mins(tm - t)}`) : '';
  }
}

/* ---------- journey planner (CSA in sched.js) ---------- */
function setPlace(which, sid) {
  S.plan[which] = sid; S.pick = null; S.pickQ = ''; LS.set('plan', { from: S.plan.from, to: S.plan.to });
  if (S.plan.from && S.plan.to) runPlan(true); else { if (!S.plan.from) S.pick = 'from'; else if (!S.plan.to) S.pick = 'to'; render(true); }
}
function planTime() { const c = clock(); return { date: S.plan.date || c.date, sec: S.plan.time != null ? S.plan.time : Math.floor(c.sec) }; }
function runPlan(fly) {
  const { from, to } = S.plan; if (!from || !to || !E) return;
  const { date, sec } = planTime();
  const t0 = performance.now();
  S.planRes = from === to ? [] : E.plan(from, to, date, sec, 5);
  S.planMs = Math.round(performance.now() - t0);
  S.planAt = { date, sec };
  if (S.detail?.type === 'journey') S.detail = null;
  render(true); writeHash(false);
  if (S.planRes.length) drawJourney(S.planRes[0], fly);
  else map?.getSource('route')?.setData(FC());
}
function legStops(l) { const out = []; for (let k = l.i; k <= l.j; k++) if (l.trip.flags[k] & 1) out.push(k); return out; }
const plus1 = (t, base) => (Math.floor(t / 86400) > Math.floor(base / 86400) ? ' <small>+1</small>' : t < 0 ? ' <small>−1</small>' : '');
function planView() {
  const P = S.plan, { date, sec } = planTime();
  const field = (k, label) => {
    const s = P[k] && stOf(P[k]);
    return `<div class="pfield${S.pick === k ? ' on' : ''}"><span class="pl">${label}</span>${S.pick === k ? `<input id="pick-q" type="search" placeholder="Ketik nama stasiun atau ketuk peta" value="${esc(S.pickQ)}" autocomplete="off" spellcheck="false" enterkeyhint="search" aria-label="${label}">` : `<button type="button" class="pv" data-pick="${k}">${s ? `${dots(s)}<span>${esc(s.name)}</span>` : '<span class="ph">Pilih stasiun</span>'}</button>`}</div>`;
  };
  let h = `<div class="planner"><div class="pfields">${field('from', 'Dari')}${field('to', 'Ke')}<button type="button" class="round swap" data-act="swap" aria-label="Tukar asal dan tujuan"><svg class="i"><use href="#i-swap"/></svg></button></div>`;
  if (S.pick) {
    const q = nrm(S.pickQ);
    const list = (q ? NET.stations.filter((s) => nrm(s.name).includes(q) || s.id.toLowerCase() === q).sort((a, b) => nrm(a.name).indexOf(q) - nrm(b.name).indexOf(q) || a.name.length - b.name.length) : QUICK.map(stOf).filter(Boolean)).slice(0, 8);
    h += `<div class="list" id="pick-list">${list.map((s) => `<button type="button" class="row" data-setplace="${esc(s.id)}">${dots(s)}<span class="main"><b>${esc(s.name)}</b><span>${esc(s.id)} · ${esc(sysName(s))}</span></span></button>`).join('') || '<div class="empty">Stasiun tidak ditemukan</div>'}</div>`;
    if (P.from && P.to) h += `<button type="button" class="btn small" data-act="pick-cancel">Batal</button>`;
    return h + '</div>';
  }
  h += `<div class="pwhen"><button type="button" class="chip" data-act="when-now" aria-pressed="${P.time == null}">Berangkat sekarang</button><label class="dfield"><span>Tanggal</span><input type="date" data-plan="date" value="${date}"></label><label class="dfield"><span>Jam</span><input type="time" data-plan="time" value="${fmt(sec).replace('.', ':')}"></label></div></div>`;
  if (!P.from || !P.to) return h + `<div class="note">Pilih stasiun asal dan tujuan, atau ketuk stasiun di peta setelah memilih kolom. Sepur Live mencari kereta yang paling cepat sampai menurut jadwal, termasuk pindah antara KRL, MRT, LRT, KA Bandara, Skytrain, Whoosh, dan KA antarkota.</div>`;
  if (!S.planRes) return h;
  if (!S.planRes.length) return h + `<div class="empty"><b>Belum ada perjalanan yang cocok</b>Tidak ada rangkaian kereta dalam 36 jam setelah waktu ini${S.kaiState !== 'ok' ? ' (jadwal antarkota masih dimuat)' : ''}. Coba waktu lain.</div>`;
  h += `<div class="sech"><h2>Pilihan perjalanan</h2><span>${dateNice(S.planAt.date)} · mulai ${fmt(S.planAt.sec)}</span></div><div class="list" id="plan-res">`;
  h += S.planRes.map((j, k) => `<button type="button" class="row jrow" data-journey="${k}"><span class="main"><b>${fmt(j.dep)}${plus1(j.dep, 0)} → ${fmt(j.arr)}${plus1(j.arr, Math.max(0, j.dep))}</b><span class="jl">${j.legs.filter((l) => !l.walk).map((l) => lb(lineOf(l.trip.line))).join('<i class="ar">›</i>')}<em>${esc(stOf(j.legs.find((l) => !l.walk).from).name)}</em></span></span><span class="side"><b>${dur(j.arr - j.dep)}</b><span>${j.transfers ? j.transfers + '× pindah' : 'langsung'}</span></span></button>`).join('');
  h += `</div><span class="credit">Prediksi menurut jadwal${S.planRes.some((j) => j.legs.some((l) => l.trip?.est)) ? ', sebagian memakai perkiraan frekuensi' : ''}. Pindah kereta minimal 3 menit; jalan kaki antarstasiun dihitung dari jarak. Dihitung di perangkatmu dalam ${S.planMs} ms.</span>`;
  return h;
}
function journeyDetail(k) {
  const j = S.planRes?.[k]; if (!j) return notFound('Perjalanan tidak ditemukan');
  const A = stOf(S.plan.from), B = stOf(S.plan.to);
  let h = `<div class="dhead"><span class="lb" style="background:#171717"><svg class="i" style="fill:#fff"><use href="#i-route"/></svg></span><div class="t"><b>${esc(A.name)} → ${esc(B.name)}</b><span>${dateNice(j.date)} · ${fmt(j.dep)}–${fmt(j.arr)} · ${dur(j.arr - j.dep)} · ${j.transfers ? j.transfers + '× pindah' : 'langsung'}</span></div></div>`;
  h += `<div class="acts"><button type="button" class="btn small" data-act="j-fit"><svg class="i"><use href="#i-pin"/></svg>Lihat rute</button><button type="button" class="btn small primary" data-act="j-sim"><svg class="i"><use href="#i-play"/></svg>Simulasikan</button><button type="button" class="btn small" data-act="share"><svg class="i"><use href="#i-share"/></svg>Bagikan</button></div>`;
  h += `<div class="legs">`;
  j.legs.forEach((l, n) => {
    const prev = j.legs[n - 1];
    if (l.walk) { h += `<div class="walk"><svg class="i"><use href="#i-walk"/></svg>Jalan kaki ke ${esc(stOf(l.to).name)} · sekitar ${mins(l.dur)}</div>`; return; }
    if (prev) { const wait = l.dep - prev.arr; if (!prev.walk) h += `<div class="walk"><svg class="i"><use href="#i-clock"/></svg>Pindah di ${esc(stOf(l.from).name)} · tunggu ${mins(wait)}</div>`; else if (wait > 60) h += `<div class="walk"><svg class="i"><use href="#i-clock"/></svg>Tunggu ${mins(wait)} di ${esc(stOf(l.from).name)}</div>`; }
    const line = lineOf(l.trip.line), st = legStops(l);
    h += `<div class="leg" style="--c:${esc(line.color)}"><div class="lh">${lb(line)}<div><b>${esc(trainName(l.trip))}</b><span>arah ${esc(l.trip.head)} · ${st.length - 1} stasiun · ${dur(l.arr - l.dep)}${l.trip.est ? ' · <span class="badge est">Perkiraan</span>' : ''}</span></div><button type="button" class="chip" data-open="train:${esc(l.trip.id)}:${l.trip.date}">Kereta</button></div>
      <div class="stops">${st.map((i, q) => { const a = l.trip.arr[i] + l.off, d = l.trip.dep[i] + l.off; const end = q === 0 || q === st.length - 1; return `<button type="button" class="stop${end ? ' end' : ' mid'}" data-open="station:${esc(l.trip.sids[i])}"><span class="nm">${esc(stOf(l.trip.sids[i]).name)}${q === 0 ? '<small>Naik</small>' : q === st.length - 1 ? '<small>Turun</small>' : ''}</span><span class="tm">${fmt(q === 0 ? d : a)}</span></button>`; }).join('')}</div></div>`;
  });
  h += `</div><div class="note">Ini prediksi menurut jadwal${j.legs.some((l) => l.trip?.est) ? ' (bagian bertanda Perkiraan memakai pola frekuensi)' : ''}. Keterlambatan dan pembatalan tidak terlihat. Nomor peron belum tersedia di data terbuka. Cek tiket dan info resmi operator sebelum berangkat.</div>`;
  return h;
}
function journeyFeatures(j) {
  const f = [];
  for (const l of j.legs) {
    if (l.walk) { f.push({ type: 'Feature', properties: { color: '#555', walk: 1 }, geometry: { type: 'LineString', coordinates: [E.pos(l.from), E.pos(l.to)] } }); continue; }
    const c = []; for (let k = l.i; k < l.j; k++) c.push(...E.seg(l.trip.sids[k], l.trip.sids[k + 1]).coords);
    f.push({ type: 'Feature', properties: { color: lineOf(l.trip.line).color, walk: 0 }, geometry: { type: 'LineString', coordinates: c } });
  }
  return f;
}
function drawJourney(j, fit) {
  if (!map?.getSource('route') || !j) return;
  const f = journeyFeatures(j); map.getSource('route').setData(FC(f));
  if (fit) { const cs = f.flatMap((x) => x.geometry.coordinates); const b = cs.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(cs[0], cs[0])); map.fitBounds(b, { padding: padding(), duration: 900, maxZoom: 14 }); }
}
function simulateJourney(j) {
  setClock(j.date, j.dep - 90, 60);
  S.follow = true; S.simJ = j;
  drawJourney(j, false);
  const first = j.legs.find((l) => !l.walk);
  map.flyTo({ center: E.pos(first.from), zoom: Math.max(map.getZoom(), 13), padding: padding(), duration: 900 });
  toast('Simulasi 60× lebih cepat · peta ikut kereta');
  writeHash(false); tick();
}
// during a journey simulation, follow whichever leg is running
setInterval(() => {
  if (!S.simJ || !S.at || !E || !map) return;
  const c = clock(), j = S.simJ;
  const days = Math.round((Date.parse(c.date) - Date.parse(j.date)) / 864e5);
  const tAbs = days * 86400 + c.sec;
  const leg = j.legs.filter((l) => !l.walk).find((l) => tAbs <= l.arr);
  if (!leg) { S.simJ = null; S.follow = false; setClock(c.date, c.sec, 1); toast('Simulasi selesai: kamu tiba di tujuan'); tick(); return; }
  if (S.follow && !map.isMoving()) { const p = E.state(leg.trip, tAbs - leg.off); map.easeTo({ center: p && tAbs >= leg.dep ? p.p : E.pos(leg.from), duration: 240, easing: (x) => x }); }
}, 250);

function nearView() {
  const p = S.detail.p; if (!p) return notFound('Lokasi belum ketemu');
  const near = NET.stations.map((s) => ({ s, d: dist(p, [s.lng, s.lat]) })).sort((a, b) => a.d - b.d).slice(0, 10);
  let h = `<div class="dhead"><span class="lb" style="background:#2F7BF6"><svg class="i" style="fill:#fff"><use href="#i-pin"/></svg></span><div class="t"><b>${esc(S.detail.label || 'Di dekatmu')}</b><span>Stasiun terdekat</span></div></div>`;
  if (near[0].d > 15000) h += `<div class="note">Stasiun terdekat lebih dari 15 km dari sini.</div>`;
  h += `<div class="list">${near.map(({ s, d }) => { const nx = E.departures(s.id, clock(), 1)[0]; return `<button type="button" class="row" data-open="station:${esc(s.id)}">${dots(s)}<span class="main"><b>${esc(s.name)}</b><span>${d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km'} · ${esc(sysName(s))}</span></span><span class="side">${nx ? `<b>${fmt(nx.dep)}</b><span>${esc(nx.trip.head)}</span>` : ''}</span></button>`; }).join('')}</div>`;
  return h;
}
function dist(a, b) { const R = 6371000, r = Math.PI / 180; const h = Math.sin((b[1] - a[1]) * r / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin((b[0] - a[0]) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
function notFound(t) { return `<div class="empty"><span class="art"><svg class="i"><use href="#i-warn"/></svg></span><b>${esc(t)}</b>Coba cari lagi di kolom pencarian.</div>`; }

/* ---------- search ---------- */
const nrm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const matches = (hay, q) => nrm(hay).includes(nrm(q));
function searchView() {
  const q = S.q.trim(); const nq = nrm(q);
  const st = NET.stations.filter((s) => nrm(s.name).includes(nq) || s.id.toLowerCase() === nq).sort((a, b) => nrm(a.name).indexOf(nq) - nrm(b.name).indexOf(nq) || a.name.length - b.name.length).slice(0, 8);
  const ls = E.allLines().filter((l) => matches(l.name + ' ' + l.short + ' ' + (SYS_LABEL[l.sys] || ''), q)).slice(0, 8);
  const d = E.day(clock().date);
  const qn = nq.replace(/^(ka|mrt|lrt|lrtj|jbdb|sky) /, '').replace(/ /g, '');
  const tr = /\d/.test(q) ? d.trips.filter((t) => !t.est && nrm(shortId(t.id)).replace(/ /g, '') === qn).concat(d.trips.filter((t) => !t.est && qn.length >= 2 && nrm(shortId(t.id)).replace(/ /g, '').startsWith(qn) && nrm(shortId(t.id)).replace(/ /g, '') !== qn)).slice(0, 8) : [];
  const byName = nq.length >= 3 ? d.trips.filter((t) => !t.est && ls.some((l) => l.id === t.line) && isKA(lineOf(t.line))) : [];
  if (!tr.length && byName.length) { const c = clock(); tr.push(...byName.filter((t) => t.end >= c.sec).concat(byName.filter((t) => t.end < c.sec)).slice(0, 10)); }
  let h = '';
  if (st.length) h += `<div class="sech"><h2>Stasiun</h2></div><div class="list">${st.map((s) => `<button type="button" class="row" data-open="station:${esc(s.id)}">${dots(s)}<span class="main"><b>${esc(s.name)}</b><span>${esc(s.id)} · ${esc(sysName(s))}</span></span></button>`).join('')}</div>`;
  if (ls.length) h += `<div class="sech"><h2>Jalur &amp; kereta</h2></div><div class="list">${ls.map((l) => `<button type="button" class="row" data-open="line:${esc(l.id)}">${lb(l)}<span class="main"><b>${esc(l.name)}</b><span>${esc(SYS_LABEL[l.sys])}${isKA(l) ? ` · ${esc(stOf(l.stations[0]).name)} – ${esc(stOf(l.stations.at(-1)).name)}` : ''}</span></span></button>`).join('')}</div>`;
  if (tr.length) h += `<div class="sech"><h2>Perjalanan hari ini</h2></div><div class="list">${tr.map((t) => `<button type="button" class="row" data-open="train:${esc(t.id)}:${t.date}">${lb(lineOf(t.line))}<span class="main"><b>${esc(trainInfo(t).name)} · ${esc(trainInfo(t).num)}</b><span>ke ${esc(t.head)} · ${esc(stOf(t.sids[0]).name)} ${fmt(t.start)} → ${fmt(t.end)}</span></span></button>`).join('')}</div>`;
  if (S.placeQ === q && S.places.length) h += `<div class="sech"><h2>Tempat</h2><span>© OpenStreetMap · Photon</span></div><div class="list">${S.places.map((p, i) => `<button type="button" class="row" data-place="${i}"><span class="lb" style="background:#2F7BF6"><svg class="i" style="fill:#fff;width:16px;height:16px"><use href="#i-pin"/></svg></span><span class="main"><b>${esc(p.name)}</b><span>${esc(p.sub)}</span></span></button>`).join('')}</div>`;
  if (!h) h = q.length > 2 && S.placeQ !== q ? `<div class="empty">Mencari…</div>` : `<div class="empty"><b>Tidak ketemu</b>Coba nama stasiun (Manggarai), jalur (Bogor, Argo), nomor KA (1000, KA 5), atau tempat.</div>`;
  return h;
}
let placeTimer = 0, placeAbort;
function searchPlaces(q) {
  clearTimeout(placeTimer);
  if (q.length < 3) return;
  placeTimer = setTimeout(async () => {
    placeAbort?.abort(); placeAbort = new AbortController();
    try {
      const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=default&bbox=95,-11,141.5,6.5&lat=-6.2&lon=106.8`, { signal: placeAbort.signal });
      const j = await r.json();
      S.places = (j.features || []).map((f) => ({ name: f.properties.name || f.properties.street || q, sub: [f.properties.city || f.properties.county, f.properties.state].filter(Boolean).join(', '), p: f.geometry.coordinates }));
    } catch { S.places = []; }
    S.placeQ = q;
    if (S.q.trim() === q) render(true);
  }, 350);
}

/* ---------- render / navigation ---------- */
function title() {
  const d = S.detail; if (!d) return S.tab === 'rute' ? 'Perjalanan' : 'Sepur Live';
  if (d.type === 'station') return stOf(d.id)?.name || 'Stasiun';
  if (d.type === 'line') return lineOf(d.id)?.name || 'Jalur';
  if (d.type === 'train') return 'Kereta';
  if (d.type === 'journey') return 'Rute perjalanan';
  return 'Di dekatmu';
}
function render(keep) {
  if (!E) return;
  const top = pbody.scrollTop;
  const tts = $('.ttwrap')?.scrollLeft;
  app.dataset.screen = S.detail ? 'detail' : 'home';
  app.dataset.tab = S.tab;
  $('#ptitle').textContent = title();
  document.querySelectorAll('.seg [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  let h;
  if (S.detail) h = { station: stationDetail, line: lineDetail, train: trainDetail, near: nearView, journey: journeyDetail }[S.detail.type](S.detail.id);
  else if (S.q.trim() && S.tab === 'peta') h = searchView();
  else h = S.tab === 'jalur' ? linesView() : S.tab === 'stasiun' ? stationsView() : S.tab === 'rute' ? planView() : homeView();
  view.innerHTML = h;
  if (keep) { pbody.scrollTop = top; const w = $('.ttwrap'); if (w && tts) w.scrollLeft = tts; } else pbody.scrollTop = 0;
  document.title = S.detail ? `${title()} · Sepur Live` : 'Sepur Live · Peta langsung kereta api Indonesia';
  if (S.detail?.type === 'train') updateEta();
  const pq = $('#pick-q');
  if (pq) { pq.focus({ preventScroll: true }); pq.setSelectionRange(pq.value.length, pq.value.length); }
}

function open(type, id, extra = {}, push = true) {
  if (S.card) { const keep = S.follow && type === 'train'; closeCard(); S.follow = keep; }
  if (type === 'train' && String(id).includes(':')) { const k = id.lastIndexOf(':'); extra.date = id.slice(k + 1); id = id.slice(0, k); }
  if (type === 'journey') id = +id;
  S.detail = { type, id, ...extra };
  if (type !== 'train' && type !== 'journey') S.follow = false;
  if (type === 'station' || type === 'line') { S.recent = [{ type, id }, ...S.recent.filter((r) => !(r.type === type && r.id === id))].slice(0, 8); LS.set('recent', S.recent); S.ttDate = null; S.ttHour = null; S.ttDir = 0; }
  render();
  focusDetail(true);
  writeHash(push);
  sheetTo('half');
}
function back(push = true) {
  if (S.detail?.type === 'station' && S.detail.full) { S.detail.full = false; render(); return; }
  S.detail = null; S.follow = false;
  if (map?.getSource('route')) map.getSource('route').setData(FC());
  if (S.tab === 'rute' && S.planRes?.length) drawJourney(S.planRes[0], false);
  render(); writeHash(push);
}
function focusDetail(animate) {
  if (!map?.getSource('route')) return;
  const d = S.detail; map.getSource('route').setData(FC());
  const pad = padding(), duration = animate ? 900 : 0;
  if (!d) return;
  if (d.type === 'station') { const s = stOf(d.id); if (s) map.flyTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 13.5), padding: pad, duration }); }
  if (d.type === 'train') {
    const f = E.find(d.id, clock(), d.date); if (!f) return;
    const l = lineOf(f.trip.line), c = [];
    for (let k = 0; k < f.trip.sids.length - 1; k++) c.push(...E.seg(f.trip.sids[k], f.trip.sids[k + 1]).coords);
    map.getSource('route').setData(FC([{ type: 'Feature', properties: { color: l.color, walk: 0 }, geometry: { type: 'LineString', coordinates: c } }]));
    const s = E.state(f.trip, f.t);
    if (!s) { const b = c.reduce((b, x) => b.extend(x), new maplibregl.LngLatBounds(c[0], c[0])); map.fitBounds(b, { padding: pad, duration, maxZoom: 13 }); }
    else map.flyTo({ center: s.p, zoom: Math.max(map.getZoom(), isKA(l) ? 10.5 : 12.5), padding: pad, duration });
  }
  if (d.type === 'journey' && S.planRes?.[d.id]) drawJourney(S.planRes[d.id], animate);
  if (d.type === 'near' && d.p) map.flyTo({ center: d.p, zoom: 13.5, padding: pad, duration });
  if (d.type === 'line') {
    const l = lineOf(d.id); if (!l) return;
    const coords = [l.stations, ...(l.branches || [])].flat().map((sid) => E.pos(sid));
    const b = coords.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(b, { padding: pad, duration, maxZoom: 14 });
  }
}
function padding() {
  if (innerWidth >= 760) return { top: 60, bottom: 60, left: 60, right: 80 };
  return { top: 80, bottom: Math.round(innerHeight * 0.5), left: 40, right: 70 };
}

/* ---------- URL hash ---------- */
function writeHash(push) {
  const f = [];
  const d = S.detail;
  if (d?.type === 'train') f.push('train=' + encodeURIComponent(d.id) + (d.date ? '&td=' + d.date : ''));
  else if (d?.type === 'station') f.push('station=' + encodeURIComponent(d.id));
  else if (d?.type === 'line') f.push('line=' + encodeURIComponent(d.id));
  if ((!d || d.type === 'journey') && S.tab !== 'peta') f.push('tab=' + S.tab);
  if (S.tab === 'rute' && S.plan.from && S.plan.to && (!d || d.type === 'journey')) { f.push('from=' + S.plan.from, 'to=' + S.plan.to); if (S.plan.date) f.push('pd=' + S.plan.date); if (S.plan.time != null) f.push('pt=' + fmt(S.plan.time).replace('.', '')); }
  if (S.at) { const c = clock(); f.push('t=' + fmt(c.sec).replace('.', '') + '&d=' + c.date + ((S.at.speed || 1) !== 1 ? '&x=' + S.at.speed : '')); }
  if (map) { const c = map.getCenter(); f.push(`@${c.lat.toFixed(5)},${c.lng.toFixed(5)},${map.getZoom().toFixed(1)}`); }
  const url = location.pathname + (f.length ? '#' + f.join('&') : '');
  try { push ? history.pushState(null, '', url) : history.replaceState(null, '', url); } catch {}
}
function readHash(initial) {
  const h = decodeURIComponent(location.hash.slice(1));
  const kv = Object.fromEntries(h.split('&').filter((x) => x.includes('=')).map((x) => x.split('=')));
  const at = h.match(/@(-?[\d.]+),(-?[\d.]+),([\d.]+)/);
  if (at && initial) S.view = { lat: +at[1], lng: +at[2], z: +at[3] };
  if (kv.t && /^\d{3,4}$/.test(kv.t) && (initial || !S.at)) {
    const t = kv.t.padStart(4, '0'); const date = /^\d{4}-\d\d-\d\d$/.test(kv.d || '') ? kv.d : jakartaClock().date;
    setClock(date, +t.slice(0, 2) * 3600 + +t.slice(2) * 60, Math.min(600, Math.max(1, +kv.x || 1)));
  }
  if (['jalur', 'stasiun', 'rute'].includes(kv.tab)) S.tab = kv.tab;
  if (kv.from && kv.to) { S.plan = { from: kv.from, to: kv.to, date: kv.pd || null, time: kv.pt ? +kv.pt.slice(0, 2) * 3600 + +kv.pt.slice(2) * 60 : null }; S.planPending = true; }
  S.detail = kv.train ? { type: 'train', id: kv.train, date: kv.td } : kv.station ? { type: 'station', id: kv.station } : kv.line ? { type: 'line', id: kv.line } : null;
}
addEventListener('popstate', () => { readHash(false); render(); focusDetail(true); });

/* ---------- mobile bottom sheet ---------- */
const pane = $('#pane');
let sheetState = 'peek';
function sheetY(st) {
  const H = pane.getBoundingClientRect().height || innerHeight;
  return st === 'full' ? 0 : st === 'half' ? Math.round(H * 0.42) : Math.max(0, H - 210);
}
function sheetTo(st) { if (innerWidth >= 760) return; sheetState = st; pane.style.setProperty('--sheet-y', sheetY(st) + 'px'); }
function bindSheet() {
  let y0 = 0, base = 0, dy = 0, drag = false;
  const down = (e) => { if (innerWidth >= 760) return; drag = true; y0 = e.clientY; base = sheetY(sheetState); dy = 0; pane.classList.add('dragging'); e.target.setPointerCapture?.(e.pointerId); };
  const move = (e) => { if (!drag) return; dy = e.clientY - y0; pane.style.setProperty('--sheet-y', Math.max(0, base + dy) + 'px'); };
  const up = () => {
    if (!drag) return; drag = false; pane.classList.remove('dragging');
    const y = base + dy, cand = ['full', 'half', 'peek'].map((s) => [s, Math.abs(sheetY(s) - y)]).sort((a, b) => a[1] - b[1]);
    if (Math.abs(dy) < 6) sheetTo(sheetState === 'peek' ? 'half' : sheetState); else sheetTo(cand[0][0]);
  };
  for (const el of [$('#grab'), $('.phead')]) { el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); }
  addEventListener('resize', () => sheetTo(sheetState));
  sheetTo(S.detail || S.tab === 'rute' ? 'half' : 'peek');
}

/* ---------- UI bindings ---------- */
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 2400); }
function netState() { const off = navigator.onLine === false; $('#banner').hidden = !off; $('#live-badge').textContent = off ? 'Offline · jadwal' : 'Menurut jadwal'; }

function locate() {
  if (!navigator.geolocation) return toast('Browser ini tidak bisa membaca lokasi');
  toast('Mencari lokasimu…');
  navigator.geolocation.getCurrentPosition((pos) => {
    const p = [pos.coords.longitude, pos.coords.latitude];
    S.me = p; map.getSource('me')?.setData(FC([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }]));
    open('near', 'me', { p, label: 'Di dekatmu' });
  }, (e) => toast(e.code === 1 ? 'Izin lokasi ditolak. Nyalakan di pengaturan browser.' : 'Lokasimu belum ketemu. Coba lagi sebentar.'), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

function layersPanel() {
  const el = $('#layers');
  const row = (k, t, sw) => `<label><input type="checkbox" data-layer="${k}" ${S.layers[k] ? 'checked' : ''}>${sw ? `<i class="sw" style="background:${sw}"></i>` : ''}${t}</label>`;
  el.innerHTML = `<h3>Tampilan peta <button type="button" data-act="layers-close" aria-label="Tutup"><svg class="i"><use href="#i-x"/></svg></button></h3>
    <div class="grp">Kereta</div>${row('krl', 'KRL Commuter Line', '#E30A16')}${row('mrt', 'MRT Jakarta', '#CE0037')}${row('lrtj', 'LRT Jakarta', '#F16227')}${row('jbdb', 'LRT Jabodebek', '#20409A')}${row('bandara', 'KA Bandara & Skytrain', '#F2A900')}${row('whoosh', 'Whoosh & feeder', '#8C0023')}${row('regional', 'Commuter daerah', '#3B7A8C')}${row('kai', 'KA antarkota', '#6A2C91')}
    <div class="grp">Peta</div>${row('stations', 'Stasiun')}${row('labels', 'Nama dan kode')}${row('net', 'Jaringan rel OpenStreetMap')}`;
}

async function share() {
  const url = location.href;
  try { if (navigator.share && innerWidth < 760) { await navigator.share({ title: document.title, url }); return; } await navigator.clipboard.writeText(url); toast('Tautan disalin'); } catch { toast('Tautan belum bisa disalin'); }
}

function aboutSheet() {
  const el = $('#about');
  el.innerHTML = `<div class="in"><div class="top"><h2>Tentang Sepur Live</h2><button type="button" class="round" data-act="about-close" aria-label="Tutup"><svg class="i"><use href="#i-x"/></svg></button></div>
  <p>Peta langsung dan perencana perjalanan kereta api Indonesia: KRL Commuter Line, MRT Jakarta, LRT Jakarta, LRT Jabodebek, KA Bandara &amp; Skytrain Soekarno-Hatta, Whoosh, KA Feeder, serta KA antarkota dan commuter daerah di Jawa.</p>
  <h3>Dari mana jadwalnya?</h3>
  <ul><li><b>KRL Commuter Line:</b> ${SRC.krl()}</li>
  <li><b>KA antarkota, commuter daerah, KA Bandara, KA Feeder:</b> ${SRC.gapeka()}</li>
  <li><b>MRT Jakarta:</b> ${SRC['shiori-mrt']()}</li>
  <li><b>LRT Jakarta, LRT Jabodebek, Skytrain:</b> data terbuka ${A_SH}. Waktu tiba di stasiun akhir ditaksir.</li>
  <li><b>Whoosh:</b> <span class="badge est">Perkiraan</span> dari pola frekuensi yang diumumkan KCIC. Jadwal resminya belum tersedia sebagai data terbuka.</li>
  <li>Posisi dan prediksi tiba dihitung dari jadwal di atas geometri rel OpenStreetMap. <b>Ini bukan GPS</b>; keterlambatan dan gangguan tidak terlihat. Nomor peron belum ada di sumber data mana pun.</li></ul>
  <h3>Perencana perjalanan</h3><p>Rute dihitung di perangkatmu dengan Connection Scan Algorithm atas semua jadwal di atas. Pindah kereta di stasiun yang sama minimal 3 menit; jalan kaki ke stasiun yang terhubung dihitung dari jaraknya.</p>
  <h3>Peta</h3><p>Data peta © kontributor OpenStreetMap (ODbL). Tile vektor dari OpenFreeMap. Pencarian tempat oleh Photon (komoot).</p>
  <h3>Privasi</h3><p>Tidak ada akun, tidak ada pelacakan. Stasiunku, riwayat, rute, dan pilihan lapisan disimpan hanya di browser ini.</p>
  <p class="credit">Tidak berafiliasi dengan KAI, KAI Commuter, MRT Jakarta, LRT Jakarta, KCIC, atau InJourney. Kode sumber: <a href="https://github.com/podsni/sepur-live" target="_blank" rel="noopener">github.com/podsni/sepur-live</a> (MIT).</p></div>`;
  el.hidden = false;
}

function bindUI() {
  bindSheet();
  if (S.planPending) { S.planPending = false; runPlan(false); }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open],[data-act],[data-tab],[data-filter],[data-place],[data-sline],[data-pick],[data-setplace],[data-journey],[data-ttdate],[data-ttdir],[data-tthour],[data-speed]');
    if (!t) { if (e.target.id === 'about') $('#about').hidden = true; return; }
    if (t.matches('input') && t.dataset.act !== 'pass') return;
    if (t.dataset.open) { const [type, ...rest] = t.dataset.open.split(':'); open(type, rest.join(':')); return; }
    if (t.dataset.tab) {
      S.tab = t.dataset.tab; S.detail = null; S.q = ''; $('#q').value = ''; $('#qx').hidden = true;
      if (map?.getSource('route')) map.getSource('route').setData(FC());
      if (S.tab === 'rute') { if (!S.plan.from) S.pick = 'from'; else if (!S.plan.to) S.pick = 'to'; else if (!S.planRes) runPlan(false); if (S.planRes?.length) drawJourney(S.planRes[0], false); }
      render(); writeHash(true); sheetTo(S.tab === 'peta' ? sheetState : 'half'); return;
    }
    if (t.dataset.filter) { S.filter = t.dataset.filter; render(true); return; }
    if (t.dataset.sline !== undefined) { S.detail.line = t.dataset.sline || null; render(true); return; }
    if (t.dataset.pick) { S.pick = t.dataset.pick; S.pickQ = ''; render(true); sheetTo('full'); return; }
    if (t.dataset.setplace) { setPlace(S.pick, t.dataset.setplace); sheetTo('half'); return; }
    if (t.dataset.journey) { open('journey', t.dataset.journey); return; }
    if (t.dataset.ttdate) { S.ttDate = t.dataset.ttdate; S.ttHour = null; render(true); return; }
    if (t.dataset.ttdir) { S.ttDir = +t.dataset.ttdir; S.ttHour = null; render(true); return; }
    if (t.dataset.tthour) { S.ttHour = +t.dataset.tthour; render(true); return; }
    if (t.dataset.speed) { const c = clock(); setClock(c.date, c.sec, +t.dataset.speed); tick(); writeHash(false); return; }
    const a = t.dataset.act;
    if (a === 'card-close') closeCard();
    else if (a === 'card-follow') { S.follow = !S.follow; if (S.follow) { const f = E.find(S.card.id, clock(), S.card.date); const st = f && E.state(f.trip, f.t); if (st) map.easeTo({ center: st.p, zoom: Math.max(map.getZoom(), 13), duration: 600 }); } toast(S.follow ? 'Peta ikut bergerak bersama kereta ini' : 'Berhenti mengikuti'); tick(); }
    else if (a === 'back') back();
    else if (a === 'about') aboutSheet();
    else if (a === 'about-close') $('#about').hidden = true;
    else if (a === 'locate') locate();
    else if (a === 'share') share();
    else if (a === 'fit') focusDetail(true);
    else if (a === 'full') { S.detail.full = true; S.ttDate = null; render(); }
    else if (a === 'full-off') { S.detail.full = false; render(); }
    else if (a === 'pass') { S.showPass = t.checked; render(true); }
    else if (a === 'plan-from' || a === 'plan-to') {
      S.plan[a === 'plan-from' ? 'from' : 'to'] = S.detail.id; LS.set('plan', { from: S.plan.from, to: S.plan.to });
      S.tab = 'rute'; S.detail = null; S.pick = !S.plan.from ? 'from' : !S.plan.to || S.plan.to === S.plan.from ? (a === 'plan-from' ? 'to' : 'from') : null;
      if (!S.pick) runPlan(true); else render(); writeHash(true); sheetTo('half');
    }
    else if (a === 'swap') { [S.plan.from, S.plan.to] = [S.plan.to, S.plan.from]; LS.set('plan', { from: S.plan.from, to: S.plan.to }); if (S.plan.from && S.plan.to) runPlan(true); else render(true); }
    else if (a === 'pick-cancel') { S.pick = null; render(true); }
    else if (a === 'when-now') { S.plan.time = null; S.plan.date = null; runPlan(false); }
    else if (a === 'j-fit') drawJourney(S.planRes[S.detail.id], true);
    else if (a === 'j-sim') simulateJourney(S.planRes[S.detail.id]);
    else if (a === 'sim-train') {
      const f = E.find(S.detail.id, clock(), S.detail.date); if (!f) return;
      const st = E.state(f.trip, f.t);
      setClock(f.trip.date, st && f.t >= f.trip.start ? f.t : f.trip.start - 60, isKA(lineOf(f.trip.line)) ? 120 : 30);
      S.follow = true; toast(`Diputar ${S.at.speed}× lebih cepat · peta ikut kereta`); render(true); tick(); writeHash(false);
    }
    else if (a === 'sim-stop') { S.at = null; S.simJ = null; S.follow = false; actT = 0; toast('Kembali ke waktu sekarang'); writeHash(false); render(true); tick(); }
    else if (a === 'layers-close') { $('#layers').hidden = true; $('#b-layers').setAttribute('aria-pressed', 'false'); }
    else if (a === 'fav') { S.fav = S.fav === S.detail.id ? null : S.detail.id; LS.set('fav', S.fav); toast(S.fav ? 'Disimpan sebagai stasiunku' : 'Stasiunku dilepas'); render(true); }
    else if (a === 'follow') { S.follow = !S.follow; toast(S.follow ? 'Peta ikut bergerak bersama kereta ini' : 'Berhenti mengikuti'); render(true); }
  });
  document.addEventListener('change', (e) => {
    const k = e.target.dataset?.layer; if (k) { S.layers[k] = e.target.checked; applyLayers(); return; }
    if (e.target.matches('[data-ttdate-input]') && e.target.value) { S.ttDate = e.target.value; S.ttHour = null; render(true); return; }
    const p = e.target.dataset?.plan;
    if (p === 'date' && e.target.value) { S.plan.date = e.target.value; if (S.plan.time == null) S.plan.time = Math.floor(clock().sec / 60) * 60; runPlan(false); }
    if (p === 'time' && e.target.value) { const [hh, mm] = e.target.value.split(':'); S.plan.time = +hh * 3600 + +mm * 60; if (!S.plan.date) S.plan.date = clock().date; runPlan(false); }
  });
  document.addEventListener('input', (e) => { if (e.target.id === 'pick-q') { S.pickQ = e.target.value; render(true); } });
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'pick-q' && e.key === 'Enter') { e.preventDefault(); view.querySelector('[data-setplace]')?.click(); return; }
    if (e.key === 'Escape') { if (S.card) closeCard(); else if (!$('#about').hidden) $('#about').hidden = true; else if (!$('#layers').hidden) $('#layers').hidden = true; else if (S.pick && S.plan.from && S.plan.to) { S.pick = null; render(true); } else if (S.detail) back(); }
  });
  const q = $('#q');
  q.addEventListener('input', () => { S.q = q.value; $('#qx').hidden = !q.value; if (S.tab === 'peta' && S.detail) S.detail = null; render(); if (S.tab === 'peta') searchPlaces(q.value.trim()); });
  q.addEventListener('focus', () => sheetTo('full'));
  $('#search').addEventListener('submit', (e) => { e.preventDefault(); const first = view.querySelector('[data-open],[data-place]'); first?.click(); q.blur(); });
  $('#qx').onclick = () => { q.value = ''; S.q = ''; $('#qx').hidden = true; render(); q.focus(); };
  $('#b-zin').onclick = () => map.zoomIn(); $('#b-zout').onclick = () => map.zoomOut();
  $('#b-locate').onclick = locate;
  $('#b-3d').onclick = (e) => {
    S.threeD = !S.threeD; e.currentTarget.setAttribute('aria-pressed', String(S.threeD));
    if (map.getLayer('b3d')) map.setLayoutProperty('b3d', 'visibility', S.threeD ? 'visible' : 'none');
    map.easeTo({ pitch: S.threeD ? 60 : 0, bearing: S.threeD ? -20 : 0, zoom: S.threeD ? Math.max(map.getZoom(), 14) : map.getZoom(), duration: 900 });
  };
  $('#b-ug').onclick = (e) => {
    S.ug = !S.ug; e.currentTarget.setAttribute('aria-pressed', String(S.ug));
    app.toggleAttribute('data-ug', S.ug);
    map.setLayoutProperty('tun', 'visibility', S.ug ? 'visible' : 'none');
    for (const l of map.getStyle().layers) {
      if (['net', 'tun', 'route', 'route-case', 'route-walk', 'lines-case', 'lines', 'st-c', 'st-l', 'tr-halo', 'tr-a', 'tr-c', 'tr-t', 'me', 'b3d'].includes(l.id)) continue;
      const prop = { fill: 'fill-opacity', line: 'line-opacity', symbol: 'text-opacity', background: 'background-opacity', 'fill-extrusion': 'fill-extrusion-opacity' }[l.type];
      if (!prop) continue;
      if (S.ug) { l.__o = map.getPaintProperty(l.id, prop); map.setPaintProperty(l.id, prop, 0.25); } else map.setPaintProperty(l.id, prop, l.__o ?? (prop === 'background-opacity' ? 1 : undefined));
    }
    if (S.ug) { toast('Bawah tanah: terowongan rel ditandai garis putus-putus'); if (!S.detail) map.flyTo({ center: [106.8225, -6.205], zoom: 13 }); }
  };
  $('#b-layers').onclick = (e) => { const el = $('#layers'); const show = el.hidden; if (show) layersPanel(); el.hidden = !show; e.currentTarget.setAttribute('aria-pressed', String(show)); };
}

boot();
