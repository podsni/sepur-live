"""Station extras: photo (Wikidata P18 -> Wikimedia Commons thumbnail, with author + licence), Daop/Divre and km
positions (from the Indonesian Wikipedia station infobox, CC BY-SA 4.0). Writes public/data/stations_x.json.
Matching: app station -> OSM station (by id / railway:ref / name+distance) -> OSM wikidata tag; fallback Wikidata
station code (P296) query. Usage: python3 scripts/fetch_stations.py"""
import json, math, re, time, urllib.request, urllib.parse, collections, sys, html
UA = {'User-Agent': 'SepurLive/1.0 (https://github.com/podsni/sepur-live)'}
def get(url, data=None, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            return json.load(urllib.request.urlopen(req, timeout=90))
        except Exception as e:
            print('retry', url[:90], e, file=sys.stderr); time.sleep(3 * (i + 1))
    raise SystemExit('failed ' + url[:120])
def api(base, **p):
    p.update(format='json', formatversion='2')
    return get(base + '?' + urllib.parse.urlencode(p))
def hav(a, b):
    la1, la2 = math.radians(a[0]), math.radians(b[0]); dl = la2 - la1; do = math.radians(b[1] - a[1])
    return 2 * 6371000 * math.asin(math.sqrt(math.sin(dl / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(do / 2) ** 2))
norm = lambda s: re.sub(r'[^a-z0-9]', '', (s or '').lower().replace('stasiun', ''))
net = json.load(open('public/data/network.json'))
osm = json.load(open('/workspace/raw/osm_rail.json'))['stations']
byid = {'o%d' % s['id']: s for s in osm}
byref = collections.defaultdict(list)
for s in osm:
    for r in (s['tags'].get('railway:ref') or '').split(';'): byref[r.strip().upper()].append(s)
match = {}
for s in net['stations']:
    o = byid.get(s['id'])
    if not o:
        c = [x for x in byref.get(s['id'].upper(), []) if hav((s['lat'], s['lng']), (x['lat'], x['lng'])) < 3000]
        if c: o = min(c, key=lambda x: hav((s['lat'], s['lng']), (x['lat'], x['lng'])))
    if not o:
        c = sorted(osm, key=lambda x: hav((s['lat'], s['lng']), (x['lat'], x['lng'])))[:3]
        for x in c:
            d = hav((s['lat'], s['lng']), (x['lat'], x['lng']))
            if d < 600 and (norm(x['tags'].get('name')) == norm(s['name']) or d < 150): o = x; break
    match[s['id']] = o
wd = {k: o['tags'].get('wikidata') for k, o in match.items() if o and o['tags'].get('wikidata')}
wp = {k: o['tags']['wikipedia'][3:] for k, o in match.items() if o and (o['tags'].get('wikipedia') or '').startswith('id:')}
print('stations', len(net['stations']), 'osm matched', sum(1 for o in match.values() if o), 'wikidata', len(wd), file=sys.stderr)
# fallback: Wikidata station code P296 in Indonesia
q = 'SELECT ?s ?c ?coord WHERE { ?s wdt:P296 ?c; wdt:P17 wd:Q252; wdt:P625 ?coord . }'
res = get('https://query.wikidata.org/sparql?' + urllib.parse.urlencode({'query': q, 'format': 'json'}))
code = collections.defaultdict(list)
for b in res['results']['bindings']:
    m = re.match(r'Point\(([-\d.]+) ([-\d.]+)\)', b['coord']['value'])
    if m: code[b['c']['value'].upper()].append((b['s']['value'].rsplit('/', 1)[1], float(m.group(2)), float(m.group(1))))
st = {s['id']: s for s in net['stations']}
for k, s in st.items():
    if k in wd: continue
    c = [x for x in code.get(k.upper(), []) if hav((s['lat'], s['lng']), (x[1], x[2])) < 2000]
    if c: wd[k] = c[0][0]
print('wikidata after P296 fallback', len(wd), file=sys.stderr)
# entities
ent = {}
ids = sorted(set(wd.values()))
for i in range(0, len(ids), 50):
    r = api('https://www.wikidata.org/w/api.php', action='wbgetentities', ids='|'.join(ids[i:i + 50]), props='claims|sitelinks', sitefilter='idwiki')
    ent.update(r['entities']); time.sleep(0.3)
def claim(e, p):
    v = []
    for c in e.get('claims', {}).get(p, []):
        if c.get('rank') == 'deprecated': continue
        dv = c['mainsnak'].get('datavalue')
        if dv: v.append(dv['value'])
    return v
img = {}
for k, q in wd.items():
    e = ent.get(q) or {}
    p18 = claim(e, 'P18')
    if p18: img[k] = p18[0]
    sl = e.get('sitelinks', {}).get('idwiki')
    if sl and k not in wp: wp[k] = sl['title']
print('P18 photos', len(img), 'idwiki', len(wp), file=sys.stderr)
# Commons file info
info = {}
files = sorted(set(img.values()))
for i in range(0, len(files), 40):
    r = api('https://commons.wikimedia.org/w/api.php', action='query', titles='|'.join('File:' + f for f in files[i:i + 40]),
            prop='imageinfo', iiprop='url|extmetadata|size', iiurlwidth='500', iiextmetadatafilter='Artist|LicenseShortName|LicenseUrl|AttributionRequired|Credit')
    norm_map = {n['to']: n['from'] for n in r['query'].get('normalized', [])}
    for p in r['query']['pages']:
        if 'imageinfo' not in p: continue
        ii = p['imageinfo'][0]; md = ii.get('extmetadata', {})
        art = html.unescape(re.sub(r'<[^>]+>', '', md.get('Artist', {}).get('value', ''))).strip()
        art = re.sub(r'\s*\((talk|bicara)[^)]*\)', '', art).strip()
        info[norm_map.get(p['title'], p['title'])[5:].replace('_', ' ')] = {
            't': (ii.get('thumburl') or '').split('?')[0], 'w': ii.get('thumbwidth'), 'h': ii.get('thumbheight'), 'p': ii.get('descriptionurl'),
            'a': art[:80] or 'Wikimedia Commons', 'l': md.get('LicenseShortName', {}).get('value', ''), 'lu': md.get('LicenseUrl', {}).get('value', '')}
    time.sleep(0.3)
# Wikipedia infobox: daop + km
wtx = {}
titles = sorted(set(wp.values()))
for i in range(0, len(titles), 40):
    r = api('https://id.wikipedia.org/w/api.php', action='query', titles='|'.join(titles[i:i + 40]), prop='revisions', rvprop='content', rvslots='main', redirects='1')
    rmap = {}
    for n in r['query'].get('normalized', []) + r['query'].get('redirects', []): rmap[n['to']] = rmap.get(n['from'], n['from'])
    for p in r['query']['pages']:
        if 'revisions' in p:
            t = p['title']; src = rmap.get(t, t)
            wtx[src] = wtx[t] = p['revisions'][0]['slots']['main']['content']
    time.sleep(0.3)
ROM = {'i': 1, 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6, 'vii': 7, 'viii': 8, 'ix': 9}
def daop(t):
    m = re.search(r'\|\s*operator\s*=\s*(daop|divre)\s*(\d+)', t, re.I)
    if m: return ('Daop ' if m.group(1).lower() == 'daop' else 'Divre ') + m.group(2)
    m = re.search(r'(Daerah Operasi|Daop|Divisi Regional|Divre)\s+([IVX]+|\d+)\b', t)
    if m:
        n = m.group(2); n = ROM.get(n.lower(), n)
        return ('Daop ' if m.group(1) in ('Daerah Operasi', 'Daop') else 'Divre ') + str(n)
    return ''
def kms(t):
    m = re.search(r'\|\s*letak\s*=(.*?)(\n\|\s*[a-z_ ]+\s*=)', t, re.S)
    if not m: return []
    out = []
    for km, lin in re.findall(r'km\s*(\d+\+\d+)\s*(?:lintas)?\s*([^\n*]*)', m.group(1)):
        a, b = km.split('+'); names = re.findall(r'\[\[(?:Stasiun )?([^|\]]+)(?:\|([^\]]+))?\]\]', lin)
        names = [ (y or x).replace('Stasiun ', '').strip() for x, y in names] + re.findall(r"'''([^']+)'''", lin)
        out.append([int(a) + int(b) / 1000, names])
    return out
X = {}
for k in st:
    r = {}
    if k in wd: r['wd'] = wd[k]
    f = img.get(k)
    if f and f in info and info[f]['t']: r['img'] = {'f': f, **info[f]}
    t = wtx.get(wp.get(k, ''), '')
    if t:
        r['wp'] = wp[k]; d = daop(t)
        if d: r['daop'] = d
        km = kms(t)
        if km: r['km'] = km
    X[k] = r
cov = lambda f: sum(1 for v in X.values() if f(v))
stats = {'stations': len(X), 'wikidata': cov(lambda v: 'wd' in v), 'photo': cov(lambda v: 'img' in v), 'daop': cov(lambda v: 'daop' in v), 'km': cov(lambda v: 'km' in v)}
json.dump({'v': 1, 'src': 'Wikidata (CC0), Wikimedia Commons (per-file licence), id.wikipedia.org (CC BY-SA 4.0)', 'stats': stats, 's': X},
          open('public/data/stations_x.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print(stats, file=sys.stderr)
