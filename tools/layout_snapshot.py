"""Print current layout polygons for the satellite overlay (no duplicated plan)."""
import json,math,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'blender'))
import layout as L
items=[]
for b in L.BLD:
    if b.get('hidden'):continue
    x,y=b['pos'];w,d=b['size'];a=math.radians(b.get('rot',0));c,s=math.cos(a),math.sin(a)
    centres=[(x,y+off) for off in b['blocks']] if b['kind']=='twin' else [(x,y)]
    for x,y in centres:
        pts=[(x+u*c-v*s,y+u*s+v*c) for u,v in ((-w/2,-d/2),(w/2,-d/2),(w/2,d/2),(-w/2,d/2))]
        trim=b.get('contact_trim')
        if trim:pts=[(xx,max(yy,trim['y']) if xx>=trim['x'] else yy) for xx,yy in pts]
        items.append(dict(name=b['name'],points=pts))
print(json.dumps(dict(boundary=L.BOUNDARY,buildings=items,steps=L.stair_specs(),roads=L.ROADS,
                      track=L.TRACK,gates=L.GATES),ensure_ascii=False))
