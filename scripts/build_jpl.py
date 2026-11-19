"""Build public/data/jpl.json (level crossings) from raw/jpl_osm.json + public/data/{network,kai}.json.
Each crossing is snapped to the nearest station-to-station section used by the app (<= 40 m) to know which
stations it lies between, its distance along the section, and which lines run over it.
Data: (c) OpenStreetMap contributors, ODbL 1.0."""
import json, math, sys, collections, datetime
src = sys.argv[1] if len(sys.argv) > 1 else '/workspace/raw/jpl_osm.json'
X = json.load(open(src))
net = json.load(open('public/data/network.json')); kai = json.load(open('public/data/kai.json'))
segs = {**net['segs'], **kai['segs']}
st = {s['id']: s for s in net['stations']}
R = 6371000
def hav(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1]); dl = la2 - la1; do = math.radians(b[0] - a[0])
    h = math.sin(dl / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(do / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))
# lines per section
seglines = collections.defaultdict(set)
def addpath(lid, seq):
    for a, b in zip(seq, seq[1:]): seglines[a + '>' + b if a < b else b + '>' + a].add(lid)
for l in net['lines'] + kai['lines']:
    addpath(l['id'], l['stations'])
    for br in l.get('branches', []): addpath(l['id'], br)
    for p in l.get('pairs', []): a, b = p.split('>'); seglines[a + '>' + b if a < b else b + '>' + a].add(l['id'])
# grid of section edges
G = 0.005; grid = collections.defaultdict(list)
prep = {}
for k, c in segs.items():
    cum = [0.0]
    for i in range(1, len(c)): cum.append(cum[-1] + hav(c[i - 1], c[i]))
    prep[k] = (c, cum)
    for i in range(len(c) - 1):
        x0, x1 = sorted((c[i][0], c[i + 1][0])); y0, y1 = sorted((c[i][1], c[i + 1][1]))
        for gx in range(int(math.floor(x0 / G)), int(math.floor(x1 / G)) + 1):
            for gy in range(int(math.floor(y0 / G)), int(math.floor(y1 / G)) + 1): grid[(gx, gy)].append((k, i))
def snap(p):
    gx, gy = int(math.floor(p[0] / G)), int(math.floor(p[1] / G)); best = None
    kx = math.cos(math.radians(p[1])) * 111320; ky = 110540
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for k, i in grid.get((gx + dx, gy + dy), ()):
                c, cum = prep[k]; a, b = c[i], c[i + 1]
                ax, ay = (a[0] - p[0]) * kx, (a[1] - p[1]) * ky; bx, by = (b[0] - p[0]) * kx, (b[1] - p[1]) * ky
                vx, vy = bx - ax, by - ay; L2 = vx * vx + vy * vy
                t = 0 if L2 == 0 else max(0, min(1, -(ax * vx + ay * vy) / L2))
                d = math.hypot(ax + t * vx, ay + t * vy)
                if best is None or d < best[0]: best = (d, k, cum[i] + t * (cum[i + 1] - cum[i]), cum[-1])
    return best
def cat(x):
    t = x['t']
    if x['k'] == 'crossing': return 'ped'
    if t.get('crossing') == 'informal': return 'liar'
    bar = t.get('crossing:barrier'); lit = t.get('crossing:light'); bell = t.get('crossing:bell')
    if bar and bar not in ('no',): return 'bar'
    if (lit and lit != 'no') or (bell and bell != 'no'): return 'sig'
    if bar == 'no' or t.get('crossing') in ('uncontrolled', 'unmarked'): return 'open'
    return 'unk'
sup = lambda t: 1 if t.get('supervised') == 'yes' or t.get('crossing:supervision') in ('attendant', 'yes', 'camera') else 0
rows = []; stats = collections.Counter(); per = collections.defaultdict(collections.Counter)
for x in X:
    p = [x['lng'], x['lat']]; c = cat(x); s = snap(p); t = x['t']; road = x.get('road', {})
    a = b = ''; dA = L = -1; lines = []
    if s and s[0] <= 40:
        k = s[1]; a, b = k.split('>'); dA, L = round(s[2]), round(s[3]); lines = sorted(seglines.get(k, ()))
    flags = (1 if t.get('crossing:light', 'no') != 'no' else 0) | (2 if t.get('crossing:bell', 'no') != 'no' else 0) | (4 if sup(t) else 0) | (8 if t.get('crossing:light') == 'no' else 0) | (16 if t.get('crossing:bell') == 'no' else 0)
    rows.append([x['id'], round(p[0], 6), round(p[1], 6), c, flags, t.get('crossing:barrier', ''), road.get('name', ''), t.get('ref') or t.get('railway:ref') or '', a, b, dA, L, t.get('railway:position', ''), road.get('hw', ''), t.get('name', '')])
    stats[c] += 1
    for lid in lines: per[lid][c] += 1; per[lid]['all'] += 1
out = {'v': 1, 'builtAt': datetime.date.today().isoformat(), 'src': 'OpenStreetMap contributors (ODbL 1.0), Geofabrik Java extract',
       'cols': ['osm', 'lng', 'lat', 'cat', 'flags(1 light,2 bell,4 supervised,8 no light,16 no bell)', 'barrier', 'road', 'ref', 'segA', 'segB', 'm_from_A', 'seg_len', 'railway:position', 'highway', 'name'],
       'stats': dict(stats), 'lines': {k: dict(v) for k, v in per.items()}, 'x': rows}
json.dump(out, open('public/data/jpl.json', 'w'), ensure_ascii=False, separators=(',', ':'))
on = sum(1 for r in rows if r[8])
print('crossings', len(rows), 'on app sections', on, dict(stats), 'with road name', sum(1 for r in rows if r[6]), 'with ref', sum(1 for r in rows if r[7]), 'with position', sum(1 for r in rows if r[12]))
