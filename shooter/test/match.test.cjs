const test=require('node:test'),assert=require('node:assert/strict');
const {Match}=require('../match.cjs');
const {Navigation,terrain,boxRay,valid}=require('../world.cjs');
const {WEAPONS,damageAt}=require('../weapons.cjs');
const {MOVEMENT,speedFor}=require('../movement.cjs');
const nav=new Navigation();
function at(a,x,z){a.x=x;a.z=z;a.y=terrain.ground(x,z);return a;}
test('30v30 includes humans and replaces AI slots without increasing the team size',()=>{
 const m=new Match('tdm',nav);m.join('a','甲','blue');m.join('b','乙','blue');m.join('c','丙','red');
 assert.equal(m.actors.size,60);assert.equal([...m.actors.values()].filter(a=>a.team==='blue').length,30);
 assert.equal([...m.actors.values()].filter(a=>a.team==='red').length,30);
 assert.equal([...m.actors.values()].filter(a=>a.human).length,3);
 m.leave('b');assert.equal(m.actors.size,60);
});
test('successive rounds choose separated, connected random starting areas',()=>{
 const choices=new Set();
 for(let round=0;round<24;round++){
  const m=new Match('tdm',nav);m.join('player','玩家','blue');
  const {blue,red}=m.spawnAreas;choices.add(`${blue.x},${blue.z}:${red.x},${red.z}`);
  assert.ok(Math.hypot(blue.x-red.x,blue.z-red.z)>=200);
  assert.ok(nav.route(blue,red).length>0);
  const blues=[...m.actors.values()].filter(a=>a.team==='blue'),reds=[...m.actors.values()].filter(a=>a.team==='red');
  assert.equal(blues.length,30);assert.equal(reds.length,30);
  for(const a of m.actors.values())assert.ok(valid(a.x,a.z,1));
  for(const a of blues)for(const b of reds)assert.ok(Math.hypot(a.x-b.x,a.z-b.z)>=150);
 }
 assert.ok(choices.size>20);
});
test('respawning avoids an enemy camping in the original starting area',()=>{
 const m=new Match('tdm',nav),a=m.join('a','甲','blue'),enemy=[...m.actors.values()].find(a=>a.team==='red');
 at(enemy,m.spawnAreas.blue.x,m.spawnAreas.blue.z);a.alive=false;m.elapsed=20;m.respawn(a);
 assert.equal(a.alive,true);assert.ok(Math.hypot(a.x-enemy.x,a.z-enemy.z)>=35);
});
test('team victory happens at 150 and friendly fire cannot change health or score',()=>{
 const m=new Match('tdm',nav),a=m.actor('blue',true,'甲'),b=m.actor('red',true,'乙'),f=m.actor('blue');
 m.damage(f,80,a);assert.equal(f.hp,100);m.score.blue=149;m.damage(b,100,a);
 assert.equal(m.score.blue,150);assert.equal(m.winner,'blue');assert.equal(m.phase,'finished');
 m.damage(f,80,b);assert.equal(f.hp,100);
});
test('team health regenerates only after five seconds without damage',()=>{
 const m=new Match('tdm',nav),a=at(m.actor('blue',true),-35,-26);a.hp=40;a.damageAt=0;m.elapsed=4.9;m.heal(a,1);assert.equal(a.hp,40);
 m.elapsed=5.1;m.heal(a,1);assert.equal(a.hp,58);
});
test('survival keeps a two-person AI fireteam and medical-only regeneration',()=>{
 const m=new Match('survival',nav);const a=m.join('a','甲'),b=m.join('b','乙');
 assert.equal([...m.actors.values()].filter(a=>a.kind==='soldier').length,3);
 assert.equal([...m.actors.values()].filter(a=>!a.human&&a.kind==='soldier').length,1);
 at(a,-35,-26);a.hp=40;m.elapsed=100;a.damageAt=0;m.heal(a,1);assert.equal(a.hp,40);
 at(a,m.clinic.x,m.clinic.z);m.heal(a,1);assert.equal(a.hp,75);
 assert.equal(b.team,'blue');
 const solo=new Match('survival',nav);solo.join('solo','独行');assert.equal([...solo.actors.values()].filter(a=>!a.human&&a.kind==='soldier').length,2);
});
test('ten-minute helicopter arrival and boarding grant individual extraction only',()=>{
 const m=new Match('survival',nav),a=m.join('a','甲'),b=m.join('b','乙');
 at(a,m.landing.x,m.landing.z);at(b,m.landing.x,m.landing.z);
 m.elapsed=599.9;assert.equal(m.tryExtract(a),false);m.tick(.1);assert.equal(m.phase,'extracting');assert.equal(m.snapshot(a.id).helicopter.arrived,false);
 m.elapsed=615.9;assert.equal(m.tryExtract(a),false);m.elapsed=616;assert.equal(m.tryExtract(a),true);
 assert.equal(a.extracted,true);assert.equal(b.extracted,false);assert.equal(m.winner,null);assert.notEqual(m.phase,'finished');
});
test('survival deaths do not respawn, team deaths do',()=>{
 const s=new Match('survival',nav),a=s.actor('blue',true),z=s.actor('horde',false,'丧尸','zombie');s.damage(a,100,z);s.tick(5);assert.equal(a.alive,false);
 const t=new Match('tdm',nav),b=t.actor('blue',true),r=t.actor('red');t.damage(b,100,r);t.tick(5);assert.equal(b.alive,true);assert.equal(b.hp,100);
});
test('zombie pursuit uses local steering and never calls a graph route',()=>{
 const spy={...nav,spawnZones:nav.spawnZones.bind(nav),nearest:nav.nearest.bind(nav),route(){throw Error('zombie used navigation graph');}};
 const m=new Match('survival',spy),human=at(m.actor('blue',true),-35,-26),z=at(m.actor('horde',false,'丧尸','zombie'),-35,-65);
 m.think(z);assert.equal(z.target,human.id);assert.deepEqual(z.path,[]);assert.equal(z.state,'pursue');
 const before=z.z;m.botTick(z,.1);assert.ok(z.z>before);
});
test('each weapon has distinct magazine, fire cadence, pellets and distance damage',()=>{
 assert.equal(WEAPONS.rifle.magazine,30);assert.equal(WEAPONS.shotgun.pellets,8);assert.equal(WEAPONS.pistol.magazine,12);
 assert.ok(damageAt('rifle',10)>damageAt('rifle',100));assert.ok(damageAt('shotgun',5)>damageAt('shotgun',40)*4);
 assert.ok(damageAt('pistol',10,true)>damageAt('pistol',10,false));
 const m=new Match('tdm',nav),a=m.actor('blue',true);a.ammo=17;m.switchWeapon(a,'shotgun');assert.equal(a.ammo,8);a.ammo=4;m.switchWeapon(a,'rifle');assert.equal(a.ammo,17);
});
test('hitscan applies actual distance and refuses shooting while reloading',()=>{
 const m=new Match('tdm',nav),a=at(m.actor('blue',true),-35,-10),b=at(m.actor('red',true),-35,-20);
 m.fire(a,{x:0,y:0,z:-1});assert.ok(b.hp<100);assert.equal(a.ammo,29);assert.equal(m.events.at(-1).hit,true);
 m.elapsed=1;m.reload(a);const ammo=a.ammo;m.fire(a,{x:0,y:0,z:-1});assert.equal(a.ammo,ammo);
 m.tick(2.1);assert.equal(a.ammo,30);
});
test('rotated building ray intersection blocks projectiles before distant targets',()=>{
 const c={px:0,pz:0,py:1,w:4,d:2,h:2,rot:Math.PI/4};
 assert.ok(boxRay(c,{x:-8,y:1,z:0},{x:1,y:0,z:0},50)<10);
 assert.equal(boxRay(c,{x:-8,y:8,z:0},{x:1,y:0,z:0},50),Infinity);
});
test('horde only spawns outside the squad view cone and never on freshly observed ground',()=>{
 const m=new Match('survival',nav),h=m.join('h','甲');
 at(h,m.spawnAreas.blue.x,m.spawnAreas.blue.z);h.yaw=0;
 m.elapsed=30;
 // Record where each zombie actually appeared, before the pursuit steering moves it.
 const spawns=[];const original=m.actor.bind(m);
 m.actor=(...args)=>{const a=original(...args);if(a&&a.kind==='zombie')spawns.push({x:a.x,z:a.z,seenAt:m.seen.get(m.cellKey(a.x,a.z))});return a;};
 for(let i=0;i<900;i++){m.elapsed+=.6;m.nextZombie=0;m.hordeTick();}
 assert.ok(spawns.length>10,'director produced a horde: '+spawns.length);
 for(const s of spawns){
  const d=Math.hypot(s.x-h.x,s.z-h.z);
  assert.ok(d>20,'zombie spawned on top of the player: '+d.toFixed(1));
  if(d<=110){
   let diff=Math.atan2(-(s.x-h.x),-(s.z-h.z))-h.yaw;
   diff=((diff+Math.PI)%(Math.PI*2))-Math.PI;if(diff<-Math.PI)diff+=Math.PI*2;
   assert.ok(Math.abs(diff)>1.15,'zombie spawned inside the view cone: '+diff.toFixed(2));
  }
 }
});
test('horde despawns far from every player and stays capped',()=>{
 const m=new Match('survival',nav),h=m.join('h','甲');
 at(h,0,0);h.yaw=0;m.elapsed=60;
 const z=m.actor('horde',false,'感染者','zombie',null,{x:400,z:400,y:0});
 m.hordeTick();assert.equal(m.actors.has(z.id),false,'distant zombie culled');
});
test('horde never exceeds its cap and joins carry an avatar selection',()=>{
 const m=new Match('survival',nav),h=m.join('h','甲','blue',4);
 assert.equal(m.actors.get('h').avatar,4);
 for(let i=0;i<4000;i++){m.elapsed+=.6;m.nextZombie=0;m.hordeTick();}
 assert.ok([...m.actors.values()].filter(a=>a.kind==='zombie').length<=110);
 const snap=m.snapshot('h');
 assert.equal(snap.actors.find(a=>a.id==='h').avatar,4);
 assert.equal(typeof snap.actors[0].reloading,'boolean');
});

test('walk, sprint and crouch speeds come from one shared table',()=>{
 assert.equal(speedFor({kind:'soldier'}),MOVEMENT.WALK);
 assert.equal(speedFor({kind:'soldier',sprint:true}),MOVEMENT.SPRINT);
 assert.equal(speedFor({kind:'soldier',crouch:true,sprint:true}),MOVEMENT.CROUCH);
 // Firing must never take the gun away: sprinting used to disable the trigger, which read as
 // "no sound and no muzzle flash while moving".
 assert.equal(speedFor({kind:'soldier',sprint:true,fire:true}),MOVEMENT.SPRINT);
 assert.equal(speedFor({kind:'soldier',sprint:true,aim:true}),MOVEMENT.SPRINT);
 assert.ok(speedFor({kind:'zombie',elapsed:0})<MOVEMENT.WALK);
 assert.ok(speedFor({kind:'zombie',elapsed:600})>speedFor({kind:'zombie',elapsed:0}));
});
test('a human and a bot cover identical ground over the same second',()=>{
 const run=(sprint)=>{
  const m=new Match('tdm',nav),start=m.spawnAreas.blue;
  const human=m.actor('blue',true,'甲'),bot=m.actor('blue');
  at(human,start.x-3,start.z);at(bot,start.x+3,start.z);
  bot.thinkAt=Infinity;bot.target=null;
  bot.state=sprint?'evacuate':'patrol';
  bot.goal={x:start.x,z:start.z-400};bot.path=[{x:start.x,z:start.z-400}];
  const heading={x:0,z:-1};
  human.yaw=Math.atan2(-heading.x,-heading.z);bot.yaw=human.yaw;
  human.input={forward:1,side:0,yaw:human.yaw,sprint,fire:false,aim:false};human.inputAt=m.elapsed;
  const from={hx:human.x,hz:human.z,bx:bot.x,bz:bot.z};
  for(let i=0;i<30;i++){m.tick(1/30);human.inputAt=m.elapsed;human.input={forward:1,side:0,yaw:human.yaw,sprint,fire:false,aim:false};}
  return {human:Math.hypot(human.x-from.hx,human.z-from.hz),bot:Math.hypot(bot.x-from.bx,bot.z-from.bz),sprinting:!!bot.sprinting};
 };
 const walk=run(false),sprint=run(true);
 assert.ok(walk.human>2,'human walked '+walk.human);
 assert.ok(Math.abs(walk.human-walk.bot)<.05,`walk distance differs: human ${walk.human.toFixed(3)} bot ${walk.bot.toFixed(3)}`);
 assert.ok(sprint.human>walk.human*1.4,'sprinting must be clearly faster');
 assert.ok(Math.abs(sprint.human-sprint.bot)<.05,`sprint distance differs: human ${sprint.human.toFixed(3)} bot ${sprint.bot.toFixed(3)}`);
});
test('bots sprint to close ground and walk once they are in the fight',()=>{
 const m=new Match('survival',nav),human=m.join('h','甲');
 at(human,m.spawnAreas.blue.x,m.spawnAreas.blue.z);
 const bot=[...m.actors.values()].find(a=>!a.human&&a.kind==='soldier');
 const far=m.actor('horde',false,'远敌','zombie',null,{x:human.x+90,z:human.z,y:0});
 bot.target=far.id;bot.thinkAt=Infinity;bot.state='combat';
 m.elapsed=5;m.botTick(bot,1/30);
 const sprintedFar=bot.sprinting;
 bot.target=human.id;at(human,bot.x+8,bot.z);
 m.elapsed=5;m.botTick(bot,1/30);
 assert.equal(sprintedFar,true,'bot should run while closing a long distance');
 assert.equal(bot.sprinting,false,'bot should walk once the target is close');
});
test('damage falls off with distance and stops at the weapon range',()=>{
 for(const key of Object.keys(WEAPONS)){
  const w=WEAPONS[key];
  assert.ok(damageAt(w,w.falloffStart)>=damageAt(w,w.falloffEnd),key+' must not gain damage with distance');
  assert.ok(damageAt(w,w.range+1)===0,key+' must do nothing past its range');
  // A falloff nobody can feel is the same as no falloff: demand a real drop over the band.
  assert.ok(damageAt(w,w.falloffEnd)<damageAt(w,w.falloffStart)*.45,key+' falloff is too shallow to notice');
 }
 assert.ok(damageAt('rifle',10)>damageAt('rifle',60),'rifle loses damage by 60m');
 assert.ok(damageAt('shotgun',5)>damageAt('shotgun',30),'shotgun is a close-range weapon');
 assert.ok(WEAPONS.shotgun.range<WEAPONS.pistol.range&&WEAPONS.pistol.range<WEAPONS.rifle.range);
});
test('bodies are solid: you cannot walk through another actor',()=>{
 const m=new Match('tdm',nav),start=m.spawnAreas.blue;
 const a=m.actor('blue',true,'甲'),b=m.actor('red',true,'乙');
 at(a,start.x,start.z);at(b,start.x,start.z-4);
 b.thinkAt=Infinity;b.target=null;b.state='patrol';
 a.yaw=0;a.input={forward:1,side:0,yaw:0,sprint:false,fire:false,aim:false};a.inputAt=m.elapsed;
 let minGap=Infinity;
 for(let i=0;i<90;i++){
  m.tick(1/30);a.inputAt=m.elapsed;a.input={forward:1,side:0,yaw:0,sprint:false,fire:false,aim:false};
  minGap=Math.min(minGap,Math.hypot(a.x-b.x,a.z-b.z));
 }
 assert.ok(minGap>.7,'walked into another body, closest approach '+minGap.toFixed(3));
 // Two actors stacked on the same spot must be pushed apart, not left overlapping.
 const c=m.actor('blue',true,'丙');at(c,a.x,a.z);
 for(let i=0;i<20;i++)m.tick(1/30);
 assert.ok(Math.hypot(c.x-a.x,c.z-a.z)>.7,'overlapping bodies were never separated');
});
test('zombie grades carry the health the player is actually shooting at',()=>{
 const m=new Match('survival',nav);
 const plain=[],armored=[];
 for(let i=0;i<200;i++){
  const z=m.actor('horde',false,'感染者','zombie',null,{x:0,z:0,y:0});
  if(!z)continue;
  (z.variant===1?armored:plain).push(z);
  m.actors.delete(z.id);
 }
 assert.ok(plain.length&&armored.length,'both grades must spawn');
 for(const z of plain){assert.equal(z.hp,195,'plain zombie hp');assert.equal(z.variant,0);}
 for(const z of armored){assert.equal(z.hp,390,'armoured zombie hp');assert.equal(z.variant,1);}
 assert.equal(armored[0].hp,plain[0].hp*2,'armoured is twice the plain zombie');
 assert.ok(armored.length<plain.length,'the elite should be the rarer one');
 // soldiers are untouched
 const s=m.actor('blue',true,'甲');
 assert.equal(s.hp,100);assert.equal(s.variant,0);
});