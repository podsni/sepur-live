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
  assert.ok(J.x.length > 5000 && J.stats.bar > 300, 'OSM crossings extracted');
  const x = J.x.find((r) => (r[8] === 'MRI' && r[9] === 'SUD') || (r[8] === 'SUD' && r[9] === 'MRI'));
  assert.ok(x, 'a crossing snapped to the MRI–SUD section');
  const ps = E.passes(x[8], x[9], x[10], at(D, 8, 0));
  assert.ok(ps.length >= 3, 'trains pass in the morning');
  assert.ok(ps.every((p, i) => p.dt >= -60 && p.dt <= 3 * 3600 && (i === 0 || p.dt >= ps[i - 1].dt)));
  // the passing time lies between the scheduled departure and arrival of that leg
  for (const p of ps) { const i = p.trip.sids.findIndex((s, k) => (s === x[8] || s === x[9]) && (p.trip.sids[k + 1] === x[8] || p.trip.sids[k + 1] === x[9])); assert.ok(p.at >= p.trip.dep[i] - 61 && p.at <= p.trip.arr[i + 1] + 61); }
});
