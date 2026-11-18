import osmium, json, sys
RAIL={'rail','subway','light_rail','monorail','construction','narrow_gauge'}
ways={}; need=set(); stations=[]; rels=[]
class H1(osmium.SimpleHandler):
    def node(self,n):
        t=n.tags
        r=t.get('railway'); pt=t.get('public_transport')
        if r in ('station','halt') or (pt=='station' and (t.get('train')=='yes' or t.get('subway')=='yes' or t.get('light_rail')=='yes')):
            stations.append({'id':n.id,'lat':n.location.lat,'lng':n.location.lon,'tags':dict(t)})
    def way(self,w):
        t=w.tags; r=t.get('railway')
        if r in RAIL or (r=='construction' ) :
            if t.get('service') in ('yard','siding','spur','crossover'): return
            if r=='construction' and t.get('construction') not in ('rail','subway','light_rail','monorail'): return
            refs=[n.ref for n in w.nodes]; ways[w.id]={'n':refs,'tags':dict(t)}; need.update(refs)
    def relation(self,r):
        t=r.tags
        if t.get('type')=='route' and t.get('route') in ('train','subway','light_rail','monorail','tram'):
            rels.append({'id':r.id,'tags':dict(t),'m':[(m.type,m.ref,m.role) for m in r.members]})
        if t.get('type')=='route_master' and t.get('route_master') in ('train','subway','light_rail','monorail'):
            rels.append({'id':r.id,'tags':dict(t),'m':[(m.type,m.ref,m.role) for m in r.members]})
H1().apply_file(sys.argv[1])
print('ways',len(ways),'need',len(need),'stations',len(stations),'rels',len(rels),file=sys.stderr)
# relation stop members that are nodes (platforms/stops) - include their coords
for r in rels:
    for ty,ref,role in r['m']:
        if ty=='n': need.add(ref)
loc={}
class H2(osmium.SimpleHandler):
    def node(self,n):
        if n.id in need: loc[n.id]=(round(n.location.lon,6),round(n.location.lat,6))
H2().apply_file(sys.argv[1])
json.dump({'ways':ways,'loc':{str(k):v for k,v in loc.items()},'stations':stations,'rels':rels},open('osm_rail.json','w'))
print('done',len(loc),file=sys.stderr)
