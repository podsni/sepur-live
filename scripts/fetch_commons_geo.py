"""Collect geotagged Wikimedia Commons files around level crossings (list=geosearch on a grid that covers every crossing).
Usage: python3 scripts/fetch_commons_geo.py raw/jpl_osm2.json raw/commons_geo.json
Only files within 50 m of a crossing whose title/description mentions a crossing or railway are used later (build_jpl.py)."""
import json, math, sys, time, urllib.request, urllib.parse
UA = {'User-Agent': 'SepurLive/1.0 (https://github.com/podsni/sepur-live)'}
X = json.load(open(sys.argv[1]))['x']; out = sys.argv[2]
C = 0.02; cells = sorted({(math.floor(x['lng'] / C), math.floor(x['lat'] / C)) for x in X})
print('cells', len(cells), file=sys.stderr)
seen = {}
for n, (cx, cy) in enumerate(cells):
    lat, lng = (cy + 0.5) * C, (cx + 0.5) * C
    p = {'action': 'query', 'list': 'geosearch', 'gscoord': f'{lat}|{lng}', 'gsradius': '1650', 'gslimit': '500',
         'gsnamespace': '6', 'format': 'json', 'formatversion': '2'}
    for i in range(4):
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request('https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode(p), headers=UA), timeout=60)); break
        except Exception as e:
            print('retry', e, file=sys.stderr); time.sleep(5 * (i + 1))
    else: continue
    for g in r.get('query', {}).get('geosearch', []): seen[g['pageid']] = [g['title'][5:], g['lat'], g['lon']]
    if n % 50 == 0: print(n, len(seen), file=sys.stderr)
    time.sleep(0.15)
json.dump(list(seen.values()), open(out, 'w'), ensure_ascii=False)
print('files', len(seen), file=sys.stderr)
