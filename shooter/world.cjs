const fs=require('node:fs');
const path=require('node:path');
const YUKA=require('yuka');
const meta=JSON.parse(fs.readFileSync(path.join(__dirname,'../web/assets/campus_meta.json'),'utf8'));
const clinicAccess=require('../web/js/clinic.js').create(require('../web/js/terrain.js').create(meta.terrain.config),meta.colliders);
const terrain=clinicAccess.terrain;meta.colliders=clinicAccess.colliders;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function boxRay(c,o,d,max){
  const cs=Math.cos(c.rot),sn=Math.sin(c.rot),dx=o.x-c.px,dz=o.z-c.pz;
  const p=[dx*cs+dz*sn,o.y-c.py,-dx*sn+dz*cs];
  const v=[d.x*cs+d.z*sn,d.y,-d.x*sn+d.z*cs],h=[c.w/2,c.h/2,c.d/2];
  let lo=0,hi=max;
  for(let i=0;i<3;i++){
    if(Math.abs(v[i])<1e-9){if(Math.abs(p[i])>h[i])return Infinity;continue;}
    let a=(-h[i]-p[i])/v[i],b=(h[i]-p[i])/v[i];if(a>b)[a,b]=[b,a];
    lo=Math.max(lo,a);hi=Math.min(hi,b);if(lo>hi)return Infinity;
  }
  return lo;
}
function actorRay(a,o,d,max){
  let best=Infinity,head=false;
  const crouch=a.crouch?.72:1;
  for(const [height,radius,isHead] of [[1.62*crouch,.24,true],[1.13*crouch,.36,false],[.64*crouch,.30,false]]){
    const q={x:o.x-a.x,y:o.y-a.y-height,z:o.z-a.z};
    const b=q.x*d.x+q.y*d.y+q.z*d.z,c=q.x*q.x+q.y*q.y+q.z*q.z-radius*radius;
    const disc=b*b-c;if(disc<0)continue;
    const t=-b-Math.sqrt(disc);if(t>=0&&t<best&&t<max){best=t;head=isHead;}
  }
  return {distance:best,head};
}
function valid(x,z,r=.6){
  if(!terrain.inside(x,-z))return false;
  const y=terrain.ground(x,z);
  for(const c of meta.colliders){
    if(c.py-c.h/2>y+1.75||c.py+c.h/2<y+.3)continue;
    const cs=Math.cos(c.rot),sn=Math.sin(c.rot),dx=x-c.px,dz=z-c.pz;
    const u=dx*cs+dz*sn,v=-dx*sn+dz*cs;
    if(Math.abs(u)<c.w/2+r&&Math.abs(v)<c.d/2+r)return false;
  }
  return true;
}
function rayWorld(o,d,max=220){
  let hit=max;
  for(const c of meta.colliders)hit=Math.min(hit,boxRay(c,o,d,hit));
  // Terrain is sampled as well as buildings: no shooting through hills.
  for(let t=1;t<hit;t+=2){const x=o.x+d.x*t,z=o.z+d.z*t;
    if(o.y+d.y*t<terrain.ground(x,z)+.08){hit=t;break;}}
  return hit;
}
function move(a,dx,dz,dt){
  const maxStep=.8,steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)/maxStep));
  for(let i=0;i<steps;i++){
    const nx=a.x+dx/steps,nz=a.z+dz/steps;
    if(valid(nx,a.z,.38))a.x=nx;
    if(valid(a.x,nz,.38))a.z=nz;
  }
  const floor=terrain.ground(a.x,a.z);
  a.vy=(a.vy||0)-20*dt;a.y+=a.vy*dt;
  if(a.y<floor||a.y-floor<.36&&a.vy<=0){a.y=floor;a.vy=0;}
}
class Navigation{
  constructor(){
    this.graph=new YUKA.Graph();this.nodes=[];this.cells=new Map();this.cache=new Map();this.step=7;
    for(let x=-210;x<=224;x+=this.step)for(let z=-343;z<=245;z+=this.step){
      if(!valid(x,z,.85))continue;
      const node=new YUKA.NavNode(this.nodes.length,new YUKA.Vector3(x,terrain.ground(x,z),z));
      this.graph.addNode(node);this.nodes.push(node);this.cells.set(`${x},${z}`,node.index);
    }
    for(const n of this.nodes){
      const p=n.position;
      for(const [dx,dz] of [[7,0],[0,7],[7,7],[7,-7]]){
        const idx=this.cells.get(`${p.x+dx},${p.z+dz}`);if(idx===undefined)continue;
        const q=this.nodes[idx].position;
        if(Math.abs(q.y-p.y)>5.5)continue;
        if(!valid((p.x+q.x)/2,(p.z+q.z)/2,.85))continue;
        this.graph.addEdge(new YUKA.NavEdge(n.index,idx,Math.hypot(dx,dz)+Math.abs(q.y-p.y)*1.6));
      }
    }
  }
  nearest(x,z){
    let best=null,dist=Infinity;
    for(const n of this.nodes){const d=(n.position.x-x)**2+(n.position.z-z)**2;if(d<dist){dist=d;best=n;}}
    return best;
  }
  route(a,b){
    const start=this.nearest(a.x,a.z),end=this.nearest(b.x,b.z);if(!start||!end)return [];
    const key=`${start.index}:${end.index}`;
    if(this.cache.has(key))return this.cache.get(key).slice();
    const search=new YUKA.AStar(this.graph,start.index,end.index);search.search();
    const points=search.getPath().map(i=>this.nodes[i].position);
    if(this.cache.size>600)this.cache.clear();this.cache.set(key,points);
    return points.slice();
  }
  spawnZones(){
    if(this.spawnCandidates)return this.spawnCandidates;
    // Both starting areas must belong to the same walkable component.
    const visited=new Set(),components=[];
    for(const node of this.nodes){
      if(visited.has(node.index))continue;
      const component=[],queue=[node.index];visited.add(node.index);
      for(let i=0;i<queue.length;i++){
        const id=queue[i];component.push(this.nodes[id]);const edges=[];this.graph.getEdgesOfNode(id,edges);
        for(const edge of edges)if(!visited.has(edge.to)){visited.add(edge.to);queue.push(edge.to);}
      }
      components.push(component);
    }
    this.spawnNodes=components.sort((a,b)=>b.length-a.length)[0]||[];
    this.spawnCandidates=this.spawnNodes.filter(n=>{
      const p=n.position;
      const local=this.spawnNodes.filter(q=>Math.hypot(p.x-q.position.x,p.z-q.position.z)<23&&Math.abs(p.y-q.position.y)<4);
      return local.length>=25&&valid(p.x,p.z,1.2);
    }).map(n=>({...n.position}));
    if(!this.spawnCandidates.length)throw Error('No connected, sufficiently open spawn areas');
    return this.spawnCandidates;
  }
}
module.exports={meta,terrain,clinicAccess,clamp,boxRay,actorRay,valid,rayWorld,move,Navigation};
