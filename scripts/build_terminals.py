"""Freight places layer (public/data/terminals.json) from the OSM extract made by extract_freight_osm.py, plus,
for every KA barang line in public/data/freight.json, the OSM freight places within 1.5 km of its end stations
(e.g. a Pertamina fuel depot next to the station where a GAPEKA "Tanker" path starts). Run after build_data.py:
  python3 scripts/build_terminals.py raw/freight_osm.json public/data"""
import json, math, sys, os, re
src, out = sys.argv[1], sys.argv[2]
rows = json.load(open(src))
net = json.load(open(os.path.join(out, 'network.json'))); fr = json.load(open(os.path.join(out, 'freight.json')))
st = {s['id']: s for s in net['stations']}; st.update({s['id']: s for s in fr['stations']})
def hav(a, b):
    p1, p2 = math.radians(a[1]), math.radians(b[1]); dp = p2 - p1; dl = math.radians(b[0] - a[0])
    return 2 * 6371000 * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))
NOISE = re.compile(r'^stasiun\b|\bhalte\b', re.I)
x, seen = [], set()
for r in rows:
    t = r['t']; name = (t.get('name') or '').strip(); op = (t.get('operator') or t.get('brand') or '').strip()
    if r['k'] == 'yard' and (not name or NOISE.search(name)): continue
    d, sid = min((hav((r['lng'], r['lat']), (s['lng'], s['lat'])), k) for k, s in st.items())
    if d > 3000: continue  # keep places next to the rail network
    key = (r['k'], name.lower(), round(r['lng'], 2), round(r['lat'], 2))
    if key in seen: continue
    seen.add(key)
    x.append([round(r['lng'], 5), round(r['lat'], 5), r['k'], name, op, r['osm'], st[sid]['name'], round(d), sid])
x.sort(key=lambda r: (r[2], r[3]))
json.dump({'v': 1, 'src': 'OpenStreetMap contributors (ODbL 1.0), Geofabrik Java extract', 'x': [r[:8] for r in x]},
          open(os.path.join(out, 'terminals.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
ends = {}
for t in fr['daily']: ends.setdefault(t[1], set()).update([t[3][0], t[3][-1]])
for l in fr['lines']:
    near = []
    for r in x:
        want = {'tanker': ('fuel',), 'cargo': ('cargo',), 'parcel': ()}.get(l['cat'], ('fuel', 'cargo'))
        if r[8] in ends.get(l['id'], ()) and r[7] <= 1500 and r[2] in want and r[3]:
            near.append([r[2], r[3], r[4], r[6], r[7], r[5]])
    near.sort(key=lambda n: (n[0] != ('fuel' if l['cat'] == 'tanker' else 'cargo'), n[4]))
    l['near'] = near[:4]
json.dump(fr, open(os.path.join(out, 'freight.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
from collections import Counter
print('terminals', len(x), Counter(r[2] for r in x))
for l in fr['lines']:
    if l['near']: print(l['id'], [(n[1], n[3], n[4]) for n in l['near']])
