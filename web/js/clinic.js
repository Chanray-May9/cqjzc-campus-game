/* Physical clinic access shared by the authoritative game and its renderer. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CampusClinic=api;})(globalThis,function(){
 const room={x:-13.6,z:-100.1,y:8.72,w:8,d:11.6,doorZ:-93.1,doorWidth:3.2};
 const stairs={x0:-13.6,x1:10.9,z:-92.2,width:1.2,low:.3,high:8.72,steps:70};
 function surface(x,z){
  if(Math.abs(x-room.x)<=room.w/2&&z>=room.z-room.d/2&&z<=-92.0)return room.y;
  if(x>=stairs.x0&&x<=stairs.x1&&Math.abs(z-stairs.z)<=stairs.width/2){const t=(stairs.x1-x)/(stairs.x1-stairs.x0);return stairs.low+(stairs.high-stairs.low)*Math.ceil(t*stairs.steps)/stairs.steps;}
  return null;
 }
 function create(base,original){
  const ground=(x,z)=>surface(x,z)??base.ground(x,z);
  const terrain={...base,ground};const colliders=[];
  for(const c of original){
   if(c.building_id!=='b08'||c.px< -30){colliders.push(c);continue;}
   // Split the right wing shell around the clinic, retaining its other walls.
   const x0=c.px-c.w/2,x1=c.px+c.w/2,z0=c.pz-c.d/2,z1=c.pz+c.d/2;
   if(c.px> -30){
    const boxes=[[x0,room.x-room.w/2,z0,z1],[room.x+room.w/2,x1,z0,z1],[room.x-room.w/2,room.x+room.w/2,z0,room.z-room.d/2]];
    boxes.forEach(([a,b,d,e],i)=>colliders.push({...c,id:c.id+'-clinic-'+i,px:(a+b)/2,pz:(d+e)/2,w:b-a,d:e-d}));
    // Clinic interior walls and a real doorway in the front wall.
    for(const [a,b]of [[room.x-room.w/2,room.x-room.doorWidth/2],[room.x+room.doorWidth/2,room.x+room.w/2]]){
     colliders.push({id:'clinic-door-'+a,type:'box',px:(a+b)/2,pz:room.doorZ,py:room.y+1.8,w:b-a,d:.18,h:3.6,rot:0,building_id:'clinic'});
    }
   }
  }
  return {terrain,colliders,room,stairs,inside(x,y,z){return Math.abs(x-room.x)<room.w/2-.25&&Math.abs(z-room.z)<room.d/2-.3&&Math.abs(y-room.y)<1.5;}};
 }
 return {create,room,stairs,surface};
});
