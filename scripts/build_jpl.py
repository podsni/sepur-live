"""Build public/data/jpl.json (level crossings + road flyovers/underpasses over the railway) from
raw/jpl_osm2.json (scripts/extract_jpl.py) + app sections (public/data/{network,kai}.json) + station extras
(public/data/stations_x.json: Daop and km from id.wikipedia) + GAPEKA station-to-station km + Commons photos.

Cleaning (all counted in stats.clean):
  * only crossings on active railway track (rail / light_rail / narrow_gauge / subway / monorail); dropped if the node is
    only on disused / abandoned / tram / construction track, or only on industrial-usage track
  * a road (highway way) must pass through the node; dropped if every road there is a bridge or tunnel (tagging error)
  * multi-track duplicates: nodes on the same road within 30 m (or any two within 8 m) are merged into one crossing,
    the number of merged rail ways is kept as 'tracks'
Status (closest equivalents of the categories used by DJKA / 168railway, only where the OSM tags say so):
  tutup  ditutup (disused:railway=level_crossing, or access=no)
  liar   crossing=informal
  jaga   dijaga petugas (supervised=yes / crossing:supervision=attendant / crossing:activation=local|remote)
  oto    berpalang otomatis (crossing:activation=automatic with a barrier)
  palang berpalang, penjagaan belum terdata
  sinyal tidak dijaga, ada lampu / bel
  tdk    tidak dijaga, tanpa palang & sinyal (crossing:barrier=no / crossing=uncontrolled|unmarked)
  ped    perlintasan pejalan kaki (railway=crossing)
  unk    pengaman belum terdata
  fly / under   jalan layang di atas rel / underpass di bawah rel (road and track cross without a shared node and the
                bridge / tunnel / layer tags say which is on top)
Never invents JPL numbers or gate-keeper info: 'ref' is only OSM's ref tag, km is an estimate, labelled as such.
Data: (c) OpenStreetMap contributors (ODbL 1.0); km/Daop: id.wikipedia.org (CC BY-SA 4.0); GAPEKA 2025 distances."""
import json, math, sys, collections, datetime, sqlite3, re, os, time, urllib.request, urllib.parse, html
RAW = '/workspace/raw'
D = json.load(open(sys.argv[1] if len(sys.argv) > 1 else RAW + '/jpl_osm2.json'))
net = json.load(open('public/data/network.json')); kai = json.load(open('public/data/kai.json'))
SX = json.load(open('public/data/stations_x.json'))['s']
segs = {**net['segs'], **kai['segs']}
st = {s['id']: s for s in net['stations']}
R = 6371000
def hav(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1]); dl = la2 - la1; do = math.radians(b[0] - a[0])
    h = math.sin(dl / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(do / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))
ACTIVE = {'rail', 'light_rail', 'subway', 'narrow_gauge', 'monorail'}
MOTOR = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'living_street',
         'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road', 'track'}
RANK = {k: i for i, k in enumerate(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link',
        'primary_link', 'secondary_link', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'road', 'service',
        'track', 'pedestrian', 'cycleway', 'footway', 'path', 'bridleway', 'steps'])}
yes = lambda v: v not in (None, '', 'no', '0', 'false')
# ---------- lines per section, section grid ----------
seglines = collections.defaultdict(set)
def addpath(lid, seq):
    for a, b in zip(seq, seq[1:]): seglines[a + '>' + b if a < b else b + '>' + a].add(lid)
for l in net['lines'] + kai['lines']:
    addpath(l['id'], l['stations'])
    for br in l.get('branches', []): addpath(l['id'], br)
    for p in l.get('pairs', []): a, b = p.split('>'); seglines[a + '>' + b if a < b else b + '>' + a].add(l['id'])
G = 0.005; grid = collections.defaultdict(list); prep = {}
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
# ---------- station Daop (fill gaps from neighbours along sections) ----------
sdaop = {k: v.get('daop', '') for k, v in SX.items()}
adj = collections.defaultdict(set)
for k in segs:
    a, b = k.split('>'); adj[a].add(b); adj[b].add(a)
for _ in range(3):
    for s, v in list(sdaop.items()):
        if v or not any(x in ('kai', 'regional') for x in st[s]['sys']): continue
        nb = collections.Counter(sdaop.get(n) for n in adj[s] if sdaop.get(n))
        if nb: sdaop[s] = nb.most_common(1)[0][0] + '*'   # * = inferred from neighbouring stations
# ---------- official distances (GAPEKA) and station km (Wikipedia) ----------
gkm = {}
try:
    for a, b, km, _ in sqlite3.connect(RAW + '/gapeka/gapeka.db').execute('select * from station_links'):
        if km: gkm[(a, b)] = gkm[(b, a)] = km
except Exception as e: print('no gapeka', e, file=sys.stderr)
def km_est(a, b, dA, L):
    """absolute km of the point (estimate) + method. Each station infobox lists 'km X+Y lintas P-Q-R'; pick the pair of
    entries on the same lintas (shared route names) whose km difference matches the GAPEKA / OSM section length."""
    A, B = SX.get(a, {}).get('km', []), SX.get(b, {}).get('km', [])
    na_, nb_ = st[a]['name'], st[b]['name']; best = None
    for ka, na in A:
        for kb, nb in B:
            dd = abs(kb - ka)
            if dd == 0: continue
            ref = gkm.get((a, b)) or L / 1000
            r = dd / ref if ref else 0
            if not 0.75 < r < 1.33: continue
            sa, sb = set(na) - {na_, nb_}, set(nb) - {na_, nb_}
            ov = len(sa & sb) if sa and sb else 0
            if sa and sb and not ov: continue
            key = (-ov, abs(1 - r))
            if best is None or key < best[0]: best = (key, ka, kb)
    if best:
        _, ka, kb = best
        return ka + (kb - ka) * (dA / L if L else 0), 'wp'
    return None, ''
fmtkm = lambda v: '%d+%03d' % (int(v), round((v - int(v)) * 1000) % 1000) if v is not None else ''
# ---------- crossings: clean ----------
X = {x['id']: x for x in D['x']}; nrail = D['nrail']; nroad = D['nroad']
clean = collections.Counter(); keep = []
for i, x in X.items():
    rw = nrail.get(str(i), []); hw = nroad.get(str(i), [])
    clean['raw'] += 1
    act = [t for _, t in rw if t.get('railway') in ACTIVE]
    if not rw: clean['drop_no_track'] += 1; continue
    if not act: clean['drop_inactive_track'] += 1; continue
    if all(t.get('usage') == 'industrial' for t in act): clean['drop_industrial'] += 1; continue
    if not hw: clean['drop_no_road'] += 1; continue
    if all(yes(t.get('bridge')) or yes(t.get('tunnel')) for _, t in hw): clean['drop_bridge_tunnel'] += 1; continue
    hw = [h for h in hw if not (yes(h[1].get('bridge')) or yes(h[1].get('tunnel')))]
    hw.sort(key=lambda h: (0 if h[1].get('name') else 1, RANK.get(h[1].get('highway'), 99)))
    x['hw'] = hw; x['rw'] = rw; x['act'] = act; keep.append(x)
# merge multi-track duplicates
C = 0.0005; cg = collections.defaultdict(list)
for n, x in enumerate(keep): cg[(math.floor(x['lng'] / C), math.floor(x['lat'] / C))].append(n)
par = list(range(len(keep)))
def find(a):
    while par[a] != a: par[a] = par[par[a]]; a = par[a]
    return a
for n, x in enumerate(keep):
    gx, gy = math.floor(x['lng'] / C), math.floor(x['lat'] / C); ways = {h[0] for h in x['hw']}
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for m in cg.get((gx + dx, gy + dy), ()):
                if m <= n: continue
                y = keep[m]; d = hav((x['lng'], x['lat']), (y['lng'], y['lat']))
                if d < 8 or (d < 30 and ways & {h[0] for h in y['hw']}) or (d < 30 and x['hw'][0][1].get('name') and x['hw'][0][1].get('name') == y['hw'][0][1].get('name')):
                    par[find(m)] = find(n)
groups = collections.defaultdict(list)
for n in range(len(keep)): groups[find(n)].append(keep[n])
clean['merged_duplicates'] = len(keep) - len(groups)
def status(xs):
    t = {}
    for x in xs:
        for k, v in x['t'].items(): t.setdefault(k, v)
    if any(x['life'] for x in xs) or t.get('access') == 'no' or all(h[1].get('access') == 'no' for x in xs for h in x['hw']): return 'tutup', t
    if any(x['k'] == 'crossing' for x in xs) and not any(x['k'] == 'level_crossing' for x in xs): return 'ped', t
    if t.get('crossing') == 'informal': return 'liar', t
    bar = t.get('crossing:barrier'); lit = t.get('crossing:light'); bell = t.get('crossing:bell'); act = t.get('crossing:activation')
    if t.get('supervised') == 'yes' or t.get('crossing:supervision') in ('attendant', 'yes') or act in ('local', 'remote'): return 'jaga', t
    if bar and bar != 'no': return ('oto' if act == 'automatic' else 'palang'), t
    if (lit and lit != 'no') or (bell and bell != 'no'): return 'sinyal', t
    if bar == 'no' or t.get('crossing') in ('uncontrolled', 'unmarked', 'no'): return 'tdk', t
    return 'unk', t
items = []
for g in groups.values():
    c, t = status(g)
    rep = min(g, key=lambda x: (x['life'] is not None, -len(x['t'])))
    lng = sum(x['lng'] for x in g) / len(g); lat = sum(x['lat'] for x in g) / len(g)
    road = rep['hw'][0][1]
    tracks = len({w for x in g for w, tt in x['rw'] if tt.get('railway') in ACTIVE})
    items.append({'ids': [x['id'] for x in g], 'p': [lng, lat], 'c': c, 't': t, 'road': road, 'tracks': tracks})
# ---------- grade separations ----------
rails = [r for r in D['rails'] if r[1].get('service') not in ('yard', 'siding', 'spur', 'crossover') and r[1].get('usage') != 'industrial']
RG = 0.002; rgrid = collections.defaultdict(list)
for ri, (wid, tg, c) in enumerate(rails):
    for j in range(len(c) - 1):
        x0, x1 = sorted((c[j][0], c[j + 1][0])); y0, y1 = sorted((c[j][1], c[j + 1][1]))
        for gx in range(math.floor(x0 / RG), math.floor(x1 / RG) + 1):
            for gy in range(math.floor(y0 / RG), math.floor(y1 / RG) + 1): rgrid[(gx, gy)].append((ri, j))
def inter(p1, p2, p3, p4):
    d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
    if d == 0: return None
    u = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
    v = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
    if 0 <= u <= 1 and 0 <= v <= 1: return [p1[0] + u * (p2[0] - p1[0]), p1[1] + u * (p2[1] - p1[1])]
    return None
lay = lambda t: int(t.get('layer', '0')) if re.fullmatch(r'-?\d+', str(t.get('layer', '0'))) else 0
gs = []; gcount = collections.Counter()
for wid, tg, c in D['roads']:
    if tg.get('highway') not in MOTOR or tg.get('highway') in ('service', 'track'): continue
    for j in range(len(c) - 1):
        a, b = c[j], c[j + 1]
        x0, x1 = sorted((a[0], b[0])); y0, y1 = sorted((a[1], b[1])); seen = set()
        for gx in range(math.floor(x0 / RG), math.floor(x1 / RG) + 1):
            for gy in range(math.floor(y0 / RG), math.floor(y1 / RG) + 1):
                for ri, k in rgrid.get((gx, gy), ()):
                    if (ri, k) in seen: continue
                    seen.add((ri, k)); rc = rails[ri][2]; p, q = rc[k], rc[k + 1]
                    if a[2] in (p[2], q[2]) or b[2] in (p[2], q[2]): continue
                    pt = inter(a, b, p, q)
                    if not pt: continue
                    rt = rails[ri][1]
                    if yes(tg.get('bridge')) or lay(tg) > lay(rt) and not yes(rt.get('bridge')): kind = 'fly'
                    elif yes(tg.get('tunnel')) or yes(rt.get('bridge')) or lay(rt) > lay(tg): kind = 'under'
                    else: gcount['untagged_overlap'] += 1; continue
                    gs.append({'p': pt, 'c': kind, 'road': tg, 'wid': wid, 'rw': rails[ri][0]})
# cluster grade separations (double track, dual carriageway): same kind within 40 m and same road name or way
gs.sort(key=lambda g: (g['p'][0], g['p'][1])); gsel = []
for g in gs:
    dup = False
    for h in gsel[-60:]:
        if h['c'] == g['c'] and hav(h['p'], g['p']) < 45 and (h['wid'] == g['wid'] or (h['road'].get('name') or '#') == (g['road'].get('name') or '#') or hav(h['p'], g['p']) < 20):
            h['n'] += 1; dup = True; break
    if not dup: g['n'] = 1; gsel.append(g)
# drop grade separations sitting on a level crossing (mapping noise)
lc = collections.defaultdict(list)
for it in items: lc[(math.floor(it['p'][0] / C), math.floor(it['p'][1] / C))].append(it)
def near_lc(p):
    gx, gy = math.floor(p[0] / C), math.floor(p[1] / C)
    return any(hav(p, it['p']) < 15 for dx in (-1, 0, 1) for dy in (-1, 0, 1) for it in lc.get((gx + dx, gy + dy), ()))
gsel = [g for g in gsel if not near_lc(g['p'])]
gcount['fly'] = sum(1 for g in gsel if g['c'] == 'fly'); gcount['under'] = sum(1 for g in gsel if g['c'] == 'under')
for g in gsel: items.append({'ids': [g['wid']], 'p': g['p'], 'c': g['c'], 't': {}, 'road': g['road'], 'tracks': 0, 'gs': True})
# ---------- photos ----------
UA = {'User-Agent': 'SepurLive/1.0 (https://github.com/podsni/sepur-live)'}
geo = json.load(open(RAW + '/commons_geo.json')) if os.path.exists(RAW + '/commons_geo.json') else []
KW1 = re.compile(r'perlintasan|level[ _-]?crossing|railroad[ _-]?crossing|railway[ _-]?crossing|palang|\bjpl\b|overweg|spoorwegovergang', re.I)
KWG = re.compile(r'jembatan[ _-]?layang|flyover|fly[ _-]over|underpass|terowongan|viaduct|viaduk|overpass', re.I)
KW2 = re.compile(r'\brel\b|railway|rail\b|railroad|kereta|\bkrl\b|\btrain\b|lokomotif|locomotive|\bcc ?20[1-6]|\bcc ?30[0-9]|commuter|sepur|track', re.I)
EXCL = re.compile(r'stasiun|station(?! road)|\bplatform\b|peron|\bstop\b|halte|museum|collision|kecelakaan|accident|tabrakan|anjlok|wreck|derail|korban|coffee|\bcup\b|interior|suasana|inside|on the train|di dalam', re.I)
gg = collections.defaultdict(list); PG = 0.001
for f, la, lo in geo: gg[(math.floor(lo / PG), math.floor(la / PG))].append((f, lo, la))
def photo_for(it):
    for k in ('wikimedia_commons', 'image'):
        v = it['t'].get(k, '')
        m = re.search(r'(?:File:|/wiki/File:)([^|#?]+\.(?:jpe?g|png|webp|tiff?))', v, re.I)
        if m: return urllib.parse.unquote(m.group(1)).replace('_', ' '), 0, 'osm'
    p = it['p']; gx, gy = math.floor(p[0] / PG), math.floor(p[1] / PG); best = None
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for f, lo, la in gg.get((gx + dx, gy + dy), ()):
                d = hav(p, (lo, la))
                if EXCL.search(f): continue
                k1 = KWG if it.get('gs') else KW1
                tier = 1 if k1.search(f) and d <= 60 else 2 if KW2.search(f) and d <= 35 else 0
                if tier and (best is None or (tier, d) < (best[2], best[1])): best = (f, d, tier)
    return (best[0], best[1], 'geo%d' % best[2]) if best else None
ph = {}
for n, it in enumerate(items):
    r = photo_for(it)
    if r: ph[n] = r
cache_f = RAW + '/commons_info.json'; cache = json.load(open(cache_f)) if os.path.exists(cache_f) else {}
need = sorted({r[0] for r in ph.values()} - set(cache))
for i in range(0, len(need), 40):
    p = {'action': 'query', 'titles': '|'.join('File:' + f for f in need[i:i + 40]), 'prop': 'imageinfo', 'iiprop': 'url|extmetadata|size|mime',
         'iiurlwidth': '500', 'iiextmetadatafilter': 'Artist|LicenseShortName|LicenseUrl|ImageDescription|DateTimeOriginal', 'format': 'json', 'formatversion': '2'}
    r = json.load(urllib.request.urlopen(urllib.request.Request('https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode(p), headers=UA), timeout=90))
    nm = {q['to']: q['from'] for q in r['query'].get('normalized', [])}
    for pg in r['query']['pages']:
        key = nm.get(pg['title'], pg['title'])[5:]
        if 'imageinfo' not in pg: cache[key] = None; continue
        ii = pg['imageinfo'][0]; md = ii.get('extmetadata', {})
        art = re.sub(r'\s*\((talk|bicara)[^)]*\)', '', html.unescape(re.sub(r'<[^>]+>', '', md.get('Artist', {}).get('value', '')))).strip()
        desc = html.unescape(re.sub(r'<[^>]+>', '', md.get('ImageDescription', {}).get('value', ''))).strip()
        cache[key] = {'t': (ii.get('thumburl') or '').split('?')[0], 'w': ii.get('thumbwidth'), 'h': ii.get('thumbheight'), 'p': ii.get('descriptionurl'), 'mime': ii.get('mime'),
                      'a': art[:80] or 'Wikimedia Commons', 'l': md.get('LicenseShortName', {}).get('value', ''), 'lu': md.get('LicenseUrl', {}).get('value', ''),
                      'dt': md.get('DateTimeOriginal', {}).get('value', '')[:10], 'ds': desc[:200]}
    time.sleep(0.3)
json.dump(cache, open(cache_f, 'w'), ensure_ascii=False)
photos = []; pidx = {}
for n, (f, d, via) in ph.items():
    ci = cache.get(f) or cache.get(f.replace(' ', '_'))
    if not ci or not ci.get('t') or (ci.get('mime') or '').startswith(('video', 'audio', 'application')): continue
    # second check on the description for tier-2 matches
    if via == 'geo2' and not (KW1.search(ci.get('ds', '')) or KW2.search(ci.get('ds', '') + ' ' + f)): continue
    if EXCL.search(ci.get('ds', '')): continue
    pidx[n] = len(photos)
    photos.append([f, ci['t'], ci['w'], ci['h'], ci['a'], ci['l'], ci['lu'], ci['p'], round(d), via, ci.get('dt', '')])
# ---------- rows ----------
CONF = lambda it: (3 if it['c'] not in ('unk',) and (it['road'].get('name') or it.get('gs')) else 2 if it['c'] != 'unk' or it['road'].get('name') else 1)
rows = []; stats = collections.Counter(); per = collections.defaultdict(collections.Counter); dstat = collections.defaultdict(collections.Counter)
kmc = collections.Counter()
for n, it in enumerate(items):
    p = it['p']; t = it['t']; road = it['road']; s = snap(p); a = b = ''; dA = L = -1; lines = []
    if s and s[0] <= (40 if not it.get('gs') else 60):
        k = s[1]; a, b = k.split('>'); dA, L = round(s[2]), round(s[3]); lines = sorted(seglines.get(k, ()))
    km, kmsrc = (None, '')
    pos = t.get('railway:position:exact') or t.get('railway:position') or ''
    if re.fullmatch(r'\d+(\.\d+)?', pos): pos = fmtkm(float(pos))
    elif not re.fullmatch(r'\d+\+\d{3}', pos): pos = ''
    if a: km, kmsrc = km_est(a, b, dA, L)
    kmc['osm_position' if pos else kmsrc or ('none_on_section' if a else 'off_section')] += 1
    da = ''
    if a:
        A_, B_ = sdaop.get(a, ''), sdaop.get(b, '')
        da = A_ if A_.rstrip('*') == B_.rstrip('*') else (A_ if dA <= L / 2 else B_) or A_ or B_
    else:
        cand = sorted(((hav(p, (x['lng'], x['lat'])), k) for k, x in st.items() if sdaop.get(k)), key=lambda z: z[0])[:1]
        if cand and cand[0][0] < 15000: da = sdaop[cand[0][1]].rstrip('*') + '*'
    daop = da.rstrip('*'); dinf = da.endswith('*') or (a and sdaop.get(a, '').rstrip('*') != sdaop.get(b, '').rstrip('*'))
    flags = (1 if t.get('crossing:light', 'no') != 'no' else 0) | (2 if t.get('crossing:bell', 'no') != 'no' else 0) | \
            (4 if it['c'] == 'jaga' else 0) | (8 if t.get('crossing:light') == 'no' else 0) | (16 if t.get('crossing:bell') == 'no' else 0) | \
            (32 if dinf else 0) | (64 if t.get('mapillary') else 0)
    src = 'osm' + ('+wp' if kmsrc == 'wp' else '')
    conf = CONF(it)
    rows.append([it['ids'][0], round(p[0], 6), round(p[1], 6), it['c'], flags, t.get('crossing:barrier', ''), road.get('name', ''), t.get('ref') or t.get('railway:ref') or '',
                 a, b, dA, L, pos or fmtkm(km), road.get('highway', ''), t.get('name', ''), daop, it['tracks'], conf, src, pidx.get(n, -1),
                 t.get('mapillary', ''), len(it['ids']) if not it.get('gs') else 0])
    stats[it['c']] += 1; dstat[daop or '-'][it['c']] += 1; dstat[daop or '-']['all'] += 1
    for lid in lines: per[lid][it['c']] += 1; per[lid]['all'] += 1
out = {'v': 2, 'builtAt': datetime.date.today().isoformat(),
       'src': 'OpenStreetMap contributors (ODbL 1.0), Geofabrik Java extract; km & Daop: id.wikipedia.org station infoboxes (CC BY-SA 4.0) + GAPEKA distances; photos: Wikimedia Commons',
       'cols': ['osm', 'lng', 'lat', 'cat', 'flags(1 light,2 bell,4 attended,8 no light,16 no bell,32 daop inferred,64 mapillary)', 'barrier', 'road', 'ref', 'segA', 'segB', 'm_from_A', 'seg_len',
                'km', 'highway', 'name', 'daop', 'tracks', 'conf(1-3)', 'src', 'photo', 'mapillary', 'osm_nodes'],
       'photoCols': ['file', 'thumb', 'w', 'h', 'author', 'licence', 'licenceUrl', 'page', 'dist_m', 'via', 'date'],
       'stats': dict(stats), 'daop': {k: dict(v) for k, v in sorted(dstat.items())}, 'lines': {k: dict(v) for k, v in per.items()},
       'clean': {**clean, 'grade_sep': dict(gcount), 'km': dict(kmc)}, 'photos': photos, 'x': rows}
json.dump(out, open('public/data/jpl.json', 'w'), ensure_ascii=False, separators=(',', ':'))
lcn = [r for r in rows if r[3] not in ('fly', 'under')]
print(json.dumps({'level_crossings': len(lcn), 'grade_sep': len(rows) - len(lcn), 'on_sections': sum(1 for r in lcn if r[8]), 'cats': dict(stats),
                  'named': sum(1 for r in lcn if r[6]), 'ref': sum(1 for r in lcn if r[7]), 'km': sum(1 for r in lcn if r[12]), 'daop': sum(1 for r in lcn if r[15]),
                  'photo': sum(1 for r in lcn if r[19] >= 0), 'photo_gs': sum(1 for r in rows if r[19] >= 0) - sum(1 for r in lcn if r[19] >= 0),
                  'conf': dict(collections.Counter(r[17] for r in lcn)), 'clean': out['clean'], 'daopc': {k: v['all'] for k, v in out['daop'].items()}}, indent=1))
