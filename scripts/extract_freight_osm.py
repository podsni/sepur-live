"""Freight places from OpenStreetMap near the railway: rail yards (landuse=railway, railway=yard),
fuel terminals (Pertamina / TBBM / fuel depots) and container / cargo terminals and dry ports.
Run: python3 scripts/extract_freight_osm.py java-latest.osm.pbf raw/freight_osm.json   (needs pyosmium)"""
import osmium, json, sys, re, os, tempfile
pbf, out = sys.argv[1], sys.argv[2]
FUEL = re.compile(r'pertamina|\btbbm\b|\bbbm\b|fuel terminal|integrated terminal|oil terminal|depot (minyak|bbm)|kilang|refinery', re.I)
CARGO = re.compile(r'peti ?kemas|container|kontainer|dry ?port|pelabuhan darat|terminal barang|cargo|logistik|\bicd\b|inland', re.I)
res = []
def keep(t):
    nm = ' '.join(t.get(k, '') for k in ('name', 'operator', 'brand', 'official_name'))
    if t.get('landuse') == 'railway' and t.get('name'): return 'yard'
    if t.get('railway') == 'yard': return 'yard'
    if t.get('industrial') in ('oil', 'fuel', 'refinery') or t.get('man_made') == 'petroleum_well': return 'fuel' if FUEL.search(nm) else None
    if FUEL.search(nm) and (t.get('landuse') == 'industrial' or t.get('industrial') or t.get('amenity') != 'fuel' and t.get('man_made') in ('storage_tank', 'works')): return 'fuel'
    if CARGO.search(nm) and (t.get('landuse') in ('industrial', 'port', 'railway') or t.get('industrial') in ('port', 'logistics', 'warehouse', 'container_terminal') or t.get('building') == 'warehouse'): return 'cargo'
    return None
class H(osmium.SimpleHandler):
    def node(self, n):
        k = keep(n.tags)
        if k: res.append({'k': k, 'osm': 'n' + str(n.id), 'lng': n.location.lon, 'lat': n.location.lat, 't': dict(n.tags)})
    def way(self, w):
        k = keep(w.tags)
        if not k: return
        xs = [(n.lon, n.lat) for n in w.nodes if n.location.valid()]
        if not xs: return
        res.append({'k': k, 'osm': 'w' + str(w.id), 'lng': sum(x for x, _ in xs) / len(xs), 'lat': sum(y for _, y in xs) / len(xs),
                    'bbox': [min(x for x, _ in xs), min(y for _, y in xs), max(x for x, _ in xs), max(y for _, y in xs)], 't': dict(w.tags)})
idx = os.environ.get('NODE_IDX') or os.path.join(tempfile.gettempdir(), 'freight_nodes.idx')
H().apply_file(pbf, locations=True, idx='sparse_file_array,' + idx)
json.dump(res, open(out, 'w'), ensure_ascii=False)
from collections import Counter
print(len(res), Counter(r['k'] for r in res))
