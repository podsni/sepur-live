"""Extract railway level crossings and grade separations near railways from an OSM .pbf (pyosmium, one pass with node
locations on disk). Writes a raw JSON consumed by scripts/build_jpl.py.
Usage: python3 scripts/extract_jpl.py java-latest.osm.pbf raw/osm_rail.json raw/jpl_osm.json [node-index-file]
  raw/osm_rail.json (from extract_osm.py) is used only to build a mask of 0.002 deg cells along the railway, so that only
  road segments near the track are kept (for flyover / underpass detection).
Data: (c) OpenStreetMap contributors, ODbL 1.0."""
import osmium, json, sys, math
pbf, railjs, out = sys.argv[1], sys.argv[2], sys.argv[3]
idxf = sys.argv[4] if len(sys.argv) > 4 else '/workspace/raw/nodes.idx'
KEEP = ('crossing:barrier', 'crossing:light', 'crossing:bell', 'crossing:supervision', 'supervised', 'crossing:activation',
        'crossing:saltire', 'crossing', 'ref', 'name', 'railway:ref', 'railway:position', 'railway:position:exact', 'note',
        'description', 'crossing:on_demand', 'level_crossing', 'access', 'disused', 'abandoned', 'image', 'wikimedia_commons',
        'mapillary', 'check_date', 'survey:date', 'operator', 'start_date')
RAILALL = {'rail', 'light_rail', 'subway', 'narrow_gauge', 'monorail', 'tram', 'disused', 'abandoned', 'razed', 'construction',
           'preserved', 'proposed', 'funicular', 'miniature'}
ROADS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'living_street',
         'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road', 'track', 'pedestrian',
         'footway', 'path', 'cycleway', 'steps', 'bridleway'}
HT = ('highway', 'name', 'ref', 'bridge', 'tunnel', 'layer', 'access', 'motor_vehicle', 'surface', 'lanes', 'covered', 'level')
RT = ('railway', 'service', 'usage', 'bridge', 'tunnel', 'layer', 'name', 'electrified', 'gauge', 'disused', 'operator')
G = 0.002
R = json.load(open(railjs)); loc = R['loc']; mask = set()
for w in R['ways'].values():
    pts = [loc[str(n)] for n in w['n'] if str(n) in loc]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        k = max(1, int(max(abs(x1 - x0), abs(y1 - y0)) / (G / 2)))
        for i in range(k + 1):
            x, y = x0 + (x1 - x0) * i / k, y0 + (y1 - y0) * i / k
            mask.add((math.floor(x / G), math.floor(y / G)))
del R, loc
print('mask cells', len(mask), file=sys.stderr)
xs, nrail, nroad, rails, roads = {}, {}, {}, [], []
class H(osmium.SimpleHandler):
    def node(self, n):
        t = n.tags; r = t.get('railway'); life = None
        for p in ('disused:railway', 'abandoned:railway', 'razed:railway', 'removed:railway', 'was:railway'):
            if t.get(p) in ('level_crossing', 'crossing'): life = p.split(':')[0]; r = t.get(p)
        if r in ('level_crossing', 'crossing'):
            xs[n.id] = {'id': n.id, 'lat': round(n.location.lat, 7), 'lng': round(n.location.lon, 7), 'k': r, 'life': life,
                        't': {k: v for k, v in t if k in KEEP}}
    def way(self, w):
        t = w.tags; r = t.get('railway'); h = t.get('highway')
        if r in RAILALL or (h and h in ROADS):
            nodes = w.nodes
            hit = [nd.ref for nd in nodes if nd.ref in xs]
            if r in RAILALL:
                tg = {k: t.get(k) for k in RT if k in t}
                for x in hit: nrail.setdefault(x, []).append([w.id, tg])
                if r in ('rail', 'light_rail', 'subway', 'narrow_gauge', 'monorail'):
                    try: c = [[round(nd.lon, 7), round(nd.lat, 7), nd.ref] for nd in nodes]
                    except Exception: return
                    rails.append([w.id, tg, c])
            elif h:
                tg = {k: t.get(k) for k in HT if k in t}
                for x in hit: nroad.setdefault(x, []).append([w.id, tg])
                try: c = [[round(nd.lon, 7), round(nd.lat, 7), nd.ref] for nd in nodes]
                except Exception: return
                keep = [any((math.floor(p[0] / G) + dx, math.floor(p[1] / G) + dy) in mask for dx in (-1, 0, 1) for dy in (-1, 0, 1)) for p in c]
                if not any(keep): return
                seg = []
                for i in range(len(c)):
                    if keep[i] or (i and keep[i - 1]) or (i + 1 < len(c) and keep[i + 1]): seg.append(c[i])
                    elif seg: roads.append([w.id, tg, seg]); seg = []
                if len(seg) > 1: roads.append([w.id, tg, seg])
H().apply_file(pbf, locations=True, idx='sparse_file_array,' + idxf)
json.dump({'x': list(xs.values()), 'nrail': nrail, 'nroad': nroad, 'rails': rails, 'roads': roads}, open(out, 'w'), separators=(',', ':'))
print('crossings', len(xs), 'rail ways', len(rails), 'road pieces near rail', len(roads), file=sys.stderr)
