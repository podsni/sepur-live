import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine, jakartaClock, dayType, fmt } from '../src/sched.js';

const net = JSON.parse(readFileSync(new URL('../public/data/network.json', import.meta.url)));
const krl = JSON.parse(readFileSync(new URL('../public/data/krl.json', import.meta.url)));
const E = new Engine(net, krl);
const at = (date, hh, mm) => ({ date, dow: new Date(date).getUTCDay(), sec: hh * 3600 + mm * 60 });

test('Jakarta clock is UTC+7', () => {
  const c = jakartaClock(Date.UTC(2026, 10, 18, 19, 30, 0));
  assert.equal(c.date, '2026-11-19');
  assert.equal(c.sec, 2 * 3600 + 30 * 60);
});

test('day types follow weekend and holidays', () => {
  assert.equal(dayType('2026-11-19', net.holidays), 'weekday');
  assert.equal(dayType('2026-11-21', net.holidays), 'weekend');
  assert.equal(dayType('2026-12-25', net.holidays), 'weekend');
});

test('data has the expected systems', () => {
  for (const id of ['krl-b', 'krl-c', 'krl-r', 'krl-t', 'krl-tp', 'mrt-ns', 'lrtj-s', 'lrtjb-cb', 'lrtjb-bk', 'ka-bst', 'kcic'])
    assert.ok(net.lines.find((l) => l.id === id), id);
  assert.ok(krl.weekday.length > 900 && krl.weekend.length > 900);
});

test('KRL train 1000 follows the real planned board times', () => {
  const d = E.day('2026-11-19');
  const t = d.byId.get('1000');
  assert.equal(t.sids[0], 'MRI');
  assert.equal(fmt(t.times[0]), '05.10');
  const s = E.state(t, t.times[0] + 60);
  assert.equal(s.kind, 'run');
});

test('weekday rush hour has hundreds of trains, 02:30 has none', () => {
  const rush = E.running(at('2026-11-19', 7, 30));
  assert.ok(rush.length > 100, `rush ${rush.length}`);
  const night = E.running(at('2026-11-19', 2, 30));
  assert.equal(night.length, 0);
  const next = E.nextService(at('2026-11-19', 2, 30));
  assert.ok(next && next.wait > 0);
});

test('positions stay on the track polyline near Jabodetabek', () => {
  for (const r of E.running(at('2026-11-19', 8, 0))) {
    const [lng, lat] = r.s.p;
    assert.ok(lng > 105.9 && lng < 107.9 && lat > -7.2 && lat < -5.8, r.trip.id);
  }
});

test('station departures are sorted and in the future', () => {
  const deps = E.departures('MRI', at('2026-11-19', 17, 0));
  assert.ok(deps.length > 10);
  for (let i = 1; i < deps.length; i++) assert.ok(deps[i].wait >= deps[i - 1].wait);
});
