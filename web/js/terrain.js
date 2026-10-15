/* Shared browser/Node height evaluator. Config is exported from layout.py. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.CampusTerrain=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const smooth=(a,b,v)=>{const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t);};
  const linear=(a,b,v)=>clamp((v-a)/(b-a),0,1);
  const gauss=(x,y,cx,cy,sx,sy)=>Math.exp(-0.5*(((x-cx)/sx)**2+((y-cy)/sy)**2));
  function base(x,y){
    let h=-.040*x+.022*y;
    h+=150*gauss(x,y,-900,380,430,400)+95*gauss(x,y,-260,830,340,240);
    h+=130*gauss(x,y,-900,-180,400,540)+60*gauss(x,y,240,820,300,210);
    h+=26*gauss(x,y,-520,-560,250,210)-30*gauss(x,y,660,-320,330,300);
    h+=7*Math.sin(x*.00312)*Math.cos(y*.00271)+4*Math.sin(x*.00723+1.31)*Math.cos(y*.00617+.72)+2.5*Math.sin(x*.01410+.40)*Math.cos(y*.01270+2.10);
    return h-34*smooth(-190,-400,y);
  }
  function create(config){
    const pads=config.pads.map(p=>({...p,c:Math.cos(p.rot*Math.PI/180),s:Math.sin(p.rot*Math.PI/180)}));
    const steps=config.steps.map(p=>({...p,c:Math.cos(p.rot*Math.PI/180),s:Math.sin(p.rot*Math.PI/180)}));
    function inside(x,y){
      let result=false; const b=config.boundary;
      for(let i=0;i<b.length;i++){
        const a=b[i],z=b[(i+1)%b.length];
        if((a[1]>y)!==(z[1]>y) && x<a[0]+(y-a[1])*(z[0]-a[0])/(z[1]-a[1])) result=!result;
      }
      return result;
    }
    function dist(x,y){
      if(inside(x,y))return 0;
      let best=Infinity; const b=config.boundary;
      for(let i=0;i<b.length;i++){
        const a=b[i],z=b[(i+1)%b.length],dx=z[0]-a[0],dy=z[1]-a[1];
        const t=clamp(((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy),0,1);
        best=Math.min(best,Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy));
      }return best;
    }
    function padBase(x,y){
      const p=config.profile;
      const gate=(1-smooth(p.gate_half,p.gate_half+p.gate_fade,Math.abs(x-p.gate_x)))*(1-smooth(p.gate_low,p.gate_top,y));
      const h=p.east*smooth(35,100,x)+p.back*smooth(80,205,y)-p.gate_drop*gate;
      let best=0,target=h,total=0,weighted=0;
      for(const p of pads){
        const dx=x-p.x,dy=y-p.y,u=dx*p.c+dy*p.s,v=-dx*p.s+dy*p.c;
        const d=Math.hypot(Math.max(Math.abs(u)-p.w/2,0),Math.max(Math.abs(v)-p.d/2,0));
        const w=1-smooth(0,p.fade,d);
        if((p===pads[0] || config.landings.some(q=>p.x===q.x && p.y===q.y)) && w>=1-1e-10)return p.level;
        const mass=w**12;
        const g=p.grade,level=g?g.low+(g.high-g.low)*smooth(g.y0,g.y1,y):p.level;
        total+=mass;weighted+=mass*level;best=Math.max(best,w);
      }target=total?weighted/total:h;return h*(1-best)+target*best;
    }
    function pad(x,y){
      let h=padBase(x,y),nearest=null;
      for(const road of config.roads){
        const pts=road.pts,n=road.closed?pts.length:pts.length-1;
        for(let i=0;i<n;i++){
          const a=pts[i],b=pts[(i+1)%pts.length],dx=b[0]-a[0],dy=b[1]-a[1];
          const t=clamp(((x-a[0])*dx+(y-a[1])*dy)/Math.max(dx*dx+dy*dy,1e-8),0,1);
          const px=a[0]+dx*t,py=a[1]+dy*t,d=Math.hypot(x-px,y-py),half=road.width/2;
          if(d<half+4 && (!nearest||d<nearest.d))nearest={d,px,py,half,level:road.level};
        }
      }
      if(nearest){const p=nearest,w=1-smooth(p.half,p.half+4,p.d);h=h*(1-w)+(p.level??padBase(p.px,p.py))*w;}
      const p=config.pool,u=(x-p.x)/p.rx,v=(y-p.y)/p.ry,a=Math.atan2(v,u);
      const n=Math.hypot(u,v)/(1+.065*Math.sin(3*a)+.055*Math.cos(a));
      const dy=y-p.y;
      const rim=p.rim_level+p.rim_relief*linear(p.grade_y0,p.grade_y1,dy);
      const w=(1-smooth(p.grade_half,p.grade_half+p.grade_fade,Math.abs(x-p.x)))
        *smooth(-p.ry-12,-p.ry,dy)*(1-smooth(p.grade_back,p.grade_back+p.grade_back_fade,dy));
      h=h*(1-w)+rim*w;
      if(n<1){
        const bottom=p.floor+p.relief*linear(p.bed_y0,p.bed_y1,dy);
        h=bottom+(rim-bottom)*linear(p.rim_start,1,n);
      }
      return h;
    }
    function stair(x,y){
      let surface=null;
      for(const p of steps){
        const dx=x-p.x,dy=y-p.y,u=dx*p.c+dy*p.s,v=-dx*p.s+dy*p.c;
        if(Math.abs(u)<=p.length/2 && Math.abs(v)<=p.width/2){
          for(const seg of p.segments)if(u<=seg.b+1e-8){surface=surface===null?seg.z+.08:Math.max(surface,seg.z+.08);break;}
        }
      }return surface;
    }
    function ground(X,Z){
      const x=X,y=-Z,p=config.forecourt;
      const bridge=config.bridge;
      if(bridge && Math.abs(x-bridge.x)<=bridge.width/2 && y>=bridge.y0 && y<=bridge.y1)return bridge.level;
      const stand=config.grandstand;
      if(stand){
        const [gx,gy]=stand.pos,[w,d]=stand.size;
        if(Math.abs(x-gx)<=w/2 && Math.abs(y-gy)<=d/2)return stand.deck;
        const start=gy-d/2-1.8;
        if(Math.abs(x-gx)<=6 && y>=start && y<gy-d/2){
          const i=Math.min(4,Math.floor((y-start)/.36));
          return stand.level+(stand.deck-stand.level)*(i+1)/5;
        }
      }
      const d=Math.hypot(Math.max(Math.abs(x-p.x)-p.w/2,0),Math.max(Math.abs(y-p.y)-p.d/2,0));
      const t=smooth(0,80,dist(x,y))*smooth(0,p.fade,d),st=stair(x,y);
      return (st===null?pad(x,y):st)*(1-t)+base(x,y)*t;
    }
    return {ground,pad,stair,inside,dist};
  }
  return {create};
});
