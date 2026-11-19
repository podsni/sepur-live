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
ap.add_argument('--gapeka', required=True, help='gapeka.db from transportforbandung/Gapeka-parser')
ap.add_argument('--shiori', required=True, help='folder with ShioriLabs/commute timetable .sql files')
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

def near_k(m, p, k=5, maxd=180):
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
    s = stations.setdefault(sid, {'id': sid, 'name': ST_FIX.get(name, name), 'lat': round(lat, 6), 'lng': round(lng, 6), 'sys': [], 'lines': []})
    if sys not in s['sys']: s['sys'].append(sys)
    if line and line not in s['lines']: s['lines'].append(line)
    return s

def title(s):
    s = s.strip().title()
    for a, b in [('Bni', 'BNI'), ('Ui', 'UI'), ('Kai', 'KAI'), ('Lrt', 'LRT'), ('Mrt', 'MRT'), ('Bsd', 'BSD'), ('Ii', 'II'), ('Hi', 'HI')]:
        s = re.sub(r'\b%s\b' % a, b, s)
    return ST_FIX.get(s, s)

ST_FIX = {'Surabayagubeng': 'Surabaya Gubeng', 'Surabayakota': 'Surabaya Kota', 'Surabayapasarturi': 'Surabaya Pasarturi',
          'Malangkotalama': 'Malang Kota Lama', 'Solokota': 'Solo Kota', 'Solobalapan': 'Solo Balapan', 'Solojebres': 'Solo Jebres',
          'Semarangtawang': 'Semarang Tawang', 'Semarangponcol': 'Semarang Poncol', 'Pegadenbaru': 'Pegaden Baru',
          'Yogyakartatugu': 'Yogyakarta', 'Bandungkiaracondong': 'Kiaracondong'}

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


def to_sec(s):
    h, m, *x = s.split(':'); return int(h)*3600 + int(m)*60 + (int(x[0]) if x else 0)

def pack(tid, lid, head, sids, dep, arr=None, flags=None):
    """Compact trip: [id, line, headsign, stations, dep, arr|null, flags|null]. flags bit0=stop, bit1=time estimated by the parser."""
    return [tid, lid, head, sids, dep, arr, flags]

core_trips = {'weekday': [pack(*t) for t in trips_wk], 'weekend': [pack(*t) for t in trips_we], 'daily': []}

# ---------- Whoosh: frequency ESTIMATE (no open timetable found) ----------
FREQ = [
    ('kcic', 12150229, 'whoosh', 'W', 'Whoosh Jakarta–Bandung', '#8C0023', 'hs', 190,
     [[360, 1260, 45]], [[360, 1260, 40]]),
]
for (lid, rid, sys, short, name, color, mode, kmh, wkb, web) in FREQ:
    st = rel_stops(rid, mode)
    for sid, nm, lng, lat in st: add_station(sid, nm, lng, lat, sys, lid)
    sids = [x[0] for x in st]
    for a, b in zip(sids, sids[1:]): make_seg(mode, a, b)
    lines.append({'id': lid, 'short': short, 'name': name, 'color': color, 'text': '#FFFFFF', 'sys': sys,
                  'stations': sids, 'branches': [], 'sched': 'frequency', 'src': 'freq',
                  'freq': {'kmh': kmh, 'dwell': 30, 'weekday': wkb, 'weekend': web}})

# ---------- MRT / LRT Jakarta / LRT Jabodebek / Kalayang: ShioriLabs commute boards (ODbL) ----------
import glob as _g
SH = {
    'M':  ('mrt-ns', 9677669, 'mrt', 'M', 'MRT Lin Utara–Selatan', '#CE0037', 'subway', 'shiori-mrt'),
    'S':  ('lrtj-s', 10693160, 'lrtj', 'S', 'LRT Jakarta Lin Selatan', '#F16227', 'light_rail', 'shiori-lrtj'),
    'CB': ('lrtjb-cb', 16036441, 'jbdb', 'CB', 'LRT Jabodebek Lin Cibubur', '#20409A', 'light_rail', 'shiori-jbdb'),
    'BK': ('lrtjb-bk', 16079478, 'jbdb', 'BK', 'LRT Jabodebek Lin Bekasi', '#0E6938', 'light_rail', 'shiori-jbdb'),
    'T':  ('apcgk', 15031928, 'bandara', 'SKY', 'Skytrain Kalayang Bandara Soekarno-Hatta', '#2E9B48', 'light_rail', 'shiori-apcgk'),
}
sh_ll = {m[2]: (float(m[1]), float(m[0])) for m in re.findall(r"latitude = (-?[\d.]+), longitude = (-?[\d.]+).*?id = '([^']+)'", open(os.path.join(A.shiori, 'stations_lat_lng.sql')).read())}
sh_names = {}
for f in _g.glob(os.path.join(A.shiori, '*station*insert.sql')):
    for m in re.findall(r"\('([A-Z]+-[A-Z0-9]+)', '([^']+)', '([^']*)', '([^']*)'", open(f).read()): sh_names[m[0]] = m[3] or m[1]
rows = []
for f in sorted(_g.glob(os.path.join(A.shiori, '*timetable.sql'))):
    if os.path.basename(f).startswith('kci_'): continue   # KA Bandara comes from GAPEKA
    for m in re.findall(r"\('[^']+',\s*'([^']+)',\s*'([^']+)',\s*'([\d:]+)',\s*'([\d:]+)',\s*'([^']*)',\s*'([^']+)',\s*(\d+)", open(f).read()):
        rows.append(m)
line_station_ids = {}
for code, (lid, rid, sys, short, name, color, mode, src) in SH.items():
    st = rel_stops(rid, mode) if rid in rels else []
    line_station_ids[code] = st
def map_sh(code, shid):
    p = sh_ll.get(shid)
    cands = line_station_ids.get(code, [])
    if p:
        best = min(cands, key=lambda x: hav(p, (x[2], x[3])), default=None)
        if best and hav(p, (best[2], best[3])) < 600: return best
        return ('s' + shid, title(sh_names.get(shid, shid.split('-')[1])), p[0], p[1])
    return None
apcgk_line = None
KMH = {'M': 36, 'S': 30, 'CB': 40, 'BK': 40, 'T': 25}
groups = collections.defaultdict(list)
for stid, trip, dep, arr, bound, lc, mask in rows:
    lc2 = lc if lc in SH else ('T' if stid.startswith('APCGK') else None)
    if not lc2: continue
    groups[(lc2, int(mask), trip)].append((stid, to_sec(dep), to_sec(arr), bound))
sh_count = collections.Counter(); sh_lines = {}
for (lc, mask, trip), pts in groups.items():
    lid, rid, sys, short, name, color, mode, src = SH[lc]
    pts.sort(key=lambda x: x[1])
    seq = []
    for stid, dep, arr, bound in pts:
        m = map_sh(lc, stid)
        if not m: continue
        if seq and seq[-1][0] == m[0]: continue
        seq.append((m[0], dep, min(arr, dep), m, bound))
    if not seq: continue
    flags = [1] * len(seq)
    # departure boards never list a train at its terminus: add it from boundFor with an estimated arrival
    bound = norm(pts[-1][3])
    term = next((c for c in line_station_ids.get(lc, []) if bound and (norm(c[1]) in bound or bound in norm(c[1]))), None)
    if term and term[0] != seq[-1][0] and term[0] not in [x[0] for x in seq]:
        last = seq[-1]; d = hav((last[3][2], last[3][3]), (term[2], term[3]))
        t_arr = last[1] + round(d / (KMH[lc] / 3.6)) + 30
        seq.append((term[0], t_arr, t_arr, term, pts[-1][3])); flags.append(3)
    if len(seq) < 2: continue
    sids = [x[0] for x in seq]; dep = [x[1] for x in seq]; arr = [x[2] for x in seq]
    for x in seq: add_station(x[0], x[3][1], x[3][2], x[3][3], sys, lid)
    for a, b in zip(sids, sids[1:]): make_seg(mode, a, b)
    head = stations[sids[-1]]['name']
    t = pack({'mrt-ns': 'MRT ', 'lrtj-s': 'LRTJ ', 'lrtjb-cb': 'JBDB ', 'lrtjb-bk': 'JBDB '}.get(lid, '') + (trip.split('-', 1)[-1] if not trip.startswith('APCGK') else trip.replace('APCGK-', 'SKY ')), lid, head, sids, dep, arr if arr != dep else None, flags if 3 in flags else None)
    days = ['daily'] if mask == 7 else (['weekday'] if mask & 4 else []) + (['weekend'] if mask & 3 else [])
    if mask == 7: core_trips['daily'].append(t)
    else:
        if mask & 4: core_trips['weekday'].append(t)
        if mask & 3: core_trips['weekend'].append(t)
    sh_count[(lid, mask)] += 1
    pl = sh_lines.setdefault(lid, collections.Counter()); pl[tuple(sids)] += 1
for code, (lid, rid, sys, short, name, color, mode, src) in SH.items():
    pats = sh_lines.get(lid)
    if not pats: print('no shiori trips for', lid); continue
    main = list(max(pats, key=lambda p: (len(p) * pats[p], len(p))))
    if lid != 'apcgk':
        # keep direction of the OSM relation order for display
        pass
    l = {'id': lid, 'short': short, 'name': name, 'color': color, 'text': '#FFFFFF', 'sys': sys, 'stations': main, 'branches': [], 'sched': 'timetable', 'src': src}
    if lid == 'mrt-ns' and not any(k for k in sh_count if k[0] == lid and (k[1] & 3)):
        # weekend MRT board is not published in the dataset: fall back to a labelled frequency estimate
        l['freq'] = {'kmh': 33, 'dwell': 30, 'weekday': [], 'weekend': [[300, 1440, 10]]}; l['freqDays'] = ['weekend']
    lines.append(l)
print('shiori trips', dict(sh_count))

# ---------- GAPEKA 2026 (official KAI timetable), parsed by Transport for Bandung's Gapeka-parser ----------
import sqlite3
gdb = sqlite3.connect(A.gapeka)
g_names = dict(gdb.execute('select code, name from stations'))
osm_by_ref = {}
for s in osm_st:
    r = (s['tags'].get('railway:ref') or '').upper()
    if r: osm_by_ref.setdefault(r, s)
osm_by_name = {norm(s['tags'].get('name', '')): s for s in osm_st}
def g_coord(code):
    if code in coords: return coords[code][0], coords[code][1], title(coords[code][2])
    s = osm_by_ref.get(code) or osm_by_name.get(norm(g_names.get(code, '')))
    if s: return s['lng'], s['lat'], g_names.get(code) or clean_name(s['tags'].get('name'))
    return None
SKIP_SVC = re.compile(r'Cargo|Tanker|Parcel|Service|Trans$|Commuter Line (Bogor|Cikarang|Rangkasbitung|Tangerang|Tanjungpriuk|Merak)$', re.I)
def g_sys(svc):
    if svc in ('Commuter Line BST',): return 'bandara', 'core'
    if svc == 'Ka Feeder': return 'whoosh', 'core'
    if svc in ('Commuter Line YIA', 'Bandara SMO'): return 'bandara', 'kai'
    if svc.startswith('Commuter Line') or svc in ('Pangrango', 'Siliwangi', 'Kedung Sepur', 'Banyubiru', 'Ketandan', 'Cikuray'): return 'regional', 'kai'
    return 'kai', 'kai'
PALETTE = {'kai': '#6A2C91', 'regional': '#2B7A8C', 'bandara': '#F2A900', 'whoosh': '#A30028'}
COLORS = {'Commuter Line BST': '#F2A900', 'Ka Feeder': '#A30028', 'Commuter Line Bandung Raya': '#2D398B', 'Commuter Line Yogyakarta': '#43A2C5', 'Commuter Line YIA': '#6FBE44', 'Commuter Line Prameks': '#1B8AC9', 'Commuter Line Garut': '#1C75BC', 'Commuter Line Walahar': '#6D6E70', 'Commuter Line Jatiluhur': '#8A8B8D', 'Commuter Line Jenggala': '#5CBCAC', 'Commuter Line Penataran': '#00A53A', 'Commuter Line Dhoho': '#6F9E68', 'Commuter Line Supas': '#A95D40', 'Commuter Line Arjonegoro': '#26225E', 'Commuter Line Blorasura': '#414495'}
SHORT = {'Commuter Line BST': 'A', 'Ka Feeder': 'KF'}
kai_trips = []; kai_lines = []; g_patterns = collections.defaultdict(collections.Counter); g_meta = {}
missing_codes = collections.Counter(); g_skipped = collections.Counter(); g_pairs = {}
seg_mode = 'rail'
for no, svc, route in gdb.execute('select no, service, route from trains'):
    svc = svc.strip(); svc = svc[0].upper() + svc[1:]
    if SKIP_SVC.search(svc): g_skipped[svc] += 1; continue
    sys, bundle = g_sys(svc)
    lid = ('ka-bst' if svc == 'Commuter Line BST' else 'kcic-f' if svc == 'Ka Feeder' else 'g-' + re.sub(r'[^a-z0-9]+', '-', svc.lower()).strip('-'))
    pts = []
    for seq, st, kind, a, d, est in gdb.execute('select seq, station, kind, arr_s, dep_s, estimated from schedule where train_no=? order by seq', (no,)):
        c = g_coord(st)
        if not c: missing_codes[st] += 1; continue
        if a is None and d is None and kind == 'pass': pts.append([st, None, None, 0, c]); continue
        if a is None: a = d
        if d is None: d = a
        pts.append([st, a, d, (1 if kind in ('stop', 'origin_or_end', 'halt') else 0) | (2 if est else 0), c])
    # interpolate pass points without a printed time by distance between timed neighbours
    timed = [i for i, p in enumerate(pts) if p[1] is not None]
    if len(timed) < 2: continue
    pts = pts[timed[0]:timed[-1] + 1]; timed = [i - timed[0] for i in timed]
    for i0, i1 in zip(timed, timed[1:]):
        if i1 - i0 < 2: continue
        cum = [0]
        for k in range(i0 + 1, i1 + 1): cum.append(cum[-1] + hav(pts[k - 1][4][:2], pts[k][4][:2]))
        for k in range(i0 + 1, i1):
            f = cum[k - i0] / (cum[-1] or 1); t = round(pts[i0][2] + (pts[i1][1] - pts[i0][2]) * f)
            pts[k][1] = pts[k][2] = t; pts[k][3] |= 2
    # first and last points are always stops
    pts[0][3] |= 1; pts[-1][3] |= 1
    sids = [p[0] for p in pts]
    for p in pts:
        add_station(p[0], p[4][2], p[4][0], p[4][1], sys, lid)
    for a, b in zip(sids, sids[1:]):
        if a != b: make_seg(seg_mode, a, b)
    dep = [p[2] for p in pts]; arr = [p[1] for p in pts]; flags = [p[3] for p in pts]
    head = stations[sids[-1]]['name']
    t = pack('KA ' + no, lid, head, sids, dep, arr, flags)
    (core_trips['daily'] if bundle == 'core' else kai_trips).append(t)
    g_patterns[lid][tuple(s for s, f in zip(sids, flags) if f & 1)] += 1
    g_meta[lid] = (svc, sys, bundle)
    g_pairs.setdefault(lid, set()).update(seg_key(a, b) for a, b in zip(sids, sids[1:]) if a != b)
for lid, pats in g_patterns.items():
    svc, sys, bundle = g_meta[lid]
    ordered = sorted(pats.items(), key=lambda kv: (-len(kv[0]) * kv[1], -len(kv[0])))
    main = list(ordered[0][0]); covered = set(main); branches = []
    for p, _ in ordered[1:]:
        if set(p) - covered and len(branches) < 4: branches.append(list(p)); covered |= set(p)
    fak = 'Fakultatif' in svc
    short = SHORT.get(svc) or ''.join(w[0] for w in re.sub(r'^Commuter Line ', 'CL ', svc).split()[:3]).upper()
    # public train names: GAPEKA abbreviates a few services
    NAME_FIX = {'Anggrek': 'Argo Bromo Anggrek', 'Senja Utama Yk': 'Senja Utama Yogyakarta', 'Fajar Utama Yk': 'Fajar Utama Yogyakarta',
                'Bandara SMO': 'KA Bandara Adi Soemarmo', 'Commuter Line YIA': 'KA Bandara YIA'}
    base_name = re.sub(r' Fakultatif$', '', svc)
    disp = NAME_FIX.get(base_name, base_name) + (' (Fakultatif)' if fak else '')
    l = {'id': lid, 'short': short, 'svc': svc, 'name': ('KA Bandara Soekarno-Hatta' if lid == 'ka-bst' else 'KA Feeder Whoosh Padalarang–Bandung' if lid == 'kcic-f' else disp),
         'color': COLORS.get(svc, PALETTE[sys]), 'text': '#FFFFFF', 'sys': sys, 'stations': main, 'branches': branches,
         'sched': 'timetable', 'src': 'gapeka', 'fak': fak, 'bundle': bundle, 'pairs': sorted(g_pairs[lid])}
    (lines if bundle == 'core' else kai_lines).append(l)
print('gapeka trips core', len(core_trips['daily']), 'kai', len(kai_trips), 'lines', len(kai_lines), 'skipped', sum(g_skipped.values()), 'missing coords', len(missing_codes))

# merge stations of different systems that share a building (interchanges)
for s in stations.values(): s['xfer'] = []
sl = list(stations.values())
for i, a in enumerate(sl):
    for b in sl[i+1:]:
        if abs(a['lat']-b['lat']) < 0.004 and abs(a['lng']-b['lng']) < 0.004 and hav((a['lng'], a['lat']), (b['lng'], b['lat'])) < 300:
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
    {'id': 'krl', 'name': 'KRL Commuter Line', 'operator': 'KAI Commuter', 'sched': 'timetable', 'src': 'Open-KRL (papan stasiun KCI)'},
    {'id': 'mrt', 'name': 'MRT Jakarta', 'operator': 'PT MRT Jakarta (Perseroda)', 'sched': 'timetable', 'src': 'ShioriLabs commute (feed MRT Jakarta); akhir pekan: perkiraan'},
    {'id': 'lrtj', 'name': 'LRT Jakarta', 'operator': 'PT LRT Jakarta', 'sched': 'timetable', 'src': 'ShioriLabs commute'},
    {'id': 'jbdb', 'name': 'LRT Jabodebek', 'operator': 'PT Kereta Api Indonesia (Persero)', 'sched': 'timetable', 'src': 'ShioriLabs commute (poster jadwal)'},
    {'id': 'bandara', 'name': 'KA Bandara & Skytrain', 'operator': 'KAI Commuter / InJourney Airports', 'sched': 'timetable', 'src': 'GAPEKA 2026 · ShioriLabs (Skytrain)'},
    {'id': 'whoosh', 'name': 'Whoosh & KA Feeder', 'operator': 'PT KCIC / KAI', 'sched': 'mixed', 'src': 'Whoosh: perkiraan · Feeder: GAPEKA 2026'},
    {'id': 'regional', 'name': 'Commuter daerah', 'operator': 'KAI Commuter / KAI', 'sched': 'timetable', 'src': 'GAPEKA 2026'},
    {'id': 'kai', 'name': 'KA antarkota', 'operator': 'PT Kereta Api Indonesia (Persero)', 'sched': 'timetable', 'src': 'GAPEKA 2026'},
]
holidays = [h['holiday_date'] for h in json.load(open(os.path.join(base, 'holidays.json')))]
now = datetime.datetime.now(datetime.UTC).replace(tzinfo=None).replace(microsecond=0).isoformat() + 'Z'
kai_line_ids = {l['id'] for l in kai_lines}
kai_seg_keys = set()
for t in kai_trips:
    for a, b in zip(t[3], t[3][1:]):
        if a != b: kai_seg_keys.add(seg_key(a, b))
core_seg_keys = set()
for typ in core_trips.values():
    for t in typ:
        for a, b in zip(t[3], t[3][1:]):
            if a != b: core_seg_keys.add(seg_key(a, b))
for l in lines:
    for p in [l['stations']] + l.get('branches', []):
        for a, b in zip(p, p[1:]): core_seg_keys.add(seg_key(a, b))
core_segs = {k: v for k, v in segs.items() if k in core_seg_keys}
kai_segs = {k: v for k, v in segs.items() if k in kai_seg_keys and k not in core_seg_keys}
META = {
    'krl': {'weekday': wk_meta['snapshot_date'], 'weekend': we_meta['snapshot_date']},
    'gapeka': 'GAPEKA 2026 Jawa (KAI), parsed by transportforbandung/Gapeka-parser',
    'shiori': 'ShioriLabs/commute timetable data (ODbL 1.0)',
}
network = {
    'v': 2, 'builtAt': now, 'systems': SYSTEMS, 'lines': lines,
    'stations': sorted(stations.values(), key=lambda s: s['name']),
    'segs': core_segs, 'tunnels': tun, 'net': net, 'holidays': holidays, 'meta': META,
    'kaiLines': sorted(kai_line_ids),
}
os.makedirs(A.out, exist_ok=True)
json.dump(network, open(os.path.join(A.out, 'network.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
json.dump({'v': 2, 'meta': META, **core_trips}, open(os.path.join(A.out, 'trips.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
json.dump({'v': 2, 'meta': META, 'lines': kai_lines, 'segs': kai_segs, 'daily': kai_trips}, open(os.path.join(A.out, 'kai.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
print('lines', len(lines), '+kai', len(kai_lines), 'stations', len(stations), 'segs', len(core_segs), '+', len(kai_segs), dict(seg_stats),
      'trips wk/we/daily', len(core_trips['weekday']), len(core_trips['weekend']), len(core_trips['daily']), 'kai', len(kai_trips))

# ---------- KA barang (freight) from the same GAPEKA 2026 book: separate bundle, never used by the planner ----------
# GAPEKA names each freight service with a category suffix (Cargo/Tanker/Parcel/Service/Trans). It does not say the
# commodity or the shipper, so the app shows the category only.
FR_CAT = [('Tanker', 'tanker'), ('Cargo', 'cargo'), ('Parcel', 'parcel'), ('Service', 'service'), ('Trans', 'trans')]
FR_COLOR = {'tanker': '#C8102E', 'cargo': '#D9631E', 'parcel': '#0F7C8C', 'service': '#6B5B4B', 'trans': '#5A7D2A'}
def fr_cat(svc):
    if svc.startswith('Commuter'): return None
    for w, c in FR_CAT:
        if re.search(r'\b%s\b' % w, svc): return c
    return None
existing = set(stations)
fr_trips = []; fr_patterns = collections.defaultdict(collections.Counter); fr_meta = {}; fr_pairs = {}; fr_vmax = {}
fr_count = collections.Counter(); fr_new = {}
for no, svc, route in gdb.execute('select no, service, route from trains'):
    svc = svc.strip(); svc = svc[0].upper() + svc[1:]
    cat = fr_cat(svc)
    if not cat: continue
    lid = 'f-' + re.sub(r'[^a-z0-9]+', '-', svc.lower()).strip('-')
    pts = []
    for seq, st, kind, a, d, est in gdb.execute('select seq, station, kind, arr_s, dep_s, estimated from schedule where train_no=? order by seq', (no,)):
        c = g_coord(st)
        if not c: missing_codes[st] += 1; continue
        if a is None and d is None and kind == 'pass': pts.append([st, None, None, 0, c]); continue
        if a is None: a = d
        if d is None: d = a
        pts.append([st, a, d, (1 if kind in ('stop', 'origin_or_end', 'halt') else 0) | (2 if est else 0), c])
    timed = [i for i, p in enumerate(pts) if p[1] is not None]
    if len(timed) < 2: continue
    pts = pts[timed[0]:timed[-1] + 1]; timed = [i - timed[0] for i in timed]
    for i0, i1 in zip(timed, timed[1:]):
        if i1 - i0 < 2: continue
        cum = [0]
        for k in range(i0 + 1, i1 + 1): cum.append(cum[-1] + hav(pts[k - 1][4][:2], pts[k][4][:2]))
        for k in range(i0 + 1, i1):
            f = cum[k - i0] / (cum[-1] or 1); t = round(pts[i0][2] + (pts[i1][1] - pts[i0][2]) * f)
            pts[k][1] = pts[k][2] = t; pts[k][3] |= 2
    pts[0][3] |= 1; pts[-1][3] |= 1
    sids = [p[0] for p in pts]
    for p in pts:
        if p[0] not in existing:
            s = add_station(p[0], p[4][2], p[4][0], p[4][1], 'barang', lid); fr_new[p[0]] = s
        elif p[0] in fr_new: add_station(p[0], p[4][2], p[4][0], p[4][1], 'barang', lid)
    for a, b in zip(sids, sids[1:]):
        if a != b: make_seg('rail', a, b)
    dep = [p[2] for p in pts]; arr = [p[1] for p in pts]; flags = [p[3] for p in pts]
    fr_trips.append(pack('KA ' + no, lid, stations[sids[-1]]['name'], sids, dep, arr, flags))
    fr_patterns[lid][tuple(s for s, f in zip(sids, flags) if f & 1)] += 1
    fr_meta[lid] = (svc, cat); fr_count[cat] += 1
    fr_pairs.setdefault(lid, set()).update(seg_key(a, b) for a, b in zip(sids, sids[1:]) if a != b)
    vm = [v for (v,) in gdb.execute('select vmax from stops where train_no=? and vmax>0', (no,))]
    if vm: fr_vmax[lid] = max(fr_vmax.get(lid, 0), max(vm))
fr_lines = []
for lid, pats in fr_patterns.items():
    svc, cat = fr_meta[lid]
    ordered = sorted(pats.items(), key=lambda kv: (-len(kv[0]) * kv[1], -len(kv[0])))
    main = list(ordered[0][0]); covered = set(main); branches = []
    for p, _ in ordered[1:]:
        if set(p) - covered and len(branches) < 4: branches.append(list(p)); covered |= set(p)
    base_name = re.sub(r'\s*\b(Cargo|Tanker|Service|Trans)\b\s*', ' ', svc).strip()
    fr_lines.append({'id': lid, 'short': ''.join(w[0] for w in base_name.split()[:2]).upper(), 'svc': svc,
                     'name': ('KA ' + base_name) if cat != 'parcel' else 'KA ' + svc, 'cat': cat,
                     'color': FR_COLOR[cat], 'text': '#FFFFFF', 'sys': 'barang', 'stations': main, 'branches': branches,
                     'sched': 'timetable', 'src': 'gapeka', 'fak': False, 'bundle': 'freight', 'vmax': fr_vmax.get(lid),
                     'pairs': sorted(fr_pairs[lid])})
fr_seg_keys = set()
for t in fr_trips:
    for a, b in zip(t[3], t[3][1:]):
        if a != b: fr_seg_keys.add(seg_key(a, b))
fr_segs = {k: v for k, v in segs.items() if k in fr_seg_keys and k not in core_seg_keys and k not in kai_seg_keys}
for s in fr_new.values(): s['xfer'] = []
fr_lines.sort(key=lambda l: (l['cat'], l['name']))
json.dump({'v': 2, 'meta': META, 'cats': dict(fr_count), 'lines': fr_lines, 'segs': fr_segs,
           'stations': sorted(fr_new.values(), key=lambda s: s['name']), 'daily': fr_trips},
          open(os.path.join(A.out, 'freight.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
print('freight trips', len(fr_trips), dict(fr_count), 'lines', len(fr_lines), 'new stations', len(fr_new), 'segs', len(fr_segs))
