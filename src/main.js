import maplibregl from 'maplibre-gl';
import { Engine, jakartaClock, dayType, fmt, addDays } from './sched.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app'), view = $('#view'), pbody = $('#pbody');
const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const SYS_LABEL = { krl: 'KRL', mrt: 'MRT', lrtj: 'LRT Jakarta', jbdb: 'LRT Jabodebek', bandara: 'Bandara', whoosh: 'Whoosh', regional: 'Commuter daerah', kai: 'KA antarkota' };
const CHIP_SYS = [['all', 'Semua'], ['krl', 'KRL'], ['mrt', 'MRT'], ['lrt', 'LRT'], ['bandara', 'Bandara'], ['whoosh', 'Whoosh']];
const chipOf = (sys) => (sys === 'lrtj' || sys === 'jbdb' ? 'lrt' : sys);
const QUICK = ['MRI', 'THB', 'SUD', 'JNG', 'DU', 'KPB', 'BKS', 'BOO', 'CW', 'DP'];
const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('sepur:' + k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('sepur:' + k, JSON.stringify(v)); } catch {} } };

let NET, KRL, E, map;
const S = {
  tab: 'peta', screen: 'home', detail: null, filter: 'all', follow: false, threeD: false, ug: false,
  q: '', at: null, layers: LS.get('layers', { krl: true, mrt: true, lrtj: true, jbdb: true, bandara: true, whoosh: true, regional: true, kai: true, stations: true, net: true, labels: true }),
  fav: LS.get('fav', null), recent: LS.get('recent', []), me: null, places: [], placeQ: '',
};
let lastRunning = [];

/* ---------- time (Asia/Jakarta), with optional #t=HHMM&d=YYYY-MM-DD override for testing/time travel ---------- */
function clock() {
  if (!S.at) return jakartaClock();
  const el = (Date.now() - S.at.wall) / 1000;
  let sec = S.at.sec + el, date = S.at.date;
  while (sec >= 86400) { sec -= 86400; date = addDays(date, 1); }
  return { date, sec, dow: new Date(date + 'T00:00:00Z').getUTCDay() };
}
const mins = (s) => { const m = Math.max(0, Math.round(s / 60)); return m < 1 ? 'sekarang' : m < 60 ? `${m} mnt` : `${Math.floor(m / 60)} j ${m % 60} mnt`; };
const lineOf = (id) => E.lines.get(id);
const stOf = (id) => E.st.get(id);
const lb = (l, ring) => `<span class="lb${ring ? ' ring' : ''}" style="${ring ? 'border-color' : 'background'}:${esc(l.color)}">${esc(l.short)}</span>`;
const dots = (s) => `<span class="dots">${s.lines.slice(0, 6).map((id) => `<i style="background:${esc(lineOf(id)?.color)}"></i>`).join('')}</span>`;
const trainName = (t) => (t.est ? `${SYS_LABEL[lineOf(t.line).sys]} · perkiraan` : `KA ${t.id}`);

/* ---------- boot ---------- */
async function getJSON(url, onp) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  const j = await r.json();
  onp?.();
  return j;
}
function bar(p) { $('#load-bar').style.width = Math.round(p * 100) + '%'; }

async function boot() {
  readHash(true);
  bar(0.1);
  try {
    let n = 0;
    const step = () => bar(0.15 + 0.35 * ++n);
    [NET, KRL] = await Promise.all([getJSON('/data/network.json', step), getJSON('/data/krl.json', step)]);
  } catch (e) {
    $('#load-t').textContent = 'Jadwal belum bisa dimuat';
    $('#load-s').textContent = 'Periksa koneksimu, lalu coba lagi.';
    $('#load-retry').hidden = false;
    $('#load-retry').onclick = () => location.reload();
    return;
  }
  E = new Engine(NET, KRL);
  bar(0.85);
  initMap();
  bindUI();
  render();
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden) render(true); }, 15000);
  addEventListener('online', netState); addEventListener('offline', netState); netState();
}

/* ---------- map ---------- */
function lineFeatures() {
  const f = [];
  for (const l of NET.lines) {
    if (l.sched === 'none') continue;
    const done = new Set();
    for (const p of [l.stations, ...(l.branches || [])])
      for (let i = 1; i < p.length; i++) {
        const k = p[i - 1] < p[i] ? p[i - 1] + '>' + p[i] : p[i] + '>' + p[i - 1];
        if (done.has(k)) continue; done.add(k);
        f.push({ type: 'Feature', properties: { line: l.id, sys: l.sys, color: l.color }, geometry: { type: 'LineString', coordinates: E.seg(p[i - 1], p[i]).coords } });
      }
  }
  return { type: 'FeatureCollection', features: f };
}
function stationFeatures() {
  return { type: 'FeatureCollection', features: NET.stations.map((s) => {
    const ls = s.lines.map(lineOf).filter(Boolean);
    const main = ls.find((l) => l.sched !== 'none') || ls[0];
    return { type: 'Feature', id: undefined, properties: { id: s.id, name: s.name, sys: s.sys[0], sched: main ? main.sched : 'none', color: main ? main.color : '#888', big: ls.length > 1 || s.xfer.length > 0 ? 1 : 0 }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } };
  }) };
}
const FC = (features = []) => ({ type: 'FeatureCollection', features });

function initMap() {
  const h = S.view || { lng: 106.83, lat: -6.24, z: window.innerWidth < 760 ? 9.6 : 10.4 };
  map = new maplibregl.Map({ container: 'map', style: STYLE, center: [h.lng, h.lat], zoom: h.z, attributionControl: { compact: true }, maxPitch: 70, dragRotate: true, hash: false });
  map.on('error', (e) => console.warn('map', e?.error?.message || e));
  map.once('load', () => {
    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    map.addSource('net', { type: 'geojson', data: FC(NET.net.map((n) => ({ type: 'Feature', properties: { m: n.m }, geometry: { type: 'LineString', coordinates: n.c } }))) });
    map.addLayer({ id: 'net', type: 'line', source: 'net', paint: { 'line-color': '#B9B9C0', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 1.6, 16, 3] } }, before);
    map.addSource('tun', { type: 'geojson', data: FC(NET.tunnels.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } }))) });
    map.addLayer({ id: 'tun', type: 'line', source: 'tun', layout: { visibility: 'none' }, paint: { 'line-color': '#111', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 7], 'line-dasharray': [1.2, 0.8], 'line-opacity': 0.75 } });
    map.addSource('route', { type: 'geojson', data: FC() });
    map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2.5, 14, 6] } });
    map.addSource('lines', { type: 'geojson', data: lineFeatures() });
    map.addLayer({ id: 'lines-case', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 9] } });
    map.addLayer({ id: 'lines', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 5.5], 'line-opacity': 0.9 } });
    map.addSource('stations', { type: 'geojson', data: stationFeatures() });
    map.addLayer({ id: 'st-c', type: 'circle', source: 'stations', minzoom: 8.5, paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['case', ['==', ['get', 'big'], 1], 3.5, 2.5], 14, ['case', ['==', ['get', 'big'], 1], 8, 6]],
      'circle-color': '#fff', 'circle-stroke-color': ['case', ['==', ['get', 'sched'], 'none'], '#9A9AA2', ['get', 'color']], 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 1.4, 14, 2.6] } });
    map.addLayer({ id: 'st-l', type: 'symbol', source: 'stations', minzoom: 11.5, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11.5, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': '#3a3a40', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } });
    map.addSource('trains', { type: 'geojson', data: FC() });
    map.addLayer({ id: 'tr-halo', type: 'circle', source: 'trains', filter: ['==', ['get', 'sel'], 1], paint: { 'circle-radius': 17, 'circle-color': ['get', 'color'], 'circle-opacity': 0.22 } });
    map.addLayer({ id: 'tr-c', type: 'circle', source: 'trains', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 11, 8.5, 15, 12], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#1d1d22', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 14, 2.5], 'circle-opacity': ['case', ['==', ['get', 'dim'], 1], 0.25, 1], 'circle-stroke-opacity': ['case', ['==', ['get', 'dim'], 1], 0.25, 1] } });
    map.addLayer({ id: 'tr-t', type: 'symbol', source: 'trains', minzoom: 10, layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 7.5, 15, 10], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#fff', 'text-opacity': ['case', ['==', ['get', 'dim'], 1], 0.3, 1] } });
    map.addSource('me', { type: 'geojson', data: FC() });
    map.addLayer({ id: 'me', type: 'circle', source: 'me', paint: { 'circle-radius': 7, 'circle-color': '#2F7BF6', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
    // 3D buildings from the OpenMapTiles schema used by OpenFreeMap
    const vsrc = Object.entries(map.getStyle().sources).find(([, s]) => s.type === 'vector')?.[0];
    if (vsrc) map.addLayer({ id: 'b3d', type: 'fill-extrusion', source: vsrc, 'source-layer': 'building', minzoom: 13, layout: { visibility: 'none' }, paint: { 'fill-extrusion-color': '#DCDCE2', 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.8 } }, 'net');
    for (const id of ['tr-c', 'st-c', 'lines']) {
      map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
    }
    map.on('click', (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: ['tr-c', 'st-c', 'lines'] });
      const tr = f.find((x) => x.layer.id === 'tr-c'), st = f.find((x) => x.layer.id === 'st-c'), ln = f.find((x) => x.layer.id === 'lines');
      if (tr) open('train', tr.properties.id, { date: tr.properties.date });
      else if (st) open('station', st.properties.id);
      else if (ln) open('line', ln.properties.line);
    });
    map.on('dragstart', () => { if (S.follow) { S.follow = false; toast('Berhenti mengikuti kereta'); render(true); } });
    map.on('moveend', () => writeHash());
    applyLayers();
    if (S.detail) focusDetail(false);
    tick();
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

function tick() {
  if (!E || !map?.getSource('trains')) return;
  const c = clock();
  lastRunning = E.running(c);
  const sel = S.detail?.type === 'train' ? S.detail.id : null;
  const selLine = S.detail?.type === 'line' ? S.detail.id : null;
  const feats = [];
  for (const r of lastRunning) {
    const l = lineOf(r.trip.line);
    if (!S.layers[l.sys]) continue;
    const dim = (S.filter !== 'all' && chipOf(l.sys) !== S.filter) || (selLine && r.trip.line !== selLine) ? 1 : 0;
    feats.push({ type: 'Feature', properties: { id: r.trip.id, date: r.trip.date, color: l.color, label: l.short, sel: r.trip.id === sel ? 1 : 0, dim }, geometry: { type: 'Point', coordinates: r.s.p } });
  }
  feats.sort((a, b) => a.properties.sel - b.properties.sel || b.properties.dim - a.properties.dim);
  map.getSource('trains').setData(FC(feats));
  if (S.follow && sel) {
    const r = lastRunning.find((x) => x.trip.id === sel);
    if (r) map.easeTo({ center: r.s.p, duration: 900, easing: (t) => t });
  }
  const t = $('#tick-now'); if (t) t.textContent = fmt(c.sec);
  const st = $('#train-status'); if (st && sel) st.innerHTML = trainStatus(S.detail.id);
}

/* ---------- views ---------- */
function counts() {
  const c = { all: 0 };
  for (const r of lastRunning) { const k = chipOf(lineOf(r.trip.line).sys); c[k] = (c[k] || 0) + 1; c.all++; }
  return c;
}
function dayLabel(c) { return dayType(c.date, NET.holidays) === 'weekend' ? (c.dow === 0 || c.dow === 6 ? 'Akhir pekan' : 'Hari libur') : 'Hari kerja'; }

function homeView() {
  const c = clock(); lastRunning = E.running(c); const n = counts();
  let h = `<div class="now"><span class="k">Sekarang · <span id="tick-now">${fmt(c.sec)}</span> WIB · ${dayLabel(c)}</span><span class="v">${n.all} kereta<small>jalan menurut jadwal</small></span></div>`;
  h += `<div class="chips" role="group" aria-label="Saring jenis kereta">${CHIP_SYS.map(([k, t]) => `<button type="button" class="chip" data-filter="${k}" aria-pressed="${S.filter === k}">${t} <b>${n[k] || 0}</b></button>`).join('')}</div>`;
  if (!n.all) {
    const nx = E.nextService(c);
    h += `<div class="card"><div class="ch"><span class="art"><svg class="i"><use href="#i-train"/></svg></span><div><b>Zzz… kereta sudah pulang ke dipo</b><span>${nx ? `Kereta pertama ${esc(trainName(nx.trip))} berangkat ${fmt(nx.trip.start)} dari ${esc(stOf(nx.trip.sids[0]).name)}, ${mins(nx.wait)} lagi.` : 'Belum ada jadwal.'}</span></div></div></div>`;
  }
  h += favCard(c);
  if (S.recent.length) {
    h += `<div class="sech"><h2>Terakhir dibuka</h2></div><div class="list">${S.recent.slice(0, 5).map((r) => recentRow(r)).join('')}</div>`;
  }
  const runningNow = lastRunning.filter((r) => S.filter === 'all' || chipOf(lineOf(r.trip.line).sys) === S.filter)
    .sort((a, b) => a.trip.times[a.s.next ?? a.s.at] - b.trip.times[b.s.next ?? b.s.at]).slice(0, 12);
  if (runningNow.length) {
    h += `<div class="sech"><h2>Sedang jalan</h2><span>${S.filter === 'all' ? 'semua jenis' : esc(CHIP_SYS.find((x) => x[0] === S.filter)[1])}</span></div><div class="list">${runningNow.map((r) => trainRow(r.trip, r.s)).join('')}</div>`;
  }
  h += `<div class="note">KA antarkota dan commuter daerah tampil sebagai jalur dan stasiun di peta. Jadwal publiknya belum tersedia sebagai data terbuka, jadi posisinya tidak ditampilkan.</div>`;
  return h;
}
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
  const nx = s.next != null ? s.next : s.at;
  const where = s.kind === 'dwell' ? `di ${stOf(t.sids[s.at]).name}` : `menuju ${stOf(t.sids[s.next]).name}`;
  return `<button type="button" class="row" data-open="train:${esc(t.id)}:${t.date}">${lb(l)}<span class="main"><b>ke ${esc(t.head)}</b><span>${esc(trainName(t))} · ${esc(where)}</span></span><span class="side"><b>${fmt(t.times[nx])}</b><span>${nx === t.times.length - 1 ? 'tiba akhir' : 'berikutnya'}</span></span></button>`;
}
function depRow(d) {
  const t = d.trip, l = lineOf(t.line);
  return `<button type="button" class="row" data-open="train:${esc(t.id)}:${t.date}">${lb(l)}<span class="main"><b>${esc(t.head)}</b><span>${esc(trainName(t))}${t.est ? '' : ''}</span></span><span class="side"><b>${fmt(d.dep)}</b><span class="${d.wait < 300 ? 'soon' : ''}">${mins(d.wait)}</span></span></button>`;
}

function linesView() {
  const c = clock(); const n = new Map();
  for (const r of lastRunning) n.set(r.trip.line, (n.get(r.trip.line) || 0) + 1);
  let h = '';
  for (const sys of NET.systems) {
    const ls = NET.lines.filter((l) => l.sys === sys.id && (!S.q || matches(l.name + ' ' + l.short, S.q)));
    if (!ls.length) continue;
    const tag = sys.sched === 'timetable' ? '<span class="badge real">Jadwal resmi</span>' : sys.sched === 'frequency' ? '<span class="badge est">Perkiraan</span>' : '<span class="badge">Peta saja</span>';
    h += `<div class="sech"><h2>${esc(sys.name)}</h2>${tag}</div><div class="list">${ls.map((l) => {
      const run = n.get(l.id) || 0;
      return `<button type="button" class="row" data-open="line:${esc(l.id)}">${lb(l)}<span class="main"><b>${esc(l.name)}</b><span>${l.stations.length} stasiun${l.sched !== 'none' ? ` · ${run} kereta jalan` : ''}</span></span><svg class="i chev"><use href="#i-chev"/></svg></button>`;
    }).join('')}</div>`;
  }
  return h || `<div class="empty"><b>Jalur tidak ditemukan</b>Coba nama lain, misalnya Bogor, MRT, atau Whoosh.</div>`;
}

function stationsView() {
  const list = NET.stations.filter((s) => !S.q || matches(s.name, S.q));
  const groups = [['Jabodetabek & Bandung (ada jadwal)', list.filter((s) => s.lines.some((id) => lineOf(id).sched !== 'none'))], ['Stasiun lain (peta saja)', list.filter((s) => !s.lines.some((id) => lineOf(id).sched !== 'none'))]];
  let h = '';
  for (const [t, arr] of groups) {
    if (!arr.length) continue;
    h += `<div class="sech"><h2>${t}</h2><span>${arr.length}</span></div><div class="list">${arr.slice(0, 400).map((s) => `<button type="button" class="row" data-open="station:${esc(s.id)}">${dots(s)}<span class="main"><b>${esc(s.name)}</b><span>${esc(s.sys.map((x) => SYS_LABEL[x]).join(' · '))}</span></span><svg class="i chev"><use href="#i-chev"/></svg></button>`).join('')}</div>`;
  }
  return h || `<div class="empty"><b>Stasiun tidak ditemukan</b>Coba cari namanya, misalnya Manggarai.</div>`;
}

function srcNote(l) {
  if (l.sched === 'timetable') return `<div class="note">Jadwal resmi KAI Commuter dari papan keberangkatan publik di kci.id, dihimpun oleh Open-KRL (CC-BY 4.0; hari kerja ${esc(KRL.meta.weekday)}, akhir pekan ${esc(KRL.meta.weekend)}). Posisi di peta dihitung dari jadwal ini di atas rel OpenStreetMap, bukan posisi GPS. Keterlambatan tidak terlihat.</div>`;
  if (l.sched === 'frequency') return `<div class="note est"><b>Perkiraan.</b> Jadwal resmi per kereta untuk jalur ini belum tersedia sebagai data terbuka. Kereta di peta dibuat dari pola frekuensi yang diumumkan operator (kira-kira tiap ${esc(l.freq.weekday.map((b) => b[2]).filter((v, i, a) => a.indexOf(v) === i).join('/'))} menit) dan kecepatan rata-rata. Nomor perjalanan buatan Sepur Live.</div>`;
  return `<div class="note">Jalur dan stasiun dari OpenStreetMap. Jadwal publik untuk kereta ini belum tersedia sebagai data terbuka, jadi posisi kereta tidak ditampilkan.</div>`;
}

function lineDetail(id) {
  const l = lineOf(id); if (!l) return notFound('Jalur ini tidak ada di data');
  const c = clock(); const span = l.sched !== 'none' ? E.lineSpan(l.id, c.date) : null;
  const run = lastRunning.filter((r) => r.trip.line === l.id);
  const sys = NET.systems.find((s) => s.id === l.sys);
  let h = `<div class="dhead">${lb(l)}<div class="t"><b>${esc(l.name)}</b><span>${esc(sys?.name || '')} · ${esc(sys?.operator || '')}</span></div></div>`;
  if (l.sched !== 'none') h += `<div class="facts"><div class="fact"><span>Jalan sekarang</span><b>${run.length}</b></div><div class="fact"><span>Pertama</span><b>${span ? fmt(span.first) : '–'}</b></div><div class="fact"><span>Terakhir</span><b>${span ? fmt(span.last) : '–'}</b></div></div>`;
  h += `<div class="acts"><button type="button" class="btn small" data-act="fit"><svg class="i"><use href="#i-pin"/></svg>Lihat di peta</button><button type="button" class="btn small" data-act="share"><svg class="i"><use href="#i-share"/></svg>Bagikan</button></div>`;
  h += srcNote(l);
  if (run.length) h += `<div class="sech"><h2>Kereta di jalur ini</h2><span>${run.length}</span></div><div class="list">${run.slice(0, 15).map((r) => trainRow(r.trip, r.s)).join('')}</div>`;
  const pats = [l.stations, ...(l.branches || [])];
  pats.forEach((p, i) => {
    h += `<div class="sech"><h2>${i ? 'Cabang' : 'Stasiun'}</h2><span>${esc(stOf(p[0]).name)} – ${esc(stOf(p[p.length - 1]).name)}</span></div><div class="stops" style="--c:${esc(l.color)}">${p.map((sid) => { const s = stOf(sid); const other = s.lines.filter((x) => x !== l.id); return `<button type="button" class="stop" data-open="station:${esc(sid)}"><span class="nm">${esc(s.name)}${other.length ? dots({ lines: other }) : ''}</span></button>`; }).join('')}</div>`;
  });
  return h;
}

function stationDetail(id) {
  const s = stOf(id); if (!s) return notFound('Stasiun ini tidak ada di data');
  const c = clock(); const deps = E.departures(id, c, 60);
  const ls = s.lines.map(lineOf).filter(Boolean);
  const filt = S.detail.line && ls.some((l) => l.id === S.detail.line) ? S.detail.line : null;
  const shown = deps.filter((d) => !filt || d.trip.line === filt).slice(0, 24);
  let h = `<div class="dhead"><span class="lb" style="background:${esc(ls[0]?.color || '#888')}"><svg class="i" style="fill:#fff"><use href="#i-train"/></svg></span><div class="t"><b>${esc(s.name)}</b><span>${esc(s.sys.map((x) => SYS_LABEL[x]).join(' · '))}</span></div></div>`;
  h += `<div class="acts"><button type="button" class="btn small" data-act="fav"><svg class="i"><use href="#i-star"/></svg>${S.fav === id ? 'Stasiunku ✓' : 'Jadikan stasiunku'}</button><button type="button" class="btn small" data-act="fit"><svg class="i"><use href="#i-pin"/></svg>Peta</button><button type="button" class="btn small" data-act="share"><svg class="i"><use href="#i-share"/></svg>Bagikan</button></div>`;
  h += `<div class="sech"><h2>Jalur</h2></div><div class="list">${ls.map((l) => `<button type="button" class="row" data-open="line:${esc(l.id)}">${lb(l)}<span class="main"><b>${esc(l.name)}</b><span>${l.sched === 'timetable' ? 'Jadwal resmi' : l.sched === 'frequency' ? 'Perkiraan frekuensi' : 'Peta saja'}</span></span><svg class="i chev"><use href="#i-chev"/></svg></button>`).join('')}</div>`;
  const xf = (s.xfer || []).map(stOf).filter(Boolean);
  if (xf.length) h += `<div class="sech"><h2>Pindah ke</h2></div><div class="pills">${xf.map((x) => `<button type="button" class="pill" data-open="station:${esc(x.id)}">${esc(x.name)} · ${esc(x.sys.map((y) => SYS_LABEL[y]).join('/'))}</button>`).join('')}</div>`;
  if (ls.some((l) => l.sched !== 'none')) {
    const sched = ls.filter((l) => l.sched !== 'none');
    h += `<div class="sech"><h2>Keberangkatan</h2><span>${fmt(c.sec)} WIB · ${dayLabel(c)}</span></div>`;
    if (sched.length > 1) h += `<div class="chips">${[['', 'Semua'], ...sched.map((l) => [l.id, l.short])].map(([k, t]) => `<button type="button" class="chip" data-sline="${esc(k)}" aria-pressed="${(filt || '') === k}">${esc(t)}</button>`).join('')}</div>`;
    h += shown.length ? `<div class="list board">${shown.map(depRow).join('')}</div>` : `<div class="empty"><b>Tidak ada keberangkatan dalam 6 jam ke depan</b>${(() => { const nx = E.nextService(c); return nx ? `Layanan pertama berikutnya ${fmt(nx.trip.start)}.` : ''; })()}</div>`;
    h += sched.some((l) => l.sched === 'frequency') ? `<div class="note est">Keberangkatan MRT, LRT, KA Bandara, dan Whoosh adalah perkiraan dari pola frekuensi, bukan jadwal resmi.</div>` : `<div class="note">Waktu dari jadwal resmi KAI Commuter (Open-KRL). Keterlambatan tidak terlihat.</div>`;
  } else h += `<div class="note">Belum ada jadwal publik untuk stasiun ini. Data stasiun dari OpenStreetMap.</div>`;
  return h;
}

function trainStatus(id) {
  const f = E.find(id, clock()); if (!f) return '';
  const { trip, t } = f; const s = E.state(trip, t);
  if (!s) return t < trip.start ? `Berangkat ${fmt(trip.start)} dari ${esc(stOf(trip.sids[0]).name)}, ${mins(trip.start - t)} lagi` : `Perjalanan menurut jadwal sudah selesai (${fmt(trip.end)})`;
  if (s.kind === 'dwell') return s.next == null ? `Tiba di ${esc(stOf(trip.sids[s.at]).name)}, stasiun terakhir` : `Berhenti di ${esc(stOf(trip.sids[s.at]).name)}, berangkat ${fmt(trip.times[s.at])}`;
  return `Menuju ${esc(stOf(trip.sids[s.next]).name)}, tiba ${fmt(trip.times[s.next] - (s.next < trip.times.length - 1 ? 25 : 0))} (${mins(trip.times[s.next] - t)})`;
}

function trainDetail(id) {
  const f = E.find(id, clock()); if (!f) return notFound('Kereta ini tidak ada di jadwal hari ini');
  const { trip, t } = f; const l = lineOf(trip.line); const s = E.state(trip, t);
  const curIdx = s ? (s.kind === 'dwell' ? s.at : s.next) : (t < trip.start ? 0 : trip.sids.length);
  let h = `<div class="dhead">${lb(l)}<div class="t"><b>${esc(trip.est ? 'Kereta ke ' + trip.head : `KA ${trip.id} ke ${trip.head}`)}</b><span>${esc(l.name)} · ${esc(stOf(trip.sids[0]).name)} → ${esc(stOf(trip.sids.at(-1)).name)}</span></div></div>`;
  h += `<div class="card white"><b id="train-status">${trainStatus(id)}</b><div class="prog" style="--c:${esc(l.color)}"><i style="width:${Math.round((s ? s.progress : t > trip.end ? 1 : 0) * 100)}%"></i></div><span class="credit">${trip.est ? '<span class="badge est">Perkiraan</span>' : '<span class="badge real">Jadwal resmi</span>'} ${trip.type === 'weekend' ? 'Jadwal akhir pekan/libur' : 'Jadwal hari kerja'}</span></div>`;
  h += `<div class="acts"><button type="button" class="btn small${S.follow ? ' primary' : ''}" data-act="follow"><svg class="i"><use href="#i-follow"/></svg>${S.follow ? 'Mengikuti' : 'Ikuti di peta'}</button><button type="button" class="btn small" data-act="share"><svg class="i"><use href="#i-share"/></svg>Bagikan</button></div>`;
  h += srcNote(l);
  h += `<div class="sech"><h2>Perjalanan</h2><span>${trip.sids.length} stasiun · ${fmt(trip.start)}–${fmt(trip.end)}</span></div><div class="stops" style="--c:${esc(l.color)}">${trip.sids.map((sid, i) => `<button type="button" class="stop${i < curIdx ? ' past' : ''}${i === curIdx && s ? ' cur' : ''}" data-open="station:${esc(sid)}"><span class="nm">${esc(stOf(sid).name)}</span><span class="tm">${fmt(trip.times[i])}</span></button>`).join('')}</div>`;
  return h;
}

function nearView() {
  const p = S.detail.p; if (!p) return notFound('Lokasi belum ketemu');
  const near = NET.stations.map((s) => ({ s, d: dist(p, [s.lng, s.lat]) })).sort((a, b) => a.d - b.d).slice(0, 10);
  let h = `<div class="dhead"><span class="lb" style="background:#2F7BF6"><svg class="i" style="fill:#fff"><use href="#i-pin"/></svg></span><div class="t"><b>${esc(S.detail.label || 'Di dekatmu')}</b><span>Stasiun terdekat</span></div></div>`;
  if (near[0].d > 15000) h += `<div class="note">Stasiun terdekat lebih dari 15 km dari sini.</div>`;
  h += `<div class="list">${near.map(({ s, d }) => { const nx = E.departures(s.id, clock(), 1)[0]; return `<button type="button" class="row" data-open="station:${esc(s.id)}">${dots(s)}<span class="main"><b>${esc(s.name)}</b><span>${d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km'} · ${esc(s.sys.map((x) => SYS_LABEL[x]).join(' · '))}</span></span><span class="side">${nx ? `<b>${fmt(nx.dep)}</b><span>${esc(nx.trip.head)}</span>` : ''}</span></button>`; }).join('')}</div>`;
  return h;
}
function dist(a, b) { const R = 6371000, r = Math.PI / 180; const h = Math.sin((b[1] - a[1]) * r / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin((b[0] - a[0]) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
function notFound(t) { return `<div class="empty"><span class="art"><svg class="i"><use href="#i-warn"/></svg></span><b>${esc(t)}</b>Coba cari lagi di kolom pencarian.</div>`; }

/* ---------- search ---------- */
const nrm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const matches = (hay, q) => nrm(hay).includes(nrm(q));
function searchView() {
  const q = S.q.trim(); const nq = nrm(q);
  const st = NET.stations.filter((s) => nrm(s.name).includes(nq) || s.id.toLowerCase() === nq).sort((a, b) => nrm(a.name).indexOf(nq) - nrm(b.name).indexOf(nq)).slice(0, 8);
  const ls = NET.lines.filter((l) => matches(l.name + ' ' + l.short + ' ' + (SYS_LABEL[l.sys] || ''), q)).slice(0, 8);
  const d = E.day(clock().date);
  const tr = /^\d/.test(q) ? d.trips.filter((t) => !t.est && t.id.toLowerCase().startsWith(nq.replace(/ /g, ''))).slice(0, 8) : [];
  let h = '';
  if (st.length) h += `<div class="sech"><h2>Stasiun</h2></div><div class="list">${st.map((s) => `<button type="button" class="row" data-open="station:${esc(s.id)}">${dots(s)}<span class="main"><b>${esc(s.name)}</b><span>${esc(s.sys.map((x) => SYS_LABEL[x]).join(' · '))}</span></span></button>`).join('')}</div>`;
  if (ls.length) h += `<div class="sech"><h2>Jalur</h2></div><div class="list">${ls.map((l) => `<button type="button" class="row" data-open="line:${esc(l.id)}">${lb(l)}<span class="main"><b>${esc(l.name)}</b><span>${esc(SYS_LABEL[l.sys])}</span></span></button>`).join('')}</div>`;
  if (tr.length) h += `<div class="sech"><h2>Kereta hari ini</h2></div><div class="list">${tr.map((t) => `<button type="button" class="row" data-open="train:${esc(t.id)}:${t.date}">${lb(lineOf(t.line))}<span class="main"><b>KA ${esc(t.id)} ke ${esc(t.head)}</b><span>${esc(stOf(t.sids[0]).name)} ${fmt(t.start)} → ${fmt(t.end)}</span></span></button>`).join('')}</div>`;
  if (S.placeQ === q && S.places.length) h += `<div class="sech"><h2>Tempat</h2><span>© OpenStreetMap · Photon</span></div><div class="list">${S.places.map((p, i) => `<button type="button" class="row" data-place="${i}"><span class="lb" style="background:#2F7BF6"><svg class="i" style="fill:#fff;width:16px;height:16px"><use href="#i-pin"/></svg></span><span class="main"><b>${esc(p.name)}</b><span>${esc(p.sub)}</span></span></button>`).join('')}</div>`;
  if (!h) h = q.length > 2 && S.placeQ !== q ? `<div class="empty">Mencari…</div>` : `<div class="empty"><b>Tidak ketemu</b>Coba nama stasiun (Manggarai), jalur (Bogor, MRT), nomor KA (1000), atau tempat.</div>`;
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
  const d = S.detail; if (!d) return 'Sepur Live';
  if (d.type === 'station') return stOf(d.id)?.name || 'Stasiun';
  if (d.type === 'line') return lineOf(d.id)?.short ? 'Jalur ' + lineOf(d.id).short : 'Jalur';
  if (d.type === 'train') return 'Kereta';
  return 'Di dekatmu';
}
function render(keep) {
  if (!E) return;
  const top = pbody.scrollTop;
  app.dataset.screen = S.detail ? 'detail' : 'home';
  $('#ptitle').textContent = title();
  document.querySelectorAll('.seg [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  let h;
  if (S.detail) h = { station: stationDetail, line: lineDetail, train: trainDetail, near: nearView }[S.detail.type](S.detail.id);
  else if (S.q.trim() && S.tab === 'peta') h = searchView();
  else h = S.tab === 'jalur' ? linesView() : S.tab === 'stasiun' ? stationsView() : homeView();
  view.innerHTML = h;
  if (keep) pbody.scrollTop = top; else pbody.scrollTop = 0;
  document.title = S.detail ? `${title()} · Sepur Live` : 'Sepur Live · Peta langsung kereta api Indonesia';
}

function open(type, id, extra = {}, push = true) {
  if (type === 'train' && id.includes(':')) { const [a, b] = id.split(':'); id = a; extra.date = b; }
  S.detail = { type, id, ...extra };
  if (type !== 'train') S.follow = false;
  if (type === 'station' || type === 'line') { S.recent = [{ type, id }, ...S.recent.filter((r) => !(r.type === type && r.id === id))].slice(0, 8); LS.set('recent', S.recent); }
  render();
  focusDetail(true);
  writeHash(push);
  sheetTo('half');
  tick();
}
function back(push = true) {
  S.detail = null; S.follow = false;
  if (map?.getSource('route')) map.getSource('route').setData(FC());
  render(); writeHash(push); tick();
}
async function focusDetail(animate) {
  if (!map?.getSource('route')) return;
  const d = S.detail; map.getSource('route').setData(FC());
  const pad = padding();
  if (!d) return;
  if (d.type === 'station') { const s = stOf(d.id); if (s) map.flyTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 13.5), padding: pad, duration: animate ? 900 : 0 }); }
  if (d.type === 'train') { const f = E.find(d.id, clock()); if (f) { const s = E.state(f.trip, f.t); const p = s ? s.p : E.pos(f.trip.sids[0]); map.flyTo({ center: p, zoom: Math.max(map.getZoom(), 12.5), padding: pad, duration: animate ? 900 : 0 }); } }
  if (d.type === 'near' && d.p) map.flyTo({ center: d.p, zoom: 13.5, padding: pad, duration: animate ? 900 : 0 });
  if (d.type === 'line') {
    const l = lineOf(d.id); if (!l) return;
    let coords = [];
    if (l.sched === 'none') {
      try { const g = await getJSON(`/data/routes/${l.id}.json`); map.getSource('route').setData(FC(g.map((c) => ({ type: 'Feature', properties: { color: l.color }, geometry: { type: 'LineString', coordinates: c } })))); coords = g.flat(); } catch {}
    }
    if (!coords.length) coords = [l.stations, ...(l.branches || [])].flat().map((sid) => E.pos(sid));
    const b = coords.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(b, { padding: pad, duration: animate ? 900 : 0, maxZoom: 14 });
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
  if (d?.type === 'train') f.push('train=' + encodeURIComponent(d.id));
  else if (d?.type === 'station') f.push('station=' + encodeURIComponent(d.id));
  else if (d?.type === 'line') f.push('line=' + encodeURIComponent(d.id));
  if (!d && S.tab !== 'peta') f.push('tab=' + S.tab);
  if (S.at) f.push('t=' + fmt(S.at.sec).replace('.', '') + '&d=' + S.at.date);
  if (map) { const c = map.getCenter(); f.push(`@${c.lat.toFixed(5)},${c.lng.toFixed(5)},${map.getZoom().toFixed(1)}`); }
  const url = location.pathname + (f.length ? '#' + f.join('&') : '');
  try { push ? history.pushState(null, '', url) : history.replaceState(null, '', url); } catch {}
}
function readHash(initial) {
  const h = decodeURIComponent(location.hash.slice(1));
  const kv = Object.fromEntries(h.split('&').filter((x) => x.includes('=')).map((x) => x.split('=')));
  const at = h.match(/@(-?[\d.]+),(-?[\d.]+),([\d.]+)/);
  if (at && initial) S.view = { lat: +at[1], lng: +at[2], z: +at[3] };
  if (kv.t && /^\d{3,4}$/.test(kv.t)) {
    const t = kv.t.padStart(4, '0'); const date = /^\d{4}-\d\d-\d\d$/.test(kv.d || '') ? kv.d : jakartaClock().date;
    if (!S.at || initial) S.at = { date, sec: +t.slice(0, 2) * 3600 + +t.slice(2) * 60, wall: Date.now() };
  }
  if (['jalur', 'stasiun'].includes(kv.tab)) S.tab = kv.tab;
  S.detail = kv.train ? { type: 'train', id: kv.train } : kv.station ? { type: 'station', id: kv.station } : kv.line ? { type: 'line', id: kv.line } : null;
}
addEventListener('popstate', () => { readHash(false); render(); focusDetail(true); tick(); });

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
  sheetTo(S.detail ? 'half' : 'peek');
}

/* ---------- UI bindings ---------- */
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 2200); }
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
    <div class="grp">Kereta</div>${row('krl', 'KRL Commuter Line', '#E30A16')}${row('mrt', 'MRT Jakarta', '#CE0037')}${row('lrtj', 'LRT Jakarta', '#F16227')}${row('jbdb', 'LRT Jabodebek', '#20409A')}${row('bandara', 'KA Bandara & Skytrain', '#F2A900')}${row('whoosh', 'Whoosh & feeder', '#8C0023')}${row('regional', 'Commuter daerah (peta saja)', '#3B7A8C')}${row('kai', 'KA antarkota (peta saja)', '#6A2C91')}
    <div class="grp">Peta</div>${row('stations', 'Stasiun')}${row('labels', 'Nama dan kode')}${row('net', 'Jaringan rel OpenStreetMap')}`;
}

async function share() {
  const url = location.href;
  try { if (navigator.share && innerWidth < 760) { await navigator.share({ title: document.title, url }); return; } await navigator.clipboard.writeText(url); toast('Tautan disalin'); } catch { toast('Tautan belum bisa disalin'); }
}

function aboutSheet() {
  const el = $('#about');
  el.innerHTML = `<div class="in"><div class="top"><h2>Tentang Sepur Live</h2><button type="button" class="round" data-act="about-close" aria-label="Tutup"><svg class="i"><use href="#i-x"/></svg></button></div>
  <p>Peta langsung kereta api Indonesia: KRL Commuter Line, MRT Jakarta, LRT Jakarta, LRT Jabodebek, KA Bandara Soekarno-Hatta, dan Whoosh, ditambah jalur KA antarkota dan commuter daerah di Jawa.</p>
  <h3>Dari mana posisi keretanya?</h3>
  <ul><li><b>KRL Commuter Line:</b> jadwal resmi KAI Commuter dari papan keberangkatan publik kci.id, dihimpun oleh <a href="https://github.com/open-krl/pipeline" target="_blank" rel="noopener">Open-KRL</a> (CC-BY 4.0). Hari kerja: capture ${esc(KRL.meta.weekday)}; Sabtu, Minggu, dan libur nasional: capture ${esc(KRL.meta.weekend)}.</li>
  <li><b>MRT, LRT, KA Bandara, Whoosh:</b> perkiraan dari pola frekuensi yang diumumkan operator. Bukan jadwal resmi per kereta, ditandai “Perkiraan”.</li>
  <li><b>KA antarkota & commuter daerah:</b> hanya jalur dan stasiun (OpenStreetMap). Posisi tidak ditampilkan karena jadwalnya belum tersedia sebagai data terbuka.</li>
  <li>Posisi dihitung dari jadwal di atas geometri rel OpenStreetMap. <b>Ini bukan GPS</b>; keterlambatan dan gangguan tidak terlihat.</li></ul>
  <h3>Peta</h3><p>Data peta © kontributor OpenStreetMap (ODbL). Tile vektor dari OpenFreeMap. Pencarian tempat oleh Photon (komoot).</p>
  <h3>Privasi</h3><p>Tidak ada akun, tidak ada pelacakan. Stasiunku, riwayat, dan pilihan lapisan disimpan hanya di browser ini. Lokasi hanya dipakai di perangkatmu untuk mencari stasiun terdekat.</p>
  <p class="credit">Tidak berafiliasi dengan KAI, KAI Commuter, MRT Jakarta, LRT Jakarta, atau KCIC. Kode sumber: <a href="https://github.com/podsni/sepur-live" target="_blank" rel="noopener">github.com/podsni/sepur-live</a> (MIT).</p></div>`;
  el.hidden = false;
}

function bindUI() {
  bindSheet();
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open],[data-act],[data-tab],[data-filter],[data-place],[data-sline]');
    if (!t) { if (e.target.id === 'about') $('#about').hidden = true; return; }
    if (t.dataset.open) { const [type, ...rest] = t.dataset.open.split(':'); open(type, rest.join(':')); return; }
    if (t.dataset.tab) { S.tab = t.dataset.tab; S.detail = null; S.q = ''; $('#q').value = ''; $('#qx').hidden = true; render(); writeHash(true); sheetTo(S.tab === 'peta' ? sheetState : 'half'); tick(); return; }
    if (t.dataset.filter) { S.filter = t.dataset.filter; render(true); tick(); return; }
    if (t.dataset.sline !== undefined) { S.detail.line = t.dataset.sline || null; render(true); return; }
    if (t.dataset.place) { const p = S.places[+t.dataset.place]; S.q = ''; $('#q').value = ''; $('#qx').hidden = true; open('near', 'place', { p: p.p, label: p.name }); return; }
    const a = t.dataset.act;
    if (a === 'back') back();
    else if (a === 'about') aboutSheet();
    else if (a === 'about-close') $('#about').hidden = true;
    else if (a === 'locate') locate();
    else if (a === 'share') share();
    else if (a === 'fit') focusDetail(true);
    else if (a === 'layers-close') { $('#layers').hidden = true; $('#b-layers').setAttribute('aria-pressed', 'false'); }
    else if (a === 'fav') { S.fav = S.fav === S.detail.id ? null : S.detail.id; LS.set('fav', S.fav); toast(S.fav ? 'Disimpan sebagai stasiunku' : 'Stasiunku dilepas'); render(true); }
    else if (a === 'follow') { S.follow = !S.follow; toast(S.follow ? 'Peta ikut bergerak bersama kereta ini' : 'Berhenti mengikuti'); render(true); tick(); }
  });
  document.addEventListener('change', (e) => { const k = e.target.dataset?.layer; if (k) { S.layers[k] = e.target.checked; applyLayers(); tick(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('#about').hidden) $('#about').hidden = true; else if (!$('#layers').hidden) $('#layers').hidden = true; else if (S.detail) back(); } });
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
      if (['net', 'tun', 'route', 'lines-case', 'lines', 'st-c', 'st-l', 'tr-halo', 'tr-c', 'tr-t', 'me', 'b3d'].includes(l.id)) continue;
      const prop = { fill: 'fill-opacity', line: 'line-opacity', symbol: 'text-opacity', background: 'background-opacity', 'fill-extrusion': 'fill-extrusion-opacity' }[l.type];
      if (!prop) continue;
      if (S.ug) { l.__o = map.getPaintProperty(l.id, prop); map.setPaintProperty(l.id, prop, 0.25); } else map.setPaintProperty(l.id, prop, l.__o ?? (prop === 'background-opacity' ? 1 : undefined));
    }
    if (S.ug) { const mrt = lineOf('mrt-ns'); toast('Bawah tanah: terowongan rel ditandai garis putus-putus'); if (!S.detail && mrt) map.flyTo({ center: [106.8225, -6.205], zoom: 13 }); }
  };
  $('#b-layers').onclick = (e) => { const el = $('#layers'); const show = el.hidden; if (show) layersPanel(); el.hidden = !show; e.currentTarget.setAttribute('aria-pressed', String(show)); };
}

boot();
