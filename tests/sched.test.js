import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine, jakartaClock, dayType, fmt, motion, moveAt } from '../src/sched.js';

const rd = (f) => JSON.parse(readFileSync(new URL('../public/data/' + f, import.meta.url)));
const net = rd('network.json'), trips = rd('trips.json'), kai = rd('kai.json');
const E = new Engine(net, trips, kai);
const at = (date, hh, mm) => ({ date, dow: new Date(date).getUTCDay(), sec: hh * 3600 + mm * 60 });
const D = '2026-11-19';

test('Jakarta clock is UTC+7', () => {
  const c = jakartaClock(Date.UTC(2026, 10, 18, 19, 30, 0));
  assert.equal(c.date, D);
  assert.equal(c.sec, 2 * 3600 + 30 * 60);
});

test('day types follow weekend and holidays', () => {
  assert.equal(dayType(D, net.holidays), 'weekday');
  assert.equal(dayType('2026-11-21', net.holidays), 'weekend');
  assert.equal(dayType('2026-12-25', net.holidays), 'weekend');
});

test('data has the expected systems and real timetables', () => {
  for (const id of ['krl-b', 'krl-c', 'krl-r', 'krl-t', 'krl-tp', 'mrt-ns', 'lrtj-s', 'lrtjb-cb', 'lrtjb-bk', 'ka-bst', 'kcic', 'apcgk', 'kcic-f'])
    assert.ok(E.lines.get(id), id);
  assert.equal(E.lines.get('mrt-ns').sched, 'timetable');
  assert.equal(E.lines.get('kcic').sched, 'frequency');
  assert.ok(kai.lines.length > 80 && kai.daily.length > 500);
});

test('KRL train 1000 follows the real planned board times', () => {
  const t = E.day(D).byId.get('1000');
  assert.equal(t.sids[0], 'MRI');
  assert.equal(fmt(t.dep[0]), '05.10');
  assert.equal(E.state(t, t.dep[0] + 60).kind, 'run');
});

test('intercity GAPEKA train Argo Semeru 5 leaves Surabaya Gubeng 09.00', () => {
  const t = E.day(D).byId.get('KA 5');
  assert.equal(t.sids[0], 'SGU');
  assert.equal(fmt(t.dep[0]), '09.00');
  assert.ok(t.flags.some((f) => !(f & 1)), 'has passing points');
});

test('rush hour has hundreds of trains, 02:30 has only overnight intercity', () => {
  const rush = E.running(at(D, 7, 30));
  assert.ok(rush.length > 200, `rush ${rush.length}`);
  const night = E.running(at(D, 2, 30));
  assert.ok(night.every((r) => E.lines.get(r.trip.line).sys === 'kai' || E.lines.get(r.trip.line).sys === 'regional'));
});

test('positions are finite and headings exist', () => {
  for (const r of E.running(at(D, 8, 0))) {
    assert.ok(Number.isFinite(r.s.p[0]) && Number.isFinite(r.s.p[1]), r.trip.id);
    assert.ok(Number.isFinite(r.s.bearing), r.trip.id);
  }
});

test('positions move continuously (no jumps > 200 m per second)', () => {
  const t = E.day(D).byId.get('1000');
  let prev = null;
  for (let s = t.dep[0]; s < t.arr.at(-1); s += 1) {
    const st = E.state(t, s); if (!st) continue;
    if (prev) {
      const dx = (st.p[0] - prev[0]) * 111320 * Math.cos(st.p[1] * Math.PI / 180), dy = (st.p[1] - prev[1]) * 110540;
      assert.ok(Math.hypot(dx, dy) < 200, `jump at ${fmt(s)}`);
    }
    prev = st.p;
  }
});

test('station board and full-day timetable', () => {
  const deps = E.departures('MRI', at(D, 17, 0));
  assert.ok(deps.length > 10);
  for (let i = 1; i < deps.length; i++) assert.ok(deps[i].wait >= deps[i - 1].wait);
  const day = E.stationDay('MRI', D);
  assert.ok(day.rows.length > 300, 'Manggarai has hundreds of departures');
  assert.ok(day.groups.length > 3);
});

test('line timetable grid', () => {
  const g = E.lineGrid('krl-b', D, 0);
  assert.ok(g.trips.length > 100 && g.rows.length >= 20);
  const g2 = E.lineGrid('mrt-ns', D, 1);
  assert.ok(g2.trips.length > 100);
});

test('journey planner: Bogor to Bandara Soekarno-Hatta needs a transfer', () => {
  const j = E.plan('BOO', 'BST', D, 7 * 3600);
  assert.ok(j.length >= 2, 'alternatives');
  const first = j[0];
  assert.ok(first.transfers >= 1);
  assert.equal(first.legs.find((l) => !l.walk).from, 'BOO');
  assert.equal(first.legs.filter((l) => !l.walk).at(-1).to, 'BST');
  for (let i = 1; i < first.legs.length; i++) assert.ok(first.legs[i].dep >= first.legs[i - 1].arr - 1, 'legs in order');
  assert.ok(first.arr - first.dep < 4 * 3600);
});

test('journey planner: Jakarta to Surabaya by intercity', () => {
  const j = E.plan('GMR', 'SGU', D, 6 * 3600, 2);
  assert.ok(j.length >= 1);
  assert.ok(j[0].legs.some((l) => !l.walk && E.lines.get(l.trip.line).sys === 'kai'));
});

test('journey planner: MRT to LRT via interchange', () => {
  const mrt = E.lines.get('mrt-ns').stations[0], lrt = E.lines.get('lrtjb-bk').stations[0];
  const j = E.plan(E.lines.get('mrt-ns').stations.at(-1), lrt, D, 9 * 3600, 1);
  assert.ok(j.length === 1 && j[0].arr > j[0].dep, `${mrt}->${lrt}`);
});

test('speed profile: trapezoid covers the distance in the scheduled time', () => {
  const m = motion(2000, 150, 0.7, 1, 1);
  assert.ok(Math.abs(moveAt(m, 150).s - 2000) < 1e-6 && moveAt(m, 0).v === 0 && moveAt(m, 150).v === 0);
  assert.ok(Math.abs(moveAt(m, 75).v - m.vc) < 1e-9 && m.vc > 2000 / 150);
  let prev = -1; for (let t = 0; t <= 150; t += 5) { const s = moveAt(m, t).s; assert.ok(s >= prev); prev = s; }
  const tight = motion(3000, 60, 0.3, 1, 1); // too tight for 0.3 m/s²: acceleration is raised, distance still fits
  assert.ok(Math.abs(moveAt(tight, 60).s - 3000) < 1e-6);
});

test('speed estimates are plausible: Argo Semeru ~80 km/h average, KRL under 100 km/h', () => {
  const d = E.day(D);
  const a = E.speedProfile(d.byId.get('KA 5'));
  assert.ok(a.D > 700e3 && a.D < 900e3, 'track distance Surabaya–Jakarta');
  assert.ok(a.avg * 3.6 > 60 && a.avg * 3.6 < 100 && a.vmax * 3.6 <= 125);
  const k = E.speedProfile(d.byId.get('1000'));
  assert.ok(k.vmax * 3.6 < 100 && k.avg * 3.6 > 25);
  const s = E.state(d.byId.get('KA 5'), 10 * 3600);
  assert.equal(s.kind, 'run'); assert.ok(s.v * 3.6 > 40 && s.v * 3.6 < 125);
});

test('level crossings: next trains passing a point between Manggarai and Sudirman', () => {
  const J = rd('jpl.json');
  assert.ok(J.v === 2 && J.x.length > 3000 && J.stats.palang + J.stats.jaga > 200, 'OSM crossings extracted');
  const x = J.x.find((r) => r[3] !== 'fly' && r[3] !== 'under' && (r[8] === 'MRI' && r[9] === 'SUD') || (r[8] === 'SUD' && r[9] === 'MRI'));
  assert.ok(x, 'a crossing snapped to the MRI–SUD section');
  const ps = E.passes(x[8], x[9], x[10], at(D, 8, 0));
  assert.ok(ps.length >= 3, 'trains pass in the morning');
  assert.ok(ps.every((p, i) => p.dt >= -60 && p.dt <= 3 * 3600 && (i === 0 || p.dt >= ps[i - 1].dt)));
  // the passing time lies between the scheduled departure and arrival of that leg
  for (const p of ps) { const i = p.trip.sids.findIndex((s, k) => (s === x[8] || s === x[9]) && (p.trip.sids[k + 1] === x[8] || p.trip.sids[k + 1] === x[9])); assert.ok(p.at >= p.trip.dep[i] - 61 && p.at <= p.trip.arr[i + 1] + 61); }
});

test('level crossings v2: cleaned, statuses, km and Daop estimates, photos with licence', () => {
  const J = rd('jpl.json');
  const CATS = new Set(['jaga', 'oto', 'palang', 'sinyal', 'tdk', 'liar', 'tutup', 'ped', 'unk', 'fly', 'under']);
  assert.ok(J.x.every((r) => CATS.has(r[3])), 'known status');
  assert.ok(J.clean.merged_duplicates > 500 && J.clean.drop_inactive_track > 0, 'cleaning stats recorded');
  const lc = J.x.filter((r) => r[3] !== 'fly' && r[3] !== 'under');
  // no two level crossings closer than 8 m (multi-track duplicates merged)
  const R = 6371000, d = (a, b) => { const r = Math.PI / 180; const h = Math.sin((b[2] - a[2]) * r / 2) ** 2 + Math.cos(a[2] * r) * Math.cos(b[2] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const g = new Map(); let close = 0;
  for (const r of lc) { const k = Math.floor(r[1] / 0.001) + ':' + Math.floor(r[2] / 0.001); (g.get(k) || g.set(k, []).get(k)).push(r); }
  for (const r of lc) { const gx = Math.floor(r[1] / 0.001), gy = Math.floor(r[2] / 0.001); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const q of g.get(gx + dx + ':' + (gy + dy)) || []) if (q !== r && d(q, r) < 7) close++; }
  assert.equal(close, 0, 'duplicates merged');
  assert.ok(J.x.filter((r) => r[3] === 'fly').length > 100 && J.x.filter((r) => r[3] === 'under').length > 100, 'grade separations detected');
  const km = lc.filter((r) => r[12]); assert.ok(km.length > lc.length * 0.7 && km.every((r) => /^\d+\+\d{3}$/.test(r[12])), 'km estimates');
  const braga = lc.find((r) => r[6] === 'Jalan Braga'); assert.ok(braga && Math.abs(parseFloat(braga[12].replace('+', '.')) - 155.9) < 0.3, 'Braga at km ~155+9');
  assert.ok(lc.filter((r) => r[15]).length > lc.length * 0.9 && lc.every((r) => !r[15] || /^(Daop|Divre) \d$/.test(r[15])), 'Daop');
  assert.ok(Object.keys(J.daop).length >= 9);
  for (const p of J.photos) { assert.ok(/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(p[1]) && p[4] && p[5] && p[8] <= 60, 'photo with author, licence, <= 60 m'); }
  assert.ok(J.x.every((r) => r[19] < J.photos.length));
});
test('station extras: photos with licence, Daop and km', () => {
  const X = rd('stations_x.json');
  const s = Object.values(X.s);
  assert.ok(s.filter((v) => v.img).length / s.length > 0.85, 'photo coverage > 85%');
  assert.ok(s.every((v) => !v.img || (/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(v.img.t) && v.img.a && v.img.l)));
  assert.equal(X.s.CN.daop, 'Daop 3'); assert.equal(X.s.KYA.daop, 'Daop 5');
  assert.ok(Math.abs(X.s.CN.km[0][0] - 219.168) < 0.001);
});

test('train trail follows the track behind the head, across sections', async () => {
  const { haversine } = await import('../src/sched.js');
  const c = at(D, 7, 30);
  let n = 0, multi = 0;
  for (const r of E.running(c).slice(0, 120)) {
    const tr = E.trail(r.trip, r.s, 240);
    assert.ok(tr.pts.length >= 2 && tr.pts.length === tr.cum.length, 'trail has points');
    assert.ok(Math.abs(tr.cum[tr.cum.length - 1] - 240) < 1, `trail length ${tr.cum[tr.cum.length - 1]}`);
    assert.ok(haversine(tr.pts[0], r.s.p) < 1, 'trail starts at the train position');
    for (let i = 1; i < tr.pts.length; i++) assert.ok(Math.abs(tr.cum[i] - tr.cum[i - 1] - haversine(tr.pts[i - 1], tr.pts[i])) < 0.5 || i === tr.pts.length - 1, 'cum matches geometry');
    if (r.s.kind === 'run' && r.s.d < 200 && r.s.from > 0) multi++;
    n++;
  }
  assert.ok(n > 50 && multi > 0, `checked ${n} trails, ${multi} reach into the previous section`);
});

test('rolling stock: typical formations per line, car features with cab ends', async () => {
  const { STOCK, stockKey } = await import('../src/stock.js');
  const L = (id) => E.lines.get(id);
  assert.equal(stockKey(L('krl-b')), 'krl12'); assert.equal(STOCK.krl12.cars.length, 12);
  assert.equal(stockKey(L('mrt-ns')), 'mrt'); assert.equal(STOCK.mrt.cars.length, 6);
  assert.equal(stockKey(L('lrtj-s')), 'lrtj'); assert.equal(STOCK.lrtj.cars.length, 2);
  assert.equal(stockKey(L('lrtjb-cb')), 'jbdb'); assert.equal(STOCK.jbdb.cars.length, 6);
  assert.equal(stockKey(L('kcic')), 'whoosh'); assert.equal(STOCK.whoosh.cars.length, 8);
  assert.equal(stockKey(L('ka-bst')), 'ea203'); assert.equal(stockKey(L('apcgk')), 'sky');
  assert.equal(stockKey(L('krl-lm')), 'lokal', 'Merak line is diesel-hauled');
  assert.equal(stockKey(L('g-argo-semeru')), 'argo'); assert.ok(STOCK.argo.cars[0].loco);
  assert.equal(stockKey(L('g-taksaka')), 'ka');
});

test('KA barang: real GAPEKA freight paths, never in the journey planner', async () => {
  const fr = rd('freight.json');
  const F = new Engine(net, trips, kai); F.addFreight(fr);
  assert.equal(fr.daily.length, 114);
  assert.deepEqual(fr.cats, { cargo: 34, tanker: 48, parcel: 6, service: 24, trans: 2 });
  for (const l of fr.lines) { assert.equal(l.sys, 'barang'); assert.ok(['cargo', 'tanker', 'parcel', 'service', 'trans'].includes(l.cat), l.id); }
  // Betmakola Tanker KA 2627 (Benteng -> Malang Kota Lama) as printed in GAPEKA 2026
  const d = F.day(D), t = d.byId.get('KA 2627');
  assert.ok(t && t.freight && t.line === 'f-betmakola-tanker');
  assert.equal(t.sids[0], 'SBE'); assert.equal(t.sids.at(-1), 'MLK');
  // freight network.json is untouched: freight-only stations live in the bundle
  for (const s of fr.stations) assert.ok(!net.stations.some((x) => x.id === s.id), s.id);
  // planner: no connection uses a freight trip
  assert.ok(!F.connections(D).some((c) => c.trip.freight));
  // boards hide freight unless switched on, then show it
  const sid = 'TPK', c = at(D, 0, 0);
  const anyFr = (on) => { F.freightOn = on; return F.stationDay(sid, D).rows.some((r) => r.trip.freight); };
  assert.equal(anyFr(null), false);
  assert.equal(anyFr(() => true), true);
  assert.equal(anyFr((l) => l.cat === 'tanker'), false); // commodity filter: no tanker trains at Tanjung Priuk
  F.freightOn = () => true;
  assert.ok(F.departures(sid, { ...c, sec: 0 }, 400, 86400).some((x) => x.trip.freight));
  // freight is drawn with a freight formation
  const { stockKey, STOCK } = await import('../src/stock.js');
  assert.equal(stockKey(F.lines.get('f-betmakola-tanker')), 'ftanker');
  assert.equal(stockKey(F.lines.get('f-kenlimas-cargo')), 'fcargo');
  assert.ok(STOCK.ftanker.freight && STOCK.ftanker.cars.length > 10);
  // OSM freight places near the end stations (hint only): Gamao tanker ends next to the Pertamina depot at Larangan
  assert.ok(F.lines.get('f-gamao-tanker').near.some((n) => n[0] === 'fuel' && /Pertamina/.test(n[1]) && n[3] === 'Larangan'));
  const term = rd('terminals.json'); assert.ok(term.x.length > 50 && term.x.every((r) => ['fuel', 'cargo', 'yard'].includes(r[2])));
  // level crossings: freight shows in the next trains passing (when switched on)
  const J = rd('jpl.json'), c10 = at(D, 10, 0);
  const r = J.x.find((x) => x[8] === 'JRK' && x[9] === 'SMC');
  assert.ok(r && F.passes(r[8], r[9], r[10], c10, 3 * 3600, 6).some((p) => p.trip.freight));
  F.freightOn = null; assert.ok(!F.passes(r[8], r[9], r[10], c10, 3 * 3600, 6).some((p) => p.trip.freight)); F.freightOn = () => true;
  // speeds stay within the GAPEKA speed limit of the train
  const sp = F.speedProfile(t); assert.ok(sp.avg * 3.6 > 15 && sp.avg * 3.6 < 70, String(sp.avg * 3.6));
});
