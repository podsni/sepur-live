// Sepur Live schedule engine.
// Turns timetables (official/planned times) and labelled frequency estimates into
// train positions, station boards, line timetables and journey plans (CSA routing).
// Pure functions, no DOM, so everything here also runs in Node tests.

export const DWELL = 25;      // seconds assumed at an intermediate stop when only departures are known
export const CHANGE = 180;    // minimum time to change trains at the same station (s)
export const WALK_SPEED = 1.1; // m/s between linked stations (interchanges)

const pad = (n) => String(n).padStart(2, '0');

/** Wall clock in Asia/Jakarta (UTC+7, no DST) regardless of device time zone. */
export function jakartaClock(ms = Date.now()) {
  const d = new Date(ms + 7 * 3600e3);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { date, dow: d.getUTCDay(), sec: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() + (ms % 1000) / 1000 };
}
export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** 'weekday' or 'weekend' (Saturday, Sunday and national holidays). */
export function dayType(date, holidays = []) {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  return dow === 0 || dow === 6 || holidays.includes(date) ? 'weekend' : 'weekday';
}
export const fmt = (sec) => {
  sec = ((Math.round(sec / 60) * 60) % 86400 + 86400) % 86400;
  return `${pad(Math.floor(sec / 3600))}.${pad(Math.floor((sec % 3600) / 60))}`;
};
export const dur = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} mnt` : `${Math.floor(m / 60)} j ${pad(m % 60)} mnt`; };

export function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dla = (b[1] - a[1]) * r, dlo = (b[0] - a[0]) * r;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function prepLine(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  return { coords, cum, len: cum[cum.length - 1] };
}
function along(pl, f) {
  const target = Math.max(0, Math.min(1, f)) * pl.len;
  const { cum, coords } = pl;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= target) lo = m; else hi = m; }
  const seg = cum[hi] - cum[lo] || 1, t = (target - cum[lo]) / seg;
  const a = coords[lo], b = coords[hi];
  const k = Math.cos(a[1] * Math.PI / 180);
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing: (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI };
}

// ---------- speed model ----------
// Typical service acceleration/braking (m/s²) per system. The schedule fixes distance (along the OSM track)
// and running time; we fit a trapezoid: accelerate at a from a stop, cruise, brake at a into the next stop.
// Typical cruising speed (m/s) used only to share minute-rounded timetable time sensibly between short legs.
export const VREF = { krl: 19, mrt: 22, lrtj: 17, jbdb: 20, bandara: 22, whoosh: 75, regional: 22, kai: 27 };
// Highest plausible service speed (km/h) per system; shown speeds are clamped to it (timetable rounding artefacts).
export const VMAX = { krl: 100, mrt: 100, lrtj: 70, jbdb: 90, bandara: 100, whoosh: 350, regional: 120, kai: 120 };
export const ACCEL = { krl: 0.7, mrt: 0.9, lrtj: 0.8, jbdb: 0.9, bandara: 0.6, whoosh: 0.45, regional: 0.3, kai: 0.25 };
/** Fit a trapezoidal speed profile for distance D (m) in time T (s); sA/sB = stops at start/end. */
export function motion(D, T, a, sA, sB) {
  const n = (sA ? 1 : 0) + (sB ? 1 : 0);
  if (T <= 0 || D <= 0) return { D, T, vc: 0, ae: a, ta: 0, tb: 0 };
  if (!n) return { D, T, vc: D / T, ae: a, ta: 0, tb: 0 };
  // D = vc*T - vc²*n/(2a)  ->  solve for vc; if the timetable is too tight, raise a so the profile still fits
  const ae = Math.max(a, (n * 2 * D) / (T * T));
  const k = n / (2 * ae), disc = Math.max(0, T * T - 4 * k * D);
  const vc = (T - Math.sqrt(disc)) / (2 * k);
  return { D, T, vc, ae, ta: sA ? vc / ae : 0, tb: sB ? vc / ae : 0 };
}
/** Distance covered (m) and speed (m/s) t seconds into a fitted segment. */
export function moveAt(m, t) {
  const { D, T, vc, ae, ta, tb } = m;
  if (t <= 0) return { s: 0, v: ta ? 0 : vc };
  if (t >= T) return { s: D, v: tb ? 0 : vc };
  if (t < ta) return { s: 0.5 * ae * t * t, v: ae * t };
  if (t > T - tb) { const r = T - t; return { s: D - 0.5 * ae * r * r, v: ae * r }; }
  return { s: 0.5 * ae * ta * ta + vc * (t - ta), v: vc };
}

/** Normalise a packed trip [id, line, head, sids, dep, arr|null, flags|null]. */
export function unpack(p, extra = {}) {
  const [id, line, head, sids, dep, arr0, flags0] = p;
  const n = sids.length;
  const flags = flags0 || new Array(n).fill(1);
  let arr = arr0;
  if (!arr) {
    arr = dep.map((d, i) => (i === 0 ? d : i === n - 1 ? d : Math.max(dep[i - 1] + 1, d - DWELL)));
  }
  return { id, line, head, sids, dep, arr, flags, est: false, ...extra };
}

export class Engine {
  constructor(network, trips, kai = null) {
    this.net = network;
    this.tripsData = trips;
    this.st = new Map(network.stations.map((s) => [s.id, s]));
    this.lines = new Map(network.lines.map((l) => [l.id, l]));
    this.segs = { ...network.segs };
    this.kai = null;
    this.segCache = new Map();
    this.dayCache = new Map();
    this.connCache = new Map();
    if (kai) this.addKai(kai);
  }

  /** Merge the intercity / regional bundle (GAPEKA) loaded after first paint. */
  addKai(kai) {
    this.kai = kai;
    for (const l of kai.lines) this.lines.set(l.id, l);
    Object.assign(this.segs, kai.segs);
    this.dayCache.clear(); this.connCache.clear();
  }
  allLines() { return [...this.lines.values()]; }

  seg(a, b) {
    const k = a + '>' + b;
    let pl = this.segCache.get(k);
    if (pl) return pl;
    const key = a < b ? a + '>' + b : b + '>' + a;
    let c = this.segs[key];
    if (!c) { const A = this.st.get(a), B = this.st.get(b); c = [[A.lng, A.lat], [B.lng, B.lat]]; }
    else if (a > b) c = c.slice().reverse();
    pl = prepLine(c);
    this.segCache.set(k, pl);
    return pl;
  }

  /** Labelled frequency estimate for a line on a day type. */
  freqTrips(line, type) {
    const f = line.freq, out = [];
    const bands = f[type] || [];
    for (const dir of [0, 1]) {
      const sids = dir ? line.stations.slice().reverse() : line.stations.slice();
      const rel = [0];
      for (let i = 1; i < sids.length; i++) rel.push(rel[i - 1] + this.seg(sids[i - 1], sids[i]).len / (f.kmh / 3.6) + (i > 1 ? f.dwell : 0));
      const seen = new Set();
      for (const [s, e, h] of bands) for (let m = s; m < e; m += h) {
        if (seen.has(m)) continue; seen.add(m);
        const t0 = m * 60;
        const dep = rel.map((r) => Math.round(t0 + r));
        out.push(unpack([`${line.short}-${dir ? 'B' : 'A'}${fmt(t0).replace('.', '')}`, line.id, this.st.get(sids.at(-1)).name, sids, dep, null, null], { est: true }));
      }
    }
    return out;
  }

  /** All trips of one service day (cached). */
  day(date) {
    if (this.dayCache.has(date)) return this.dayCache.get(date);
    const type = dayType(date, this.net.holidays);
    const trips = [];
    for (const p of this.tripsData[type] || []) trips.push(unpack(p));
    for (const p of this.tripsData.daily || []) trips.push(unpack(p));
    if (this.kai) for (const p of this.kai.daily) trips.push(unpack(p));
    for (const l of this.lines.values()) {
      if (l.sched === 'frequency' || (l.freqDays && l.freqDays.includes(type))) trips.push(...this.freqTrips(l, type));
    }
    for (const t of trips) { t.start = t.dep[0]; t.end = t.arr[t.arr.length - 1]; t.date = date; t.type = type; t.key = date + '|' + t.id; }
    trips.sort((a, b) => a.start - b.start);
    const byStation = new Map();
    trips.forEach((t) => t.sids.forEach((s, i) => {
      if (!(t.flags[i] & 1)) return;
      if (!byStation.has(s)) byStation.set(s, []);
      byStation.get(s).push([t, i]);
    }));
    const r = { date, type, trips, byStation, byId: new Map(trips.map((t) => [t.id, t])) };
    this.dayCache.set(date, r);
    if (this.dayCache.size > 5) this.dayCache.delete(this.dayCache.keys().next().value);
    return r;
  }

  windows(clock) {
    return [{ d: this.day(clock.date), t: clock.sec }, { d: this.day(addDays(clock.date, -1)), t: clock.sec + 86400 }];
  }

  /** Position/state of a trip at service-day time t, or null if not running. */
  state(trip, t) {
    const { sids, flags } = trip, n = sids.length, { dep, arr } = this.vtimes(trip);
    if (t < dep[0] - 90 || t > arr[n - 1]) return null;
    if (t < dep[0]) return { kind: 'dwell', at: 0, next: 1, p: this.pos(sids[0]), bearing: this.seg(sids[0], sids[1]).len ? along(this.seg(sids[0], sids[1]), 0).bearing : 0, progress: 0 };
    // binary search: last i with dep[i] <= t
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (dep[m] <= t) lo = m; else hi = m - 1; }
    const i = lo;
    if (i >= n - 1) return { kind: 'dwell', at: n - 1, next: null, p: this.pos(sids[n - 1]), bearing: 0, progress: 1 };
    if (t >= arr[i + 1]) return { kind: 'dwell', at: i + 1, next: i + 2 < n ? i + 2 : null, p: this.pos(sids[i + 1]), bearing: 0, progress: (i + 1) / (n - 1), nextStop: this.nextStopIdx(trip, i + 1) };
    const pl = this.seg(sids[i], sids[i + 1]), m = this.segMotion(trip, i);
    const mv = moveAt(m, t - dep[i]);
    const f = pl.len ? mv.s / pl.len : 1;
    const a = along(pl, f);
    return { kind: 'run', from: i, next: i + 1, p: a.p, bearing: a.bearing, progress: (i + f) / (n - 1), nextStop: this.nextStopIdx(trip, i + 1), v: mv.v, vc: m.vc };
  }
  /** Movement timing: the official times, smoothed over windows of >= 10 minutes because timetables are rounded
   * to whole minutes (a 1 km hop "in 35 s" is rounding, not 100+ km/h). Window ends keep their official time;
   * trains do not dwell at stations they pass without stopping. */
  vtimes(trip) {
    if (trip._vt) return trip._vt;
    const { sids, flags } = trip, n = sids.length, A = trip.arr.slice(), P = trip.dep.slice();
    const l = this.lines.get(trip.line) || {}, urban = /^(krl|mrt|lrtj|jbdb|bandara)$/.test(l.sys);
    // urban stops last ~30-40 s; minute-rounded boards often imply a full minute, which would squeeze the running time
    for (let i = 1; i < n - 1; i++) if (!(flags[i] & 1)) A[i] = P[i]; else if (urban) A[i] = Math.max(A[i], P[i] - 40);
    const _l = l, a = this.accelOf(trip), vr = l.id === 'kcic-f' ? VREF.regional : VREF[l.sys] || 20;
    const anchors = [0];
    for (let i = 1; i < n; i++) if (i === n - 1 || A[i] - P[anchors.at(-1)] >= 600) anchors.push(i);
    for (let w = 0; w < anchors.length - 1; w++) {
      const s0 = anchors[w], e = anchors[w + 1];
      if (e - s0 < 2) continue;
      let dwell = 0, ideal = 0; const id = [];
      for (let j = s0; j < e; j++) {
        if (j > s0) dwell += P[j] - A[j];
        const x = this.seg(sids[j], sids[j + 1]).len / vr + ((flags[j] & 1) + (flags[j + 1] & 1)) * (vr / (2 * a));
        id.push(x); ideal += x;
      }
      const R = A[e] - P[s0] - dwell;
      if (R <= 0 || ideal <= 0) continue;
      let t = P[s0];
      for (let j = s0; j < e; j++) {
        const dw = j + 1 < e ? P[j + 1] - A[j + 1] : 0;
        t += (id[j - s0] * R) / ideal;
        if (j + 1 < e) { A[j + 1] = t; t += dw; P[j + 1] = t; }
      }
    }
    return (trip._vt = { dep: P, arr: A });
  }
  accelOf(trip) {
    if (trip._a) return trip._a;
    const l = this.lines.get(trip.line) || {};
    return (trip._a = l.id === 'kcic-f' ? ACCEL.regional : ACCEL[l.sys] || 0.4);
  }
  /** Fitted motion for leg i -> i+1 of a trip (cached on the trip). */
  segMotion(trip, i) {
    const c = trip._m || (trip._m = []);
    if (c[i]) return c[i];
    const pl = this.seg(trip.sids[i], trip.sids[i + 1]);
    const V = this.vtimes(trip);
    return (c[i] = motion(pl.len, V.arr[i + 1] - V.dep[i], this.accelOf(trip), trip.flags[i] & 1, trip.flags[i + 1] & 1));
  }
  /** Speed summary of a whole trip: distance, average (incl. stops), per-leg cruise and a sampled v(t) curve. */
  speedProfile(trip, samples = 240) {
    if (trip._sp) return trip._sp;
    const n = trip.sids.length, legs = [];
    let D = 0, vmax = 0, run = 0;
    for (let i = 0; i < n - 1; i++) {
      const m = this.segMotion(trip, i);
      D += m.D; run += m.T; vmax = Math.max(vmax, m.vc);
      legs.push({ i, D: m.D, T: m.T, avg: m.T > 0 ? m.D / m.T : 0, vmax: m.vc, straight: this.segs[trip.sids[i] < trip.sids[i + 1] ? trip.sids[i] + '>' + trip.sids[i + 1] : trip.sids[i + 1] + '>' + trip.sids[i]] ? false : true });
    }
    const V = this.vtimes(trip), T0 = V.dep[0], T1 = V.arr[n - 1], pts = [];
    for (let k = 0; k <= samples; k++) {
      const t = T0 + ((T1 - T0) * k) / samples;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (V.dep[m] <= t) lo = m; else hi = m - 1; }
      const v = lo >= n - 1 || t >= V.arr[lo + 1] ? 0 : moveAt(this.segMotion(trip, lo), t - V.dep[lo]).v;
      pts.push([t, v]);
    }
    return (trip._sp = { D, T: T1 - T0, run, avg: T1 > T0 ? D / (T1 - T0) : 0, runAvg: run ? D / run : 0, vmax, legs, pts });
  }
  nextStopIdx(trip, i) { for (let k = i; k < trip.sids.length; k++) if (trip.flags[k] & 1) return k; return trip.sids.length - 1; }
  pos(sid) { const s = this.st.get(sid); return [s.lng, s.lat]; }

  /** Trips that may be running around this clock (recompute about once a second). */
  active(clock) {
    const out = [];
    for (const { d, t } of this.windows(clock)) for (const trip of d.trips) {
      if (trip.start - 120 > t) break;
      if (trip.end + 5 >= t) out.push({ trip, off: t - clock.sec });
    }
    return out;
  }
  /** Every train running right now. */
  running(clock, act = this.active(clock)) {
    const out = [];
    for (const a of act) { const t = clock.sec + a.off; const s = this.state(a.trip, t); if (s) out.push({ trip: a.trip, s, t }); }
    return out;
  }

  find(id, clock, date) {
    if (date) { const d = this.day(date); const trip = d.byId.get(id); if (trip) return { trip, t: clock.sec + Math.round((Date.parse(clock.date) - Date.parse(date)) / 864e5) * 86400 }; }
    for (const { d, t } of this.windows(clock)) { const trip = d.byId.get(id); if (trip && trip.end >= t - 1800) return { trip, t }; }
    const trip = this.day(clock.date).byId.get(id);
    return trip ? { trip, t: clock.sec } : null;
  }

  /** Upcoming departures at a station (stops only, excluding trains terminating there). */
  departures(sid, clock, limit = 40, horizon = 6 * 3600) {
    const out = [];
    for (const { d, t } of this.windows(clock)) for (const [trip, i] of d.byStation.get(sid) || []) {
      if (i === trip.sids.length - 1) continue;
      const dep = trip.dep[i];
      if (dep >= t - 30 && dep <= t + horizon) out.push({ trip, i, dep, wait: dep - t });
    }
    out.sort((a, b) => a.wait - b.wait);
    return out.slice(0, limit);
  }

  /** Full service-day timetable of a station, grouped by direction (headsign). */
  stationDay(sid, date) {
    const d = this.day(date), rows = [];
    for (const [trip, i] of d.byStation.get(sid) || []) {
      const last = i === trip.sids.length - 1;
      rows.push({ trip, i, dep: trip.dep[i], arr: trip.arr[i], terminates: last, origin: i === 0 });
    }
    rows.sort((a, b) => a.dep - b.dep);
    const groups = new Map();
    for (const r of rows) {
      const k = r.terminates ? 'Tiba (stasiun akhir)' : r.trip.head;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return { rows, groups: [...groups.entries()].sort((a, b) => b[1].length - a[1].length) };
  }

  /** Timetable grid of a line: one column per trip, one row per station, for one direction. */
  lineGrid(lineId, date, dir = 0) {
    const l = this.lines.get(lineId);
    const order = [...l.stations];
    for (const b of l.branches || []) {
      // put branch-only stations next to the junction they leave from
      const rest = b.filter((s) => !order.includes(s));
      if (!rest.length) continue;
      const firstNew = b.indexOf(rest[0]);
      const jIn = firstNew > 0 ? b[firstNew - 1] : b.find((s) => order.includes(s));
      const at = jIn ? order.indexOf(jIn) : -1;
      const seq = firstNew > 0 ? rest : rest.slice().reverse();
      if (at >= 0) order.splice(at + 1, 0, ...seq); else order.push(...seq);
    }
    const idx = new Map(order.map((s, i) => [s, i]));
    const trips = this.day(date).trips.filter((t) => t.line === lineId).filter((t) => {
      const a = idx.get(t.sids.find((s) => idx.has(s))), b = idx.get(t.sids.findLast((s) => idx.has(s)));
      return a === undefined || b === undefined ? false : dir === 0 ? b >= a : b < a;
    });
    trips.sort((a, b) => a.start - b.start);
    const rows = (dir === 0 ? order : [...order].reverse()).map((s) => ({ sid: s, cells: [] }));
    const rIdx = new Map(rows.map((r, i) => [r.sid, i]));
    trips.forEach((t, c) => {
      t.sids.forEach((s, i) => {
        const r = rIdx.get(s); if (r === undefined) return;
        rows[r].cells[c] = t.flags[i] & 1 ? t.dep[i] : -1; // -1 = passes without stopping
      });
    });
    return { trips, rows: rows.filter((r) => r.cells.some((x) => x !== undefined)) };
  }

  lineSpan(lineId, date) {
    const d = this.day(date); let a = Infinity, b = -Infinity, n = 0;
    for (const t of d.trips) if (t.line === lineId) { n++; a = Math.min(a, t.start); b = Math.max(b, t.start); }
    return n ? { first: a, last: b, count: n } : null;
  }
  nextService(clock) {
    for (const { d, t } of [{ d: this.day(clock.date), t: clock.sec }, { d: this.day(addDays(clock.date, 1)), t: clock.sec - 86400 }])
      for (const trip of d.trips) if (trip.start >= t) return { trip, wait: trip.start - t };
    return null;
  }

  /* ---------------- journey planner: Connection Scan Algorithm ---------------- */

  stationIndex() {
    if (this._sidx) return this._sidx;
    const ids = this.net.stations.map((s) => s.id);
    const idx = new Map(ids.map((s, i) => [s, i]));
    const foot = ids.map(() => []);
    for (const s of this.net.stations) for (const x of s.xfer || []) {
      const o = this.st.get(x); if (!o) continue;
      const w = Math.round(120 + haversine([s.lng, s.lat], [o.lng, o.lat]) * 1.4 / WALK_SPEED);
      foot[idx.get(s.id)].push([idx.get(x), w]);
    }
    return (this._sidx = { ids, idx, foot });
  }

  /** Elementary connections of a service day, shifted by `off` seconds, sorted by departure. */
  connections(date) {
    const k = date + (this.kai ? '+k' : '');
    if (this.connCache.has(k)) return this.connCache.get(k);
    const { idx } = this.stationIndex();
    const out = [];
    for (const [d, off] of [[this.day(addDays(date, -1)), -86400], [this.day(date), 0], [this.day(addDays(date, 1)), 86400]]) {
      for (const t of d.trips) {
        let prev = -1;
        for (let i = 0; i < t.sids.length; i++) {
          if (!(t.flags[i] & 1)) continue;
          if (prev >= 0) out.push({ dep: t.dep[prev] + off, arr: t.arr[i] + off, a: idx.get(t.sids[prev]), b: idx.get(t.sids[i]), trip: t, i: prev, j: i, off });
          prev = i;
        }
      }
    }
    out.sort((x, y) => x.dep - y.dep || x.arr - y.arr);
    this.connCache.set(k, out);
    if (this.connCache.size > 3) this.connCache.delete(this.connCache.keys().next().value);
    return out;
  }

  /** Earliest-arrival journey from `from` to `to` leaving at or after `t0` (seconds of `date`). */
  plan1(from, to, date, t0, maxTransfers = 5) {
    const { idx, foot } = this.stationIndex();
    const A = idx.get(from), B = idx.get(to);
    if (A === undefined || B === undefined || A === B) return null;
    const C = this.connections(date);
    const n = idx.size, INF = 1e12;
    const ready = new Float64Array(n).fill(INF); // earliest time one can board at a station
    const arrive = new Float64Array(n).fill(INF);
    const via = new Array(n);     // {enter, exit} or {walk: fromStation}
    const legs = new Int8Array(n);
    const tripEnter = new Map(); const tripLegs = new Map();
    ready[A] = t0; arrive[A] = t0;
    for (const [x, w] of foot[A]) { if (t0 + w < ready[x]) { ready[x] = t0 + w; arrive[x] = t0 + w; via[x] = { walk: A, w }; } }
    let lo = 0, hi = C.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (C[m].dep < t0) lo = m + 1; else hi = m; }
    for (let c = lo; c < C.length; c++) {
      const k = C[c];
      if (k.dep >= arrive[B]) break;
      if (k.dep > t0 + 36 * 3600) break;
      const key = k.trip.key;
      let entered = tripEnter.has(key);
      if (!entered && ready[k.a] <= k.dep) {
        const nl = legs[k.a] + 1;
        if (nl > maxTransfers + 1) continue;
        tripEnter.set(key, c); tripLegs.set(key, nl); entered = true;
      }
      if (!entered) continue;
      if (k.arr < arrive[k.b]) {
        arrive[k.b] = k.arr;
        ready[k.b] = Math.min(ready[k.b], k.arr + CHANGE);
        via[k.b] = { enter: tripEnter.get(key), exit: c };
        legs[k.b] = tripLegs.get(key);
        for (const [x, w] of foot[k.b]) {
          if (k.arr + w < ready[x]) { ready[x] = k.arr + w; if (k.arr + w < arrive[x]) { arrive[x] = k.arr + w; via[x] = { walk: k.b, w }; legs[x] = legs[k.b]; } }
        }
      }
    }
    if (arrive[B] >= INF) return null;
    // reconstruct
    const out = []; let s = B, guard = 0;
    while (s !== A && guard++ < 50) {
      const v = via[s]; if (!v) return null;
      if (v.walk !== undefined) { out.push({ walk: true, from: this.stationIndex().ids[v.walk], to: this.stationIndex().ids[s], dur: v.w }); s = v.walk; continue; }
      const e = C[v.enter], x = C[v.exit];
      out.push({ trip: e.trip, i: e.i, j: x.j, dep: e.dep, arr: x.arr, off: e.off, from: this.stationIndex().ids[e.a], to: this.stationIndex().ids[x.b] });
      s = e.a;
    }
    out.reverse();
    // timing for walking legs
    let t = t0;
    for (const l of out) {
      if (l.walk) { l.dep = t; l.arr = t + l.dur; t = l.arr; } else t = l.arr;
    }
    for (let i = 0; i < out.length; i++) if (out[i].walk) {
      const nx = out[i + 1]; if (nx && !nx.walk) { l2(out[i], nx); }
    }
    function l2(w, nx) { w.arr = Math.min(w.arr, nx.dep); w.dep = w.arr - w.dur; }
    const rides = out.filter((l) => !l.walk);
    if (!rides.length) return null;
    return { legs: out, dep: rides[0].dep, arr: rides.at(-1).arr, transfers: rides.length - 1, date };
  }

  /** Up to `n` alternatives leaving at successive times. */
  plan(from, to, date, t0, n = 4) {
    const res = []; let t = t0; const seen = new Set();
    for (let k = 0; k < 30 && res.length < n * 2; k++) {
      const j = this.plan1(from, to, date, t);
      if (!j) break;
      const sig = j.legs.filter((l) => !l.walk).map((l) => l.trip.key + l.i + '-' + l.j).join(',');
      if (!seen.has(sig)) {
        seen.add(sig);
        // drop journeys that are dominated (leave earlier/same and arrive later than a previous one)
        if (!res.some((r) => r.arr <= j.arr && r.dep >= j.dep)) res.push(j);
      }
      t = j.dep + 60;
    }
    // keep only journeys not beaten by another that leaves later (or same) and arrives earlier (or same)
    return res.filter((r) => !res.some((o) => o !== r && o.dep >= r.dep && o.arr <= r.arr && (o.dep > r.dep || o.arr < r.arr))).slice(0, n);
  }
}
