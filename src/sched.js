// Sepur Live schedule engine: turns timetables (KRL, real planned times) and
// frequency patterns (other systems, approximations) into train positions.
// Pure functions, no DOM, so it runs in Node tests too.

export const DWELL = 25; // seconds a train is assumed to stand at an intermediate station

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

function haversine(a, b) {
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
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing: Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI };
}

// smooth acceleration / braking between stations
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export class Engine {
  constructor(network, krl) {
    this.net = network;
    this.krl = krl;
    this.st = new Map(network.stations.map((s) => [s.id, s]));
    this.lines = new Map(network.lines.map((l) => [l.id, l]));
    this.segCache = new Map();
    this.dayCache = new Map();
  }

  seg(a, b) {
    const k = a + '>' + b;
    let pl = this.segCache.get(k);
    if (pl) return pl;
    const key = a < b ? a + '>' + b : b + '>' + a;
    let c = this.net.segs[key];
    if (!c) {
      const A = this.st.get(a), B = this.st.get(b);
      c = [[A.lng, A.lat], [B.lng, B.lat]];
    } else if (a > b) c = c.slice().reverse();
    pl = prepLine(c);
    this.segCache.set(k, pl);
    return pl;
  }

  /** Generate trips for one frequency-pattern line on a day type. Times in service-day seconds. */
  freqTrips(line, type) {
    const f = line.freq, out = [];
    const bands = f[type] || f.weekday;
    for (const dir of [0, 1]) {
      const sids = dir ? line.stations.slice().reverse() : line.stations.slice();
      const rel = [0];
      for (let i = 1; i < sids.length; i++) {
        const run = this.seg(sids[i - 1], sids[i]).len / (f.kmh / 3.6);
        rel.push(rel[i - 1] + run + (i > 1 ? f.dwell : 0));
      }
      const seen = new Set();
      for (const [s, e, h] of bands) {
        for (let m = s; m < e; m += h) {
          if (seen.has(m)) continue;
          seen.add(m);
          const t0 = m * 60;
          const id = `${line.short}-${dir ? 'B' : 'A'}${fmt(t0).replace('.', '')}`;
          out.push({ id, line: line.id, head: this.st.get(sids[sids.length - 1]).name, sids, times: rel.map((r) => Math.round(t0 + r)), est: true });
        }
      }
    }
    return out;
  }

  /** All trips of a service day (cached). */
  day(date) {
    if (this.dayCache.has(date)) return this.dayCache.get(date);
    const type = dayType(date, this.net.holidays);
    const trips = [];
    for (const [id, line, head, sids, times] of this.krl[type] || []) trips.push({ id, line, head, sids, times, est: false });
    for (const l of this.net.lines) if (l.sched === 'frequency') trips.push(...this.freqTrips(l, type));
    for (const t of trips) { t.start = t.times[0]; t.end = t.times[t.times.length - 1]; t.date = date; t.type = type; }
    trips.sort((a, b) => a.start - b.start);
    const byStation = new Map();
    trips.forEach((t) => t.sids.forEach((s, i) => {
      if (!byStation.has(s)) byStation.set(s, []);
      byStation.get(s).push([t, i]);
    }));
    const r = { date, type, trips, byStation, byId: new Map(trips.map((t) => [t.id, t])) };
    this.dayCache.set(date, r);
    if (this.dayCache.size > 4) this.dayCache.delete(this.dayCache.keys().next().value);
    return r;
  }

  /** Service days that can have a train running at this clock: today and yesterday's after-midnight runs. */
  windows(clock) {
    return [{ d: this.day(clock.date), t: clock.sec }, { d: this.day(addDays(clock.date, -1)), t: clock.sec + 86400 }];
  }

  /** State of a trip at service-day time t, or null if not running. */
  state(trip, t) {
    const { times, sids } = trip;
    if (t < times[0] - 60 || t > times[times.length - 1]) return null;
    if (t < times[0]) return { kind: 'dwell', at: 0, next: 1, p: this.pos(sids[0]), bearing: 0, progress: 0 };
    for (let i = 0; i < times.length - 1; i++) {
      const dep = times[i], arr = times[i + 1] - (i + 1 < times.length - 1 ? DWELL : 0);
      if (t < dep) return { kind: 'dwell', at: i, next: i + 1, p: this.pos(sids[i]), bearing: 0, progress: i / (times.length - 1) };
      if (t <= arr) {
        const f = arr > dep ? ease((t - dep) / (arr - dep)) : 1;
        const a = along(this.seg(sids[i], sids[i + 1]), f);
        return { kind: 'run', from: i, next: i + 1, p: a.p, bearing: a.bearing, progress: (i + f) / (times.length - 1) };
      }
    }
    const last = times.length - 1;
    return { kind: 'dwell', at: last, next: null, p: this.pos(sids[last]), bearing: 0, progress: 1 };
  }

  pos(sid) { const s = this.st.get(sid); return [s.lng, s.lat]; }

  /** Every train running right now. */
  running(clock) {
    const out = [];
    for (const { d, t } of this.windows(clock)) {
      for (const trip of d.trips) {
        if (trip.start - 60 > t) break;
        if (trip.end < t) continue;
        const s = this.state(trip, t);
        if (s) out.push({ trip, s, t });
      }
    }
    return out;
  }

  find(id, clock) {
    for (const { d, t } of this.windows(clock)) {
      const trip = d.byId.get(id);
      if (trip && trip.end >= t - 1800) return { trip, t };
    }
    const trip = this.day(clock.date).byId.get(id);
    return trip ? { trip, t: clock.sec } : null;
  }

  /** Upcoming departures at a station (excluding trains terminating there). */
  departures(sid, clock, limit = 40) {
    const out = [];
    for (const { d, t } of this.windows(clock)) {
      for (const [trip, i] of d.byStation.get(sid) || []) {
        if (i === trip.sids.length - 1) continue;
        const dep = trip.times[i];
        if (dep >= t - 30 && dep <= t + 6 * 3600) out.push({ trip, i, dep, wait: dep - t });
      }
    }
    out.sort((a, b) => a.wait - b.wait);
    return out.slice(0, limit);
  }

  /** First/last departure of a line on a day type. */
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
}
