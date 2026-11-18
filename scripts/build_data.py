#!/usr/bin/env python3
"""Build Sepur Live data files from public sources.

Inputs (see README "Data pipeline"):
  --osm   osm_rail.json produced by scripts/extract_osm.py from a Geofabrik Java .osm.pbf (ODbL)
  --krl   path to a clone of https://github.com/open-krl/pipeline (CC-BY 4.0 timetable data)
Outputs:
  public/data/network.json   lines, stations, track segments, tunnels, background rail network
  public/data/krl.json       KRL Commuter Line trips (planned times from KCI station boards via Open-KRL)
"""
import json, glob, csv, math, heapq, re, argparse, datetime, os, collections

ap = argparse.ArgumentParser()
ap.add_argument('--osm', required=True)
ap.add_argument('--krl', required=True)
ap.add_argument('--version', default='2')
ap.add_argument('--weekday', default='7')
ap.add_argument('--weekend', default='6')
ap.add_argument('--out', default='public/data')
A = ap.parse_args()

def hav(a, b):
    R = 6371000.0
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dla = la2 - la1; dlo = math.radians(b[0] - a[0])
    h = math.sin(dla/2)**2 + math.cos(la1)*math.cos(la2)*math.sin(dlo/2)**2
    return 2*R*math.asin(math.sqrt(h))

def rdp(pts, eps=4.0):
    if len(pts) < 3: return pts
    # perpendicular distance in local meters
    lat0 = math.radians(pts[0][1]); kx = 111320*math.cos(lat0); ky = 110540
    P = [((p[0]-pts[0][0])*kx, (p[1]-pts[0][1])*ky) for p in pts]
    keep = [False]*len(pts); keep[0] = keep[-1] = True
    st = [(0, len(pts)-1)]
    while st:
        i, j = st.pop()
        ax, ay = P[i]; bx, by = P[j]; dx, dy = bx-ax, by-ay; L = dx*dx+dy*dy
        best, bi = -1, -1
        for k in range(i+1, j):
            px, py = P[k]
            if L == 0: d = math.hypot(px-ax, py-ay)
            else:
                t = max(0, min(1, ((px-ax)*dx+(py-ay)*dy)/L))
                d = math.hypot(px-ax-t*dx, py-ay-t*dy)
            if d > best: best, bi = d, k
        if best > eps:
            keep[bi] = True; st += [(i, bi), (bi, j)]
    return [p for p, k in zip(pts, keep) if k]

R5 = lambda p: [round(p[0], 5), round(p[1], 5)]
norm = lambda s: re.sub(r'[^a-z0-9]', '', (s or '').lower().replace('stasiun', ''))

osm = json.load(open(A.osm))
loc = {int(k): tuple(v) for k, v in osm['loc'].items()}
ways = {int(k): v for k, v in osm['ways'].items()}

# ---------- rail graphs per mode ----------
def mode_of(t):
    r = t.get('railway')
    if r == 'construction': return None
    if r == 'subway': return 'subway'
    if r in ('light_rail', 'monorail'): return 'light_rail'
    if t.get('highspeed') == 'yes': return 'hs'
    return 'rail'
G = collections.defaultdict(lambda: collections.defaultdict(dict))
for wid, w in ways.items():
    m = mode_of(w['tags'])
    if not m: continue
    n = [x for x in w['n'] if x in loc]
    for a, b in zip(n, n[1:]):
        d = hav(loc[a], loc[b])
        G[m][a][b] = d; G[m][b][a] = d
node_list = {m: list(G[m].keys()) for m in G}

def nearest(m, p, maxd=700):
    best, bn = maxd, None
    for n in node_list[m]:
        q = loc[n]
        if abs(q[0]-p[0]) > 0.01 or abs(q[1]-p[1]) > 0.01: continue
        d = hav(p, q)
        if d < best: best, bn = d, n
    return bn

def near_k(m, p, k=8, maxd=180):
    c = []
    for n in node_list[m]:
        q = loc[n]
        if abs(q[0]-p[0]) > 0.003 or abs(q[1]-p[1]) > 0.003: continue
        d = hav(p, q)
        if d < maxd: c.append((d, n))
    c.sort(); out = []
    for d, n in c:
        if all(hav(loc[n], loc[o]) > 3 for o in out): out.append(n)
        if len(out) >= k: break
    return out

def astar(m, s, t, limit=1e18):
    g = G[m]; T = loc[t]
    dist = {s: 0}; prev = {}; pq = [(hav(loc[s], T), s)]
    seen = set()
    while pq:
        f, u = heapq.heappop(pq)
        if u == t: break
        if f > limit: return None
        if u in seen: continue
        seen.add(u)
        if len(seen) > 200000: return None
        for v, w in g[u].items():
            nd = dist[u] + w
            if nd < dist.get(v, 1e18):
                dist[v] = nd; prev[v] = u
                heapq.heappush(pq, (nd + hav(loc[v], T), v))
    if t not in dist: return None
    path = [t]
    while path[-1] != s: path.append(prev[path[-1]])
    return [loc[x] for x in reversed(path)], dist[t]

stations = {}   # id -> dict
segs = {}       # "A>B" -> coords (A<B lexicographic)
seg_stats = collections.Counter()
def seg_key(a, b): return (a + '>' + b) if a < b else (b + '>' + a)
def make_seg(m, a, b):
    k = seg_key(a, b)
    if k in segs: return
    pa = (stations[a]['lng'], stations[a]['lat']); pb = (stations[b]['lng'], stations[b]['lat'])
    if a > b: pa, pb = pb, pa
    straight = hav(pa, pb)
    ca = near_k(m, pa) or ([nearest(m, pa)] if nearest(m, pa) else [])
    cb = near_k(m, pb) or ([nearest(m, pb)] if nearest(m, pb) else [])
    coords = None; best = None; lim = straight*1.8 + 600
    for na in ca:
        for nb in cb:
            if na == nb: continue
            r = astar(m, na, nb, lim if best is None else min(lim, best[1]))
            if r and (best is None or r[1] < best[1]): best = r
    if best:
        coords = [list(pa)] + [list(c) for c in best[0]] + [list(pb)]
        seg_stats['track'] += 1
    if not coords:
        coords = [list(pa), list(pb)]; seg_stats['straight'] += 1
    segs[k] = [R5(p) for p in rdp(coords)]

def add_station(sid, name, lng, lat, sys, line):
    s = stations.setdefault(sid, {'id': sid, 'name': name, 'lat': round(lat, 6), 'lng': round(lng, 6), 'sys': [], 'lines': []})
    if sys not in s['sys']: s['sys'].append(sys)
    if line and line not in s['lines']: s['lines'].append(line)
    return s

def title(s):
    s = s.strip().title()
    for a, b in [('Bni', 'BNI'), ('Ui', 'UI'), ('Kai', 'KAI'), ('Lrt', 'LRT'), ('Mrt', 'MRT'), ('Bsd', 'BSD'), ('Ii', 'II'), ('Hi', 'HI')]:
        s = re.sub(r'\b%s\b' % a, b, s)
    return s

# ---------- KRL from Open-KRL boards ----------
base = os.path.join(A.krl, 'data')
coords = {r['sta_id']: (float(r['lon']), float(r['lat']), r['sta_name']) for r in csv.DictReader(open(os.path.join(base, 'station_coordinates.csv')))}
KRL_LINES = {
    'COMMUTER LINE BOGOR': ('krl-b', 'B', 'Commuter Line Bogor', '#E30A16'),
    'COMMUTER LINE CIKARANG': ('krl-c', 'C', 'Commuter Line Cikarang', '#0084D8'),
    'COMMUTER LINE RANGKASBITUNG': ('krl-r', 'R', 'Commuter Line Rangkasbitung', '#16812B'),
    'COMMUTER LINE TANGERANG': ('krl-t', 'T', 'Commuter Line Tangerang', '#623814'),
    'COMMUTER LINE TANJUNGPRIUK': ('krl-tp', 'TP', 'Commuter Line Tanjung Priok', '#DD0067'),
    'COMMUTERLINE MERAK': ('krl-lm', 'LM', 'Commuter Line Merak', '#24824D'),
}
name2id = {norm(v[2]): k for k, v in coords.items()}
name2id.update({'jakartakota': 'JAKK', 'tanjungpriuk': 'TPK', 'kampungbandan': 'KPB'})

def tsec(s):
    h, m, *x = s.split(':'); return int(h)*3600 + int(m)*60 + (int(x[0]) if x else 0)

def load_boards(snap):
    trains = {}
    meta = json.load(open(os.path.join(base, 'raw', A.version, 'captures', snap, 'manifest.json')))
    for f in sorted(glob.glob(os.path.join(base, 'raw', A.version, 'captures', snap, 'boards', '*.json'))):
        st = os.path.basename(f)[:-5]
        d = json.load(open(f))
        for r in d.get('data') or []:
            if r['ka_name'] not in KRL_LINES: continue
            tr = trains.setdefault(r['train_id'], {'id': r['train_id'], 'ka': r['ka_name'], 'route': r['route_name'], 'dest': r['dest'], 'dest_time': r['dest_time'], 'stops': {}})
            tr['stops'][st] = tsec(r['time_est'])
    return meta, trains

def build_trips(trains):
    out = []
    for tid, tr in trains.items():
        if len(tr['stops']) < 1: continue
        dest = name2id.get(norm(re.sub(r'\s+VIA\s+.*$', '', tr['dest'])))
        items = sorted(tr['stops'].items(), key=lambda kv: kv[1])
        # trains crossing midnight: board times wrap, unwrap relative to first
        if items[-1][1] - items[0][1] > 12*3600:
            items = sorted([(k, v + (86400 if v < 4*3600 else 0)) for k, v in items], key=lambda kv: kv[1])
        t_dest = tsec(tr['dest_time'])
        while t_dest < items[-1][1] - 600: t_dest += 86400
        if dest and dest not in tr['stops']: items.append((dest, t_dest))
        if len(items) < 2: continue
        sids = [k for k, _ in items]; times = [v for _, v in items]
        if any(s not in coords for s in sids): continue
        lid = KRL_LINES[tr['ka']][0]
        head = coords[sids[-1]][2]
        via = re.search(r'\bVIA\s+(\w+)', tr['dest'])
        head = title(head) + (' via ' + title(coords[via.group(1)][2]) if via and via.group(1) in coords else '')
        out.append([tid, lid, head, sids, times])
    out.sort(key=lambda t: t[4][0])
    return out

wk_meta, wk = load_boards(A.weekday)
we_meta, we = load_boards(A.weekend)
trips_wk, trips_we = build_trips(wk), build_trips(we)

lines = []
krl_patterns = collections.defaultdict(collections.Counter)
for t in trips_wk + trips_we:
    krl_patterns[t[1]][tuple(t[3])] += 1
for ka, (lid, short, name, color) in KRL_LINES.items():
    pats = krl_patterns[lid]
    if not pats: continue
    # main order: the longest pattern; extra stations from other patterns appended as branches
    main = list(max(pats, key=lambda p: (len(p), pats[p])))
    branches = []
    covered = set(main)
    for p, _ in sorted(pats.items(), key=lambda kv: -len(kv[0])):
        extra = [s for s in p if s not in covered]
        if extra:
            branches.append(list(p)); covered |= set(p)
    lines.append({'id': lid, 'short': short, 'name': name, 'color': color, 'text': '#FFFFFF', 'sys': 'krl',
                  'stations': main, 'branches': branches, 'sched': 'timetable'})

for sid, (lng, lat, nm) in coords.items():
    pass
used = set()
for t in trips_wk + trips_we: used |= set(t[3])
for l in lines:
    for p in [l['stations']] + l['branches']:
        for s in p:
            lng, lat, nm = coords[s]; add_station(s, title(nm), lng, lat, 'krl', l['id'])
pairs = set()
for t in trips_wk + trips_we:
    for a, b in zip(t[3], t[3][1:]): pairs.add((a, b))
for a, b in pairs: make_seg('rail', a, b)

# ---------- other systems from OSM route relations ----------
rels = {r['id']: r for r in osm['rels']}
osm_st = osm['stations']
def osm_station_near(p, maxd=450):
    best, bs = maxd, None
    for s in osm_st:
        q = (s['lng'], s['lat'])
        if abs(q[0]-p[0]) > 0.006 or abs(q[1]-p[1]) > 0.006: continue
        d = hav(p, q)
        if d < best: best, bs = d, s
    return bs

def clean_name(n):
    n = re.sub(r'^(Stasiun|Halte|Station)\s+(MRT|LRT|KRL|KA|Kereta Cepat|Whoosh)?\s*', '', n or '', flags=re.I)
    n = re.sub(r'\s+(MRT|LRT)( Station)?$', '', n)
    return n.strip()

def krl_match(nm, lng, lat):
    best, bid = 450, None
    for k, v in coords.items():
        d = hav((lng, lat), (v[0], v[1]))
        if d < best and (norm(nm) in norm(v[2]) or norm(v[2]) in norm(nm)): best, bid = d, k
    return bid

def rel_stops(rid, mode='rail'):
    r = rels[rid]; out = []
    for ty, ref, role in r['m']:
        if ty != 'n' or not role.startswith('stop') or ref not in loc: continue
        p = loc[ref]
        s = osm_station_near(p)
        nm = clean_name(s['tags'].get('name')) if s else None
        if not nm: continue
        sid = 'o' + str(s['id']); lng, lat = s['lng'], s['lat']
        if mode == 'rail':
            k = krl_match(nm, lng, lat)
            if k: sid = k; nm = title(coords[k][2]); lng, lat = coords[k][0], coords[k][1]
        if out and out[-1][0] == sid: continue
        out.append((sid, nm, lng, lat))
    return out

def rel_geom(rid):
    r = rels[rid]; ml = []
    for ty, ref, role in r['m']:
        if ty == 'w' and ref in ways and role in ('', 'forward', 'backward', 'main'):
            c = [list(loc[n]) for n in ways[ref]['n'] if n in loc]
            if len(c) > 1: ml.append([R5(p) for p in rdp(c, 25)])
    return ml

# frequency patterns: APPROXIMATIONS of publicly announced headways (not timetables). minutes.
FREQ = [
    # id, rel, sys, short, name, color, mode, avg km/h (incl. dwell), weekday bands, weekend bands, note
    ('mrt-ns', 9677669, 'mrt', 'M', 'MRT Lin Utara–Selatan', '#CE0037', 'subway', 33,
     [[300, 420, 10], [420, 540, 5], [540, 1020, 10], [1020, 1140, 5], [1140, 1440, 10]], [[300, 1440, 10]]),
    ('lrtj-s', 10693160, 'lrtj', 'S', 'LRT Jakarta Lin Selatan', '#F16227', 'light_rail', 26,
     [[330, 1380, 10]], [[330, 1380, 10]]),
    ('lrtjb-cb', 16036441, 'jbdb', 'CB', 'LRT Jabodebek Lin Cibubur', '#20409A', 'light_rail', 38,
     [[300, 420, 15], [420, 540, 8], [540, 960, 15], [960, 1140, 8], [1140, 1380, 15]], [[360, 1380, 15]]),
    ('lrtjb-bk', 16079478, 'jbdb', 'BK', 'LRT Jabodebek Lin Bekasi', '#0E6938', 'light_rail', 38,
     [[300, 420, 15], [420, 540, 8], [540, 960, 15], [960, 1140, 8], [1140, 1380, 15]], [[360, 1380, 15]]),
    ('ka-bst', 17675695, 'bandara', 'A', 'KA Bandara Soekarno-Hatta', '#F2A900', 'rail', 45,
     [[300, 1260, 60]], [[300, 1260, 60]]),
    ('kcic', 12150229, 'whoosh', 'W', 'Whoosh Jakarta–Bandung', '#8C0023', 'hs', 190,
     [[360, 1260, 45]], [[360, 1260, 40]]),
    ('kcic-f', 17571085, 'whoosh', 'KF', 'KA Feeder Whoosh Padalarang–Bandung', '#A30028', 'rail', 45,
     [[400, 1320, 45]], [[400, 1320, 40]]),
]
for (lid, rid, sys, short, name, color, mode, kmh, wkb, web) in FREQ:
    if rid not in rels: print('missing rel', rid); continue
    st = rel_stops(rid, mode)
    if len(st) < 2: print('no stops', rid); continue
    for sid, nm, lng, lat in st: add_station(sid, nm, lng, lat, sys, lid)
    sids = [s[0] for s in st]
    for a, b in zip(sids, sids[1:]): make_seg(mode, a, b)
    lines.append({'id': lid, 'short': short, 'name': name, 'color': color, 'text': '#FFFFFF', 'sys': sys,
                  'stations': sids, 'branches': [], 'sched': 'frequency',
                  'freq': {'kmh': kmh, 'dwell': 30, 'weekday': wkb, 'weekend': web}})

# ---------- routes without public timetable (shown on map, no trains) ----------
seen_names = set(); geoms = {}
for r in osm['rels']:
    t = r['tags']
    if t.get('type') != 'route' or t.get('route') not in ('train', 'light_rail', 'subway'): continue
    if r['id'] in {f[1] for f in FREQ}: continue
    nm = t.get('name') or ''
    op = (t.get('operator') or '') + ' ' + (t.get('network') or '')
    if not nm or 'railway' in nm.lower(): continue
    stops = [m for m in r['m'] if m[2].startswith('stop')]
    if len(stops) < 2: continue
    # skip Jabodetabek KRL relations (we have the real timetable for those)
    if 'KAI Commuter' in op and re.match(r'^(Lin |Bogor Line|Commuter Line (Merak|Walahar))', nm): continue
    if 'Feeder KCJB' in nm: continue
    if re.search(r'Lin Selatan|Kalayang|Cibubur Line|Bekasi Line|North-South|MRT', nm): 
        if 'Kalayang' not in nm: continue
    key = re.sub(r'\s*[:(].*$', '', nm).strip()
    if key in seen_names: continue
    seen_names.add(key)
    sys = 'regional' if ('Commuter' in op or 'Commuter' in nm or 'Lin ' in nm or 'Feeder' in nm or 'Bandara' in nm) else 'kai'
    if 'Kalayang' in nm: sys = 'bandara'
    st = rel_stops(r['id'], 'rail' if t.get('route') == 'train' else t.get('route'))
    if len(st) < 2: continue
    lid = 'osm-' + str(r['id'])
    for sid, snm, lng, lat in st: add_station(sid, snm, lng, lat, sys, lid)
    col = t.get('colour') or ''
    if not re.match(r'^#[0-9a-fA-F]{6}$', col): col = '#6A2C91' if sys == 'kai' else '#3B7A8C'
    lines.append({'id': lid, 'short': (t.get('ref') or key[:3]).strip()[:12], 'name': nm.replace('→', '–'), 'color': col, 'text': '#FFFFFF', 'sys': sys,
                  'stations': [s[0] for s in st], 'branches': [], 'sched': 'none', 'osm': r['id']})
    geoms[lid] = rel_geom(r['id'])

# merge KRL stations with OSM stations of other systems that share a building (interchanges)
for s in stations.values(): s['xfer'] = []
sl = list(stations.values())
for i, a in enumerate(sl):
    for b in sl[i+1:]:
        if abs(a['lat']-b['lat']) < 0.004 and abs(a['lng']-b['lng']) < 0.004 and hav((a['lng'], a['lat']), (b['lng'], b['lat'])) < 280:
            a['xfer'].append(b['id']); b['xfer'].append(a['id'])

# background network + tunnels
net, tun = [], []
for wid, w in ways.items():
    m = mode_of(w['tags'])
    c = [list(loc[n]) for n in w['n'] if n in loc]
    if len(c) < 2: continue
    c = [R5(p) for p in rdp(c, 15)]
    if m: net.append({'m': m, 'c': c})
    if w['tags'].get('tunnel') in ('yes', 'building_passage') or w['tags'].get('layer', '0').startswith('-'):
        tun.append(c)

SYSTEMS = [
    {'id': 'krl', 'name': 'KRL Commuter Line', 'operator': 'KAI Commuter', 'sched': 'timetable'},
    {'id': 'mrt', 'name': 'MRT Jakarta', 'operator': 'PT MRT Jakarta (Perseroda)', 'sched': 'frequency'},
    {'id': 'lrtj', 'name': 'LRT Jakarta', 'operator': 'PT LRT Jakarta', 'sched': 'frequency'},
    {'id': 'jbdb', 'name': 'LRT Jabodebek', 'operator': 'PT Kereta Api Indonesia (Persero)', 'sched': 'frequency'},
    {'id': 'bandara', 'name': 'KA Bandara & Skytrain', 'operator': 'KAI Commuter / Angkasa Pura', 'sched': 'frequency'},
    {'id': 'whoosh', 'name': 'Whoosh (Kereta Cepat)', 'operator': 'PT Kereta Cepat Indonesia China', 'sched': 'frequency'},
    {'id': 'regional', 'name': 'Commuter daerah', 'operator': 'KAI Commuter', 'sched': 'none'},
    {'id': 'kai', 'name': 'KA antarkota', 'operator': 'PT Kereta Api Indonesia (Persero)', 'sched': 'none'},
]
holidays = [h['holiday_date'] for h in json.load(open(os.path.join(base, 'holidays.json')))]
now = datetime.datetime.now(datetime.UTC).replace(tzinfo=None).replace(microsecond=0).isoformat() + 'Z'
network = {
    'v': 1, 'builtAt': now, 'systems': SYSTEMS, 'lines': lines,
    'stations': sorted(stations.values(), key=lambda s: s['name']),
    'segs': segs, 'tunnels': tun, 'net': net, 'holidays': holidays,
    'sources': {
        'osm': 'OpenStreetMap contributors (ODbL), Geofabrik Java extract',
        'krl': 'Open-KRL (CC-BY 4.0), raw captures of public KCI station boards',
        'krlWeekday': wk_meta['snapshot_date'], 'krlWeekend': we_meta['snapshot_date'],
    },
}
os.makedirs(A.out, exist_ok=True)
json.dump(network, open(os.path.join(A.out, 'network.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
os.makedirs(os.path.join(A.out, 'routes'), exist_ok=True)
for lid, g in geoms.items(): json.dump(g, open(os.path.join(A.out, 'routes', lid + '.json'), 'w'), separators=(',', ':'))
json.dump({'v': 1, 'weekday': trips_wk, 'weekend': trips_we,
           'meta': {'weekday': wk_meta['snapshot_date'], 'weekend': we_meta['snapshot_date'], 'version': A.version}},
          open(os.path.join(A.out, 'krl.json'), 'w'), separators=(',', ':'))
print('lines', len(lines), 'stations', len(stations), 'segs', len(segs), dict(seg_stats), 'trips', len(trips_wk), len(trips_we), 'net', len(net), 'tunnels', len(tun))
