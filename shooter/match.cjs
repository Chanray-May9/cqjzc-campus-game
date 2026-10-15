const {terrain,clinicAccess,clamp,actorRay,rayWorld,move,valid}=require('./world.cjs');
const {WEAPONS,damageAt}=require('./weapons.cjs');
const {MOVEMENT,speedFor}=require('./movement.cjs');
/* Zombie grades. The plain white one is three times its old durability, and the hazmat elite is
   twice that again, so the armoured one takes real commitment to put down. */
const ZOMBIE_HP=195;
const ARMORED_ZOMBIE_MULTIPLIER=2;
const ARMORED_ZOMBIE_SHARE=.3;
const CLINIC={x:clinicAccess.room.x,z:clinicAccess.room.z,radius:4.5};
const LANDING={x:-35.7,z:-26.2,radius:7};
const BOT_NAMES=['守望','游隼','岩隼','铁杉','斥候','野狼','灰鹰','燧石','云杉','猎隼','锋刃','巡风'];
// Horde pacing: only ever spawn just outside what the squad can currently see,
// never inside a cell a player looked at moments ago.
const HORDE={min:18,max:110,rampSeconds:4,near:36,far:118,cull:190,sight:110,halfFov:1.15,seenMemory:16,cell:8,interval:.32};
class Match{
  constructor(mode,nav,options={}){
    if(!['tdm','survival'].includes(mode))throw Error('unknown mode');
    this.mode=mode;this.nav=nav;this.random=options.random||Math.random;
    this.actors=new Map();this.elapsed=0;this.score={blue:0,red:0};this.winner=null;
    this.phase='active';this.serial=0;this.eventSerial=0;this.events=[];this.nextZombie=0;this.seen=new Map();
    this.seed=Math.floor(this.random()*2147483647);
    this.clinic={...CLINIC,y:terrain.ground(CLINIC.x,CLINIC.z)};
    this.landing={...LANDING,y:terrain.ground(LANDING.x,LANDING.z)};
    this.spawnAreas=this.chooseSpawnAreas();
  }
  chooseSpawnAreas(){
    const candidates=this.nav.spawnZones();
    // 200m between centres leaves at least 154m between the two 23m areas.
    for(let i=0;i<100;i++){
      const blue=candidates[Math.floor(this.random()*candidates.length)];
      const opposite=candidates.filter(p=>Math.hypot(p.x-blue.x,p.z-blue.z)>=200);
      if(opposite.length){const red=opposite[Math.floor(this.random()*opposite.length)];return {blue:{...blue},red:{...red}};}
    }
    for(const blue of candidates)for(const red of candidates){
      if(Math.hypot(blue.x-red.x,blue.z-red.z)>=200)return {blue:{...blue},red:{...red}};
    }
    throw Error('Map cannot provide separated starting areas');
  }
  event(type,data={}){this.events.push({seq:++this.eventSerial,type,t:this.elapsed,...data});if(this.events.length>60)this.events.shift();}
  spawnPosition(team,zombie=false){
    const alive=[...this.actors.values()].filter(a=>a.alive&&!a.extracted);
    const enemies=alive.filter(a=>a.team!==team);
    const center=zombie?(alive.find(a=>a.human)||this.spawnAreas.blue):this.spawnAreas[team]||this.spawnAreas.blue;
    const safe=p=>valid(p.x,p.z,1)&&alive.every(a=>Math.hypot(a.x-p.x,a.z-p.z)>1.5)&&
      enemies.every(a=>Math.hypot(a.x-p.x,a.z-p.z)>=(zombie?45:this.mode==='tdm'&&this.elapsed===0?150:35));
    for(let i=0;i<180;i++){
      const angle=this.random()*Math.PI*2,r=zombie?55+this.random()*80:4+this.random()*20;
      const x=center.x+Math.sin(angle)*r,z=center.z+Math.cos(angle)*r;
      const y=terrain.ground(x,z);
      if((zombie||Math.abs(y-center.y)<4)&&safe({x,z}))return {x,z,y};
    }
    const candidates=this.nav.spawnNodes.map(n=>n.position).filter(p=>safe(p));
    if(!candidates.length)return null; // Wait for a safe spot instead of forcing a close spawn.
    const centred=candidates.filter(p=>this.elapsed>0||zombie||Math.hypot(p.x-center.x,p.z-center.z)<24);
    const pool=centred.length?centred:candidates;
    pool.sort((a,b)=>Math.hypot(a.x-center.x,a.z-center.z)-Math.hypot(b.x-center.x,b.z-center.z));
    return {...pool[Math.floor(this.random()*Math.min(15,pool.length))]};
  }
  actor(team,human=false,name='',kind='soldier',id=null,forced=null){
    const pos=forced||this.spawnPosition(team,kind==='zombie');
    if(!pos){if(kind==='zombie')return null;throw Error('当前没有安全出生位置，请稍后加入');}
    /* Zombies come in two grades. The variant is decided here rather than on the client, so the
       health pool and the model the player is actually looking at can never disagree. The plain
       zombie wears white and is the common one; the hazmat-suited one is the tough elite. */
    const variant=kind==='zombie'&&this.random()<ARMORED_ZOMBIE_SHARE?1:0;
    const hp=kind==='zombie'?(variant?ZOMBIE_HP*ARMORED_ZOMBIE_MULTIPLIER:ZOMBIE_HP):100;
    const a={id:id||`unit-${++this.serial}`,team,human,name:name||BOT_NAMES[this.serial%BOT_NAMES.length],kind,variant,
      ...pos,hp,maxHp:hp,alive:true,extracted:false,yaw:0,pitch:0,vy:0,avatar:null,
      ammo:30,reserve:240,kills:0,deaths:0,damageAt:-100,fireAt:-100,spawnAt:this.elapsed,
      reloadUntil:0,respawnAt:0,input:{},path:[],thinkAt:0,target:null,state:'patrol',moving:false,shot:0,
      weapon:'rifle',crouch:false,sprinting:false,gaitUntil:0,loadout:Object.fromEntries(Object.entries(WEAPONS).map(([key,w])=>[key,{ammo:w.magazine,reserve:w.reserve}]))};
    this.actors.set(a.id,a);return a;
  }
  join(id,name,team='blue',avatar=null){
    if(this.mode==='survival')team='blue';
    if(!['blue','red'].includes(team))throw Error('请选择蓝队或红队');
    const humans=[...this.actors.values()].filter(a=>a.human&&a.team===team);
    const capacity=this.mode==='tdm'?30:11;
    if(humans.length>=capacity)throw Error('该队伍已满');
    const bot=[...this.actors.values()].find(a=>!a.human&&a.team===team&&a.kind==='soldier');
    if(bot)this.actors.delete(bot.id);
    const a=this.actor(team,true,(name||'队员').slice(0,16),'soldier',id);
    if(Number.isInteger(avatar)&&avatar>=0)a.avatar=avatar;
    this.balance();this.event('join',{name:a.name,team});return a;
  }
  leave(id){this.actors.delete(id);this.balance();}
  balance(){
    for(const team of this.mode==='tdm'?['blue','red']:['blue']){
      // Survival keeps a small fireteam so the horde stays the real threat.
      const wanted=this.mode==='tdm'?30:3;
      let members=[...this.actors.values()].filter(a=>a.team===team&&a.kind==='soldier');
      while(members.length<wanted){members.push(this.actor(team));}
      while(members.length>wanted){const bot=members.find(a=>!a.human);if(!bot)break;this.actors.delete(bot.id);members=members.filter(a=>a!==bot);}
    }
  }
  setInput(id,input){
    const a=this.actors.get(id);if(!a||!a.human)return;
    a.input={forward:clamp(Number(input.forward)||0,-1,1),side:clamp(Number(input.side)||0,-1,1),
      yaw:clamp(Number(input.yaw)||0,-10000,10000),pitch:clamp(Number(input.pitch)||0,-1.42,1.42),
      sprint:!!input.sprint,fire:!!input.fire,aim:!!input.aim,jump:!!input.jump,reload:!!input.reload,extract:!!input.extract,
      weapon:WEAPONS[input.weapon]?input.weapon:a.weapon,crouch:!!input.crouch};
    a.inputAt=this.elapsed;
  }
  damage(victim,amount,attacker){
    if(!victim.alive||victim.extracted||this.phase==='finished')return;
    if(attacker&&attacker.team===victim.team)return;
    victim.hp=Math.max(0,victim.hp-amount);victim.damageAt=this.elapsed;
    if(victim.hp<=0){
      victim.alive=false;victim.deaths++;victim.respawnAt=this.elapsed+4;
      if(attacker){attacker.kills++;if(this.mode==='tdm')this.score[attacker.team]++;}
      this.event('kill',{killer:attacker?.name||'未知',killerId:attacker?.id,victim:victim.name,victimId:victim.id,team:attacker?.team});
      if(this.mode==='tdm'&&attacker&&this.score[attacker.team]>=150){this.winner=attacker.team;this.phase='finished';this.event('victory',{team:this.winner});}
    }
  }
  switchWeapon(a,key){
    if(!WEAPONS[key]||a.weapon===key)return;
    a.loadout[a.weapon]={ammo:a.ammo,reserve:a.reserve};a.weapon=key;
    Object.assign(a,a.loadout[key]);a.reloadUntil=0;a.fireAt=this.elapsed;
  }
  reload(a){const w=WEAPONS[a.weapon];if(a.ammo<w.magazine&&a.reserve>0&&a.reloadUntil<=this.elapsed){a.reloadUntil=this.elapsed+w.reload;this.event('reload',{id:a.id});}}
  fire(a,direction=null){
    const w=WEAPONS[a.weapon];
    if(!a.alive||a.extracted||this.phase==='finished'||a.reloadUntil>this.elapsed||this.elapsed-a.fireAt<w.interval)return;
    if(a.ammo<=0){this.reload(a);return;}
    a.ammo--;a.fireAt=this.elapsed;a.shot++;
    const d=direction||{x:-Math.sin(a.yaw)*Math.cos(a.pitch),y:Math.sin(a.pitch),z:-Math.cos(a.yaw)*Math.cos(a.pitch)};
    const o={x:a.x,y:a.y+(a.crouch?1.17:1.62),z:a.z};
    for(let pellet=0;pellet<w.pellets;pellet++){
      const ray={x:d.x+(this.random()-.5)*w.spread,y:d.y+(this.random()-.5)*w.spread,z:d.z+(this.random()-.5)*w.spread};
      const length=Math.hypot(ray.x,ray.y,ray.z);ray.x/=length;ray.y/=length;ray.z/=length;
      let nearest=rayWorld(o,ray,w.range),target=null,head=false;
      for(const v of this.actors.values()){
        if(v.id===a.id||!v.alive||v.extracted||v.team===a.team)continue;
        const hit=actorRay(v,o,ray,nearest);
        if(hit.distance<nearest){nearest=hit.distance;target=v;head=hit.head;}
      }
      if(target)this.damage(target,damageAt(w,nearest,head),a);
      this.event('shot',{id:a.id,weapon:a.weapon,x:o.x,y:o.y,z:o.z,tx:o.x+ray.x*nearest,ty:o.y+ray.y*nearest,tz:o.z+ray.z*nearest,hit:!!target,head});
    }
  }
  respawn(a){
    const position=this.spawnPosition(a.team);if(!position)return;
    a.loadout=Object.fromEntries(Object.entries(WEAPONS).map(([key,w])=>[key,{ammo:w.magazine,reserve:w.reserve}]));
    Object.assign(a,position,{hp:a.maxHp||100,alive:true,...a.loadout[a.weapon],vy:0,spawnAt:this.elapsed,path:[],damageAt:this.elapsed,reloadUntil:0});
  }
  heal(a,dt){
    const medical=clinicAccess.inside(a.x,a.y,a.z);
    if(this.mode==='tdm'&&this.elapsed-a.damageAt>5)a.hp=Math.min(100,a.hp+18*dt);
    else if(this.mode==='survival'&&medical)a.hp=Math.min(100,a.hp+35*dt);
    if(medical)a.reserve=Math.min(WEAPONS[a.weapon].reserve,a.reserve+8*dt);
  }
  tryExtract(a){
    if(this.mode!=='survival'||!a.alive||a.extracted||this.elapsed<616)return false;
    if(Math.hypot(a.x-this.landing.x,a.z-this.landing.z)>this.landing.radius||Math.abs(a.y-this.landing.y)>2.0)return false;
    a.extracted=true;a.moving=false;this.event('extracted',{id:a.id,name:a.name});return true;
  }
  think(a){
    const enemies=[...this.actors.values()].filter(v=>v.alive&&!v.extracted&&v.team!==a.team);
    let target=null,best=Infinity;
    for(const e of enemies){const dist=(a.x-e.x)**2+(a.z-e.z)**2;if(dist<best){best=dist;target=e;}}
    a.target=target?.id||null;a.thinkAt=this.elapsed+.25+this.random()*.35;
    if(a.kind==='zombie'){
      a.path=[];a.state='pursue';a.goal=target?{x:target.x,z:target.z}:null;return;
    }
    let goal=target;
    if(a.kind==='soldier'&&a.hp<35){goal=this.clinic;a.state='heal';}
    else if(this.mode==='survival'&&a.kind==='soldier'&&this.elapsed>=600){goal=this.landing;a.state='evacuate';}
    else if(target){a.state=a.kind==='zombie'?'pursue':'combat';}
    if(!goal){a.state='patrol';return;}
    const range=Math.sqrt(best);
    const direct=target&&rayWorld({x:a.x,y:a.y+1.4,z:a.z},this.direction(a,target),range)>=range-.7;
    if(direct&&range<25&&a.state==='combat'||direct&&a.kind==='zombie'&&range<20){a.path=[];a.goal={x:goal.x,z:goal.z};}
    else if(!a.routeAt||this.elapsed>a.routeAt){a.path=this.nav.route(a,goal);a.path.shift();a.routeAt=this.elapsed+2+this.random()*2;a.goal={x:goal.x,z:goal.z};}
  }
  direction(a,b,spread=0){
    const dx=b.x-a.x+(this.random()-.5)*spread,dy=b.y-a.y-.45+(this.random()-.5)*spread,dz=b.z-a.z+(this.random()-.5)*spread;
    const length=Math.hypot(dx,dy,dz)||1;return {x:dx/length,y:dy/length,z:dz/length};
  }
  botTick(a,dt){
    if(this.elapsed>=a.thinkAt)this.think(a);
    const target=this.actors.get(a.target),distance=target?Math.hypot(target.x-a.x,target.z-a.z):Infinity;
    if(target&&target.alive&&distance<80){
      const d=this.direction(a,target);a.yaw=Math.atan2(-d.x,-d.z);a.pitch=Math.asin(d.y);
      if(a.kind==='zombie'){
        if(distance<1.75&&this.elapsed-a.fireAt>.85&&Math.abs(target.y-a.y)<2){this.damage(target,13,a);a.fireAt=this.elapsed;a.shot++;}
      }else if(distance<68&&this.elapsed-a.fireAt>.35+this.random()*.18){
        if(rayWorld({x:a.x,y:a.y+1.62,z:a.z},d,distance)>distance-.5)this.fire(a,this.direction(a,target,1.4+distance*.06));
      }
    }
    /* Bots pick the same two gaits the player has. They run when the fight is far away, when
       falling back to the clinic wounded, or when heading for the helicopter; inside
       BOT_SPRINT_DISTANCE - or while actually shooting - they walk. */
    if(a.kind==='zombie')a.sprinting=false;
    else if(a.state==='evacuate'||a.state==='heal')a.sprinting=true;
    else {
      const engaged=target&&target.alive&&distance<40&&this.elapsed-a.fireAt<1.2;
      const closing=!!(target&&target.alive&&distance>MOVEMENT.BOT_SPRINT_DISTANCE);
      if(!engaged&&closing){
        /* Alternate the gait while closing ground, the way infantry bound forward: a long run
           then a shorter walk. Sprinting every single second looked robotic and meant the walk
           animation never played for a bot. */
        if(this.elapsed>=a.gaitUntil){
          a.sprinting=!a.sprinting;
          a.gaitUntil=this.elapsed+(a.sprinting?3+this.random()*3:1.5+this.random()*1.5);
        }
      } else a.sprinting=false;
    }
    let point=a.path[0]||a.goal;
    if(point&&Math.hypot(point.x-a.x,point.z-a.z)<1.6){a.path.shift();point=a.path[0]||a.goal;}
    a.moving=false;
    if(point&&!(a.state==='combat'&&distance<16)&&!(a.kind==='zombie'&&distance<1.4)){
      let dx=point.x-a.x,dz=point.z-a.z,length=Math.hypot(dx,dz);
      if(length>.4){
          const speed=speedFor({kind:a.kind,crouch:a.crouch,sprint:a.sprinting,elapsed:this.elapsed});
        let vx=dx/length,vz=dz/length;
        /* Separation steering avoids a pile of overlapping agents. The push is collected
           separately and clamped: the old 0.45/d term exploded as the distance went to zero,
           which could swing the heading round by 180 degrees and send a bot backwards. */
        let px=0,pz=0;
        for(const other of this.actors.values()){
          if(other===a||!other.alive||other.extracted)continue;
          const ddx=a.x-other.x,ddz=a.z-other.z,dist=Math.hypot(ddx,ddz);
          if(dist>.02&&dist<1.2){
            const strength=(1-dist/1.2)*1.6/dist;
            px+=ddx*strength;pz+=ddz*strength;
          }
        }
        const push=Math.hypot(px,pz);
        if(push>.001){const k=Math.min(push,.55)/push;vx+=px*k;vz+=pz*k;}
        const n=Math.hypot(vx,vz)||1;vx/=n;vz/=n;
        if(a.kind==='zombie'){
          // Direct pursuit plus local obstacle feelers, never a graph route.
          const ahead=1.5,base=Math.atan2(vz,vx),prefer=a.avoidSide||((this.random()<.5)?1:-1);
          if(!valid(a.x+vx*ahead,a.z+vz*ahead,.5)){
            let chosen=null;
            for(const angle of [prefer*.65,prefer*1.15,prefer*1.65,-prefer*.65,-prefer*1.15,-prefer*1.65,prefer*2.1]){
              const x=Math.cos(base+angle),z=Math.sin(base+angle);
              if(valid(a.x+x*ahead,a.z+z*ahead,.5)){chosen={x,z,side:Math.sign(angle)};break;}
            }
            if(chosen){vx=chosen.x;vz=chosen.z;a.avoidSide=chosen.side;}else{vx=0;vz=0;}
          }else a.avoidSide=0;
        }
        move(a,vx*speed*dt,vz*speed*dt,dt);a.moving=!!(vx||vz);
        this.resolveBodyOverlap(a);
        if(distance>80)a.yaw=Math.atan2(-vx,-vz);
      }
    }
    if(!a.moving)move(a,0,0,dt);
    this.resolveBodyOverlap(a);
    if(a.ammo===0)this.reload(a);
    if(a.state==='evacuate')this.tryExtract(a);
  }
  /* Bodies are solid. Until now only terrain and buildings were ever tested, so you could walk
     straight through a team-mate or an enemy. Overlaps are pushed apart rather than blocked, so
     a crowd shoves instead of jamming, and the push is re-checked against the world so nobody
     gets squeezed into a wall. */
  resolveBodyOverlap(a){
    const min=.84;
    for(const other of this.actors.values()){
      if(other===a||!other.alive||other.extracted)continue;
      if(Math.abs((other.y||0)-(a.y||0))>1.7)continue;
      let ddx=a.x-other.x,ddz=a.z-other.z;
      const dx0=Math.abs(ddx),dz0=Math.abs(ddz);
      if(dx0>min||dz0>min)continue;
      let d=Math.hypot(ddx,ddz);
      if(d>=min)continue;
      if(d<1e-3){const angle=this.random()*Math.PI*2;ddx=Math.cos(angle);ddz=Math.sin(angle);d=1;}
      const push=min-d+.002,nx=a.x+ddx/d*push,nz=a.z+ddz/d*push;
      if(valid(nx,nz,.38)){a.x=nx;a.z=nz;}
      else if(valid(nx,a.z,.38))a.x=nx;
      else if(valid(a.x,nz,.38))a.z=nz;
    }
  }
  humans(){return [...this.actors.values()].filter(a=>a.human&&a.alive&&!a.extracted);}
  cellKey(x,z){return `${Math.floor(x/HORDE.cell)*HORDE.cell},${Math.floor(z/HORDE.cell)*HORDE.cell}`;}
  /* Mark every grid cell currently inside a player's view cone, so the director knows which
     ground has already been confirmed clear and does not spawn into somebody's crosshair. */
  observe(){
    for(const h of this.humans()){
      const range=HORDE.sight;
      for(let ox=-range;ox<=range;ox+=HORDE.cell)for(let oz=-range;oz<=range;oz+=HORDE.cell){
        const x=h.x+ox,z=h.z+oz;
        const dx=x-h.x,dz=z-h.z,d=Math.hypot(dx,dz);
        if(d>range)continue;
        if(d>HORDE.near*.6){
          let diff=Math.atan2(-dx,-dz)-h.yaw;
          diff=((diff+Math.PI)%(Math.PI*2))-Math.PI;if(diff<-Math.PI)diff+=Math.PI*2;
          if(Math.abs(diff)>HORDE.halfFov)continue;
        }
        this.seen.set(this.cellKey(x,z),this.elapsed);
      }
    }
  }
  /* ---------------- horde director ---------------- */
  // A spawn point is valid only when no player can see it right now and nobody
  // looked at that ground within the memory window.
  hordeSpot(){
    const squad=this.humans();if(!squad.length)return null;
    const anchor=squad[Math.floor(this.random()*squad.length)];
    for(let i=0;i<40;i++){
      const angle=this.random()*Math.PI*2,r=HORDE.near+this.random()*(HORDE.far-HORDE.near);
      const x=anchor.x+Math.sin(angle)*r,z=anchor.z+Math.cos(angle)*r;
      if(!valid(x,z,.9))continue;
      let hidden=true;
      for(const h of squad){
        const dx=x-h.x,dz=z-h.z,d=Math.hypot(dx,dz);
        if(d<HORDE.near*.6){hidden=false;break;}
        if(d<=HORDE.sight){
          let diff=Math.atan2(-dx,-dz)-h.yaw;
          diff=((diff+Math.PI)%(Math.PI*2))-Math.PI;if(diff<-Math.PI)diff+=Math.PI*2;
          if(Math.abs(diff)<HORDE.halfFov+.12){hidden=false;break;}
        }
      }
      if(!hidden)continue;
      const seenAt=this.seen.get(this.cellKey(x,z));
      if(seenAt!==undefined&&this.elapsed-seenAt<HORDE.seenMemory)continue;
      return {x,z,y:terrain.ground(x,z)};
    }
    return null;
  }
  hordeTick(){
    const squad=this.humans();if(!squad.length)return;
    this.observe();
    const zombies=[...this.actors.values()].filter(a=>a.kind==='zombie');
    // Cull anything that has drifted far behind every player: keeps the simulation
    // and the renderer focused on the fight around the squad.
    for(const z of zombies){
      const nearest=Math.min(...squad.map(h=>Math.hypot(h.x-z.x,h.z-z.z)));
      if(nearest>HORDE.cull)this.actors.delete(z.id);
    }
    const live=zombies.filter(a=>a.alive&&this.actors.has(a.id)).length;
    const wanted=Math.min(HORDE.max,HORDE.min+Math.floor(this.elapsed/HORDE.rampSeconds));
    if(this.elapsed<this.nextZombie||live>=wanted)return;
    const spot=this.hordeSpot();if(!spot)return;
    if(this.actor('horde',false,'感染者','zombie',null,spot)){this.nextZombie=this.elapsed+HORDE.interval;this.event('horde',{n:live+1});}
  }
  tick(dt,clockDelta=dt){
    if(this.phase==='finished')return;this.elapsed+=clockDelta;
    if(this.mode==='survival'){
      if(this.elapsed>=600&&this.phase==='active'){this.phase='extracting';this.event('helicopter');}
      this.hordeTick();
    }
    for(const a of this.actors.values()){
      if(a.extracted)continue;
      if(!a.alive){
        if(this.mode==='tdm'&&this.elapsed>=a.respawnAt)this.respawn(a);
        else if(!a.human&&a.kind==='zombie'&&this.elapsed>a.respawnAt+3)this.actors.delete(a.id);
        continue;
      }
      if(a.reloadUntil&&this.elapsed>=a.reloadUntil){const fill=Math.min(WEAPONS[a.weapon].magazine-a.ammo,Math.floor(a.reserve));a.ammo+=fill;a.reserve-=fill;a.reloadUntil=0;}
      if(a.human){
        const k=this.elapsed-(a.inputAt||0)<1?a.input:{};a.yaw=k.yaw??a.yaw;a.pitch=k.pitch??a.pitch;
        if(k.weapon)this.switchWeapon(a,k.weapon);
        a.crouch=!!k.crouch;
        const f=k.forward||0,s=k.side||0,n=Math.max(1,Math.hypot(f,s));
        a.sprinting=!!k.sprint;
        const speed=speedFor({kind:a.kind,crouch:a.crouch,sprint:k.sprint,elapsed:this.elapsed});
        const dx=(-Math.sin(a.yaw)*f+Math.cos(a.yaw)*s)/n*speed*dt;
        const dz=(-Math.cos(a.yaw)*f-Math.sin(a.yaw)*s)/n*speed*dt;
        if(k.jump&&!a.crouch&&Math.abs(a.y-terrain.ground(a.x,a.z))<.1)a.vy=MOVEMENT.JUMP;
        move(a,dx,dz,dt);a.moving=!!(f||s);
        this.resolveBodyOverlap(a);
        if(k.reload)this.reload(a);if(k.fire)this.fire(a);if(k.extract)this.tryExtract(a);
      }else this.botTick(a,dt);
      if(a.kind==='soldier')this.heal(a,dt);
    }
  }
  snapshot(id,after=0){
    const player=this.actors.get(id),alive=[...this.actors.values()].filter(a=>a.alive&&!a.extracted);
    return {type:'state',mode:this.mode,time:+this.elapsed.toFixed(3),phase:this.phase,score:this.score,winner:this.winner,seed:this.seed,
      you:id,clinic:this.clinic,landing:this.landing,spawnAreas:this.spawnAreas,helicopter:this.mode==='survival'&&this.elapsed>=600?{arrived:this.elapsed>=616,t:this.elapsed-600}:null,
      counts:{blue:alive.filter(a=>a.team==='blue').length,red:alive.filter(a=>a.team==='red').length,zombies:alive.filter(a=>a.kind==='zombie').length},
      player:player?{hp:player.hp,ammo:player.ammo,reserve:Math.floor(player.reserve),kills:player.kills,deaths:player.deaths,
        alive:player.alive,extracted:player.extracted,reloading:Math.max(0,player.reloadUntil-this.elapsed),respawn:Math.max(0,player.respawnAt-this.elapsed),team:player.team,weapon:player.weapon}:null,
      actors:[...this.actors.values()].map(a=>({id:a.id,x:+a.x.toFixed(3),y:+a.y.toFixed(3),z:+a.z.toFixed(3),yaw:a.yaw,pitch:a.pitch,hp:a.hp,
        team:a.team,name:a.name,kind:a.kind,human:a.human,alive:a.alive,extracted:a.extracted,moving:a.moving,shot:a.shot,kills:a.kills,deaths:a.deaths,
        weapon:a.weapon,crouch:a.crouch,avatar:a.avatar,reloading:a.reloadUntil>this.elapsed,reloadLeft:Math.max(0,+(a.reloadUntil-this.elapsed).toFixed(2)),
        sprinting:!!a.sprinting,variant:a.variant||0,maxHp:a.maxHp||100})),
      events:this.events.filter(e=>e.seq>after)};
  }
}
module.exports={Match,CLINIC,LANDING};
