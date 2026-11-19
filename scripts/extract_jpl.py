"""Extract railway level crossings (railway=level_crossing / crossing) from an OSM .pbf, with the crossing road.
Usage: python3 scripts/extract_jpl.py java-latest.osm.pbf raw/jpl_osm.json   (pyosmium)
Data: (c) OpenStreetMap contributors, ODbL 1.0."""
import osmium, json, sys
KEEP = ('crossing:barrier', 'crossing:light', 'crossing:bell', 'crossing:supervision', 'supervised', 'crossing:activation',
        'crossing:saltire', 'crossing', 'ref', 'name', 'railway:ref', 'railway:position', 'note', 'description', 'crossing:on_demand', 'level_crossing')
RAIL = {'rail', 'light_rail', 'subway', 'narrow_gauge', 'monorail'}
xs, rail, road = {}, set(), {}
class H(osmium.SimpleHandler):
    def node(self, n):
        r = n.tags.get('railway')
        if r in ('level_crossing', 'crossing'):
            xs[n.id] = {'id': n.id, 'lat': round(n.location.lat, 6), 'lng': round(n.location.lon, 6), 'k': r,
                        't': {k: v for k, v in n.tags if k in KEEP}}
    def way(self, w):
        t = w.tags
        hit = [nd.ref for nd in w.nodes if nd.ref in xs]
        if not hit: return
        if t.get('railway') in RAIL and t.get('service') not in ('yard',):
            rail.update(hit)
        elif 'highway' in t:
            for h in hit:
                cur = road.get(h)
                cand = {'hw': t.get('highway'), 'name': t.get('name') or t.get('ref') or '', 'ref': t.get('ref', '')}
                if not cur or (not cur['name'] and cand['name']): road[h] = cand
H().apply_file(sys.argv[1])
out = []
for i, x in xs.items():
    if i not in rail: continue  # only crossings on active railway track
    if i in road: x['road'] = road[i]
    out.append(x)
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False)
print('crossings', len(xs), 'on active rail', len(out), 'with road', sum(1 for x in out if 'road' in x), file=sys.stderr)
