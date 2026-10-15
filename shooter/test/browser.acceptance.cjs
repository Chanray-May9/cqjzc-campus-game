// Real browser controls and two independent clients; deterministic server setup
// is used for health/victory/extraction assertions, without adding cheat endpoints.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
process.env.SHOOTER_PORT='8128';const app=require('../server.cjs');
const {terrain}=require('../world.cjs');
const out=process.env.CAMPUS_QA_OUTPUT||path.resolve(__dirname,'../../work/acceptance');fs.mkdirSync(out,{recursive:true});
const url='http://127.0.0.1:8128',results=[],errors=[],httpErrors=[];
function pass(name,details={}){results.push({name,passed:true,...details});console.log('PASS',name,JSON.stringify(details));}
function place(a,x,z){a.x=x;a.z=z;a.y=terrain.ground(x,z);a.input={};}
const state=p=>p.evaluate(()=>__campusQA.state);
async function wait(p,fn,arg){await p.waitForFunction(fn,arg,{timeout:12000});}
async function open(browser,touch=false){
 const context=await browser.newContext(touch?{viewport:{width:844,height:390},hasTouch:true,isMobile:true,deviceScaleFactor:1}:{viewport:{width:1600,height:900}});
 const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
 p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 p.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('/favicon.ico'))httpErrors.push({status:r.status(),url:r.url()});});
 await p.goto(url);await p.waitForFunction(()=>__campusQA?.ready,undefined,{timeout:120000});return {p,context};
}
async function deploy(p,mode='tdm',team='blue'){
 await p.locator(`[data-mode="${mode}"]`).click();if(mode==='tdm')await p.locator(`[data-team="${team}"]`).click();
 await p.locator('#deploy').click();await wait(p,mode=>__campusQA.state?.mode===mode,mode);
}
async function aim(p,yaw,pitch=0){await p.evaluate(({yaw,pitch})=>{
 const c=__campusQA.controls;document.dispatchEvent(new MouseEvent('mousemove',{movementX:(c.yaw-yaw)/.0018,movementY:(c.pitch-pitch)/.0018}));
 },{yaw,pitch});}
let browser;
(async()=>{
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
 const {p:a,context:ca}=await open(browser),{p:b,context:cb}=await open(browser);
 await a.waitForTimeout(900);await a.screenshot({path:path.join(out,'射击游戏-新版大厅.png')});
 await a.evaluate(()=>{document.getElementById('lobby').style.visibility='hidden';__campusQA.preview([-108,1.9,18],[-48,2.5,-30]);});
 await a.waitForTimeout(700);await a.screenshot({path:path.join(out,'校园-材质同机位对照.png')});
 await a.evaluate(()=>{__campusQA.clearPreview();document.getElementById('lobby').style.visibility='';});
 // Every visible lobby entry must actually do something.
 await a.locator('#nav-lan').click();assert.ok(await a.locator('#lan-dialog').isVisible(),'LAN dialog opens');
 const roomAddress=await a.locator('#lan-room-address').inputValue();assert.match(roomAddress,/^http:\/\/.+:\d+$/);
 await a.locator('#lan-close').click();assert.ok(!(await a.locator('#lan-dialog').isVisible()));
 await a.locator('#nav-avatar').click();assert.ok(await a.locator('#avatar-modal').isVisible(),'avatar picker opens');
 const avatarCards=await a.locator('#avatar-grid .avatar-card').count();
 await a.screenshot({path:path.join(out,'射击游戏-角色选择.png')});
 await a.locator('#avatar-close').click();
 await a.locator('#nav-armory').click();assert.ok(await a.locator('#armory').isVisible());await a.locator('#armory-close').click();
 await a.locator('#open-settings').click();assert.ok(await a.locator('#settings').isVisible());await a.locator('#settings-close').click();
 const loadedAvatars=await a.evaluate(()=>__campusQA.avatars.length);
 pass('lobby entries all open real UI',{roomAddress,avatarCards,loadedAvatarModels:loadedAvatars});
 await deploy(a);await deploy(b,'tdm','red');
 await wait(a,()=>__campusQA.state.actors.filter(x=>x.human).length===2);
 let sa=await state(a),sb=await state(b),aa=app.rooms.get('tdm').actors.get(sa.you),bb=app.rooms.get('tdm').actors.get(sb.you);
 assert.equal(sa.actors.length,60);assert.equal(sb.player.team,'red');
 const gap=Math.hypot(aa.x-bb.x,aa.z-bb.z);assert.ok(gap>=150);pass('two browser clients / 30v30 / separated starting areas',{initialGapMeters:+gap.toFixed(1)});
 // A black screen must never pass again: the scene has to issue real draw calls.
 const drawCalls=await a.evaluate(()=>__campusQA.perf.calls);
 assert.ok(drawCalls>200,'renderer is drawing nothing: '+drawCalls+' draw calls');
 pass('renderer actually draws the world',{drawCalls});
 const room=app.rooms.get('tdm');room.botTick=()=>{};
 place(aa,-35,-10);place(bb,-35,-20);await a.waitForTimeout(300);
 await aim(a,Math.PI/2);const beforeX=aa.x;await a.keyboard.down('KeyW');await a.waitForTimeout(950);await a.keyboard.up('KeyW');assert.ok(Math.abs(aa.x-beforeX)>2);pass('keyboard moves the authoritative player');
 place(aa,-35,-10);await a.waitForTimeout(300);await aim(a,0);await a.keyboard.press('Digit3');await wait(a,()=>__campusQA.state.player.weapon==='pistol');
 assert.equal((await state(a)).player.ammo,12);await a.waitForTimeout(300);await a.mouse.down();await a.waitForTimeout(120);await a.mouse.up();
 await wait(b,()=>__campusQA.state.player.hp<100);pass('pistol shot damages the other browser player',{remainingHP:bb.hp});
 await a.keyboard.press('KeyR',{delay:90});await wait(a,()=>__campusQA.state.player.reloading>0);await wait(a,()=>__campusQA.state.player.reloading===0&&__campusQA.state.player.ammo===12);pass('reload completes and updates HUD');
 // Fire while walking forward: shots must leave the barrel and reach the server.
 place(aa,-35,-10);await a.waitForTimeout(300);await aim(a,0);await a.keyboard.press('Digit1');
 await wait(a,()=>__campusQA.state.player.weapon==='rifle');const shotBefore=aa.shot;
 await a.keyboard.down('KeyW');await a.mouse.down();
 const flash=await a.evaluate(async()=>{
   let lit=0,samples=0;await new Promise(resolve=>{const started=performance.now();
     (function step(){const m=__campusQA.muzzle;samples++;if(m.visible)lit++;if(performance.now()-started>1400)resolve();else requestAnimationFrame(step);})();});
   return {lit,samples};});
 await a.mouse.up();await a.keyboard.up('KeyW');
 assert.ok(aa.shot-shotBefore>=3,'rifle fired while walking forward');
 assert.ok(flash.lit>0,'muzzle flash rendered during the burst');
 pass('walking forward and firing at the same time',{shots:aa.shot-shotBefore,flashFrames:flash.lit});
 // Downed actors keep a body on the ground instead of vanishing.
 const target=[...room.actors.values()].filter(x=>x.team==='red'&&!x.human)
   .sort((x,y)=>Math.hypot(x.x-aa.x,x.z-aa.z)-Math.hypot(y.x-aa.x,y.z-aa.z))[0];
 place(target,aa.x+6,aa.z);await a.waitForTimeout(400);
 room.damage(target,200,aa);await a.waitForTimeout(700);
 const corpses=await a.evaluate(()=>__campusQA.corpses);assert.ok(corpses>0,'a corpse stays visible after death');
 assert.ok(await a.evaluate(()=>!!__campusQA.deadSpot()));pass('death pose replaces instant despawn',{corpses});
 await a.evaluate(()=>{const s=__campusQA.deadSpot();if(s)__campusQA.lookAt(s.x,s.y,s.z,5,1.5);});
 await a.waitForTimeout(500);await a.screenshot({path:path.join(out,'射击游戏-阵亡倒地.png')});
 await a.evaluate(()=>{__campusQA.clearPreview();});
 await a.waitForTimeout(200);
 await a.keyboard.press('Digit3');await wait(a,()=>__campusQA.state.player.weapon==='pistol');
 aa.kills=7;const id=aa.id;await ca.setOffline(true);await a.waitForTimeout(500);await ca.setOffline(false);
 await wait(a,id=>__campusQA.state?.you===id&&__campusQA.state?.player.kills===7&&__campusQA.state?.player.weapon==='pistol',id);pass('browser reconnect preserves ID / score / selected weapon');
 // Touch controls: dragging with actual pointer events, then inspect server movement.
 const {p:m,context:cm}=await open(browser,true);await deploy(m);await wait(m,()=>__campusQA.controls.touch);
 const sm=await state(m),mobile=room.actors.get(sm.you);place(mobile,-60,-10);await m.waitForTimeout(300);
 const touch=await cm.newCDPSession(m);await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:9,x:90,y:280}]});
 await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:9,x:90,y:225}]});
 const start={x:mobile.x,z:mobile.z};await m.waitForTimeout(650);
 await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 assert.ok(Math.hypot(mobile.x-start.x,mobile.z-start.z)>1);assert.equal((await m.evaluate(()=>__campusQA.controls.move.forward)),0);
 await m.locator('[data-weapon="shotgun"]').click();await wait(m,()=>__campusQA.state.player.weapon==='shotgun');
 // Firing is correctly refused while dead, and the pump gun has a 0.85s cadence, so make sure
 // the shooter is alive and the trigger interval has elapsed before asserting a shot lands.
 await m.waitForTimeout(900);
 for(let tries=0;tries<8&&!(await m.evaluate(()=>__campusQA.state.player.alive));tries++)await m.waitForTimeout(1000);
 await m.waitForTimeout(1000);
 await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:10,x:760,y:265}]});await m.waitForTimeout(150);
 await touch.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await wait(m,()=>__campusQA.state.player.ammo<8);assert.equal(await m.evaluate(()=>__campusQA.controls.fire),false);
 await m.locator('#touch-aim').click();assert.equal(await m.evaluate(()=>__campusQA.controls.aim),true);
 await m.screenshot({path:path.join(out,'射击游戏-手机横屏操作.png')});
 await m.locator('#touch-menu').click();const paused={x:mobile.x,z:mobile.z};await m.waitForTimeout(350);assert.ok(Math.hypot(mobile.x-paused.x,mobile.z-paused.z)<.3);
 pass('touch joystick / fire cancellation / weapon switch / aim / pause');
 await m.locator('#leave').click();await cm.close();
 await a.waitForTimeout(700);await a.screenshot({path:path.join(out,'射击游戏-团队竞技.png')});
 room.score.blue=149;bb.hp=100;room.damage(bb,100,aa);await wait(a,()=>__campusQA.state.winner==='blue');await a.locator('#result-title').waitFor();
 assert.equal(await a.locator('#result-title').textContent(),'胜利');assert.equal(await b.locator('#result-title').textContent(),'本局失利');pass('150th elimination yields matching winner / loser screens');
 await a.locator('#result-leave').click();await b.locator('#result-leave').click();await a.waitForTimeout(180);
 await deploy(a,'survival');await deploy(b,'survival');
 const survival=app.rooms.get('survival');survival.botTick=()=>{};
 sa=await state(a);sb=await state(b);aa=survival.actors.get(sa.you);bb=survival.actors.get(sb.you);
 assert.equal([...survival.actors.values()].filter(x=>x.kind==='soldier').length,3);pass('survival keeps a two-person AI fireteam');
 place(aa,-35,-26);aa.hp=40;aa.damageAt=survival.elapsed;await a.waitForTimeout(650);assert.equal(aa.hp,40);
 place(aa,survival.clinic.x,survival.clinic.z);await wait(a,()=>__campusQA.state.player.hp>65);pass('survival heals only inside clinic');
 // Verify an actual zombie melee tick, with the attacker beside a player.
 const z=survival.actor('horde',false,'丧尸','zombie');assert.ok(z);place(z,bb.x+.8,bb.z);z.target=bb.id;z.thinkAt=Infinity;z.fireAt=-100;
 const hp=bb.hp;Object.getPrototypeOf(survival).botTick.call(survival,z,.033);assert.ok(bb.hp<hp);pass('zombie melee subtracts health');
 // The clinic must be walkable in the client's own collision model, not just on the server.
 const clinicInside=await a.evaluate(()=>{const r=__campusQA.clinicRoom;return __campusQA.probe(r.x,r.z);});
 assert.equal(clinicInside.standable,true,'clinic interior is walkable, no air wall');
 assert.ok(Math.abs(clinicInside.ground-8.72)<.05,'clinic floor height is served to the client');
 const clinicDoor=await a.evaluate(()=>{const r=__campusQA.clinicRoom;return __campusQA.probe(r.x,r.doorZ-1.5);});
 assert.equal(clinicDoor.standable,true,'clinic doorway is walkable');
 pass('clinic is reachable from the client collision model',{floor:+clinicInside.ground.toFixed(2),doorGround:+clinicDoor.ground.toFixed(2)});
 // The horde director must keep quiet ground out of sight and away from the squad.
 const squadPos=survival.actors.get(sa.you);
 survival.elapsed=120;let spawned=0;
 for(let i=0;i<120;i++){const before=survival.actors.size;survival.nextZombie=0;survival.hordeTick();if(survival.actors.size>before)spawned++;}
 const fresh=[...survival.actors.values()].filter(x=>x.kind==='zombie');
 const tooClose=fresh.filter(x=>Math.hypot(x.x-squadPos.x,x.z-squadPos.z)<=20);
 assert.equal(tooClose.length,0,'no zombie appears on top of a player');
 pass('dynamic horde spawns away from the squad',{spawns:spawned,live:fresh.length});
 for(let i=0;i<35;i++)survival.actor('horde',false,'丧尸','zombie');
 place(aa,-35,-10);await a.waitForTimeout(600);await a.screenshot({path:path.join(out,'射击游戏-丧尸生存.png')});
 survival.elapsed=599.9;await wait(a,()=>__campusQA.state.helicopter!==null);assert.equal((await state(a)).helicopter.arrived,false);
 survival.elapsed=616;place(aa,survival.landing.x,survival.landing.z);place(bb,survival.landing.x+2,survival.landing.z);
 await wait(a,()=>__campusQA.state.helicopter?.arrived);await a.waitForTimeout(350);
 await a.screenshot({path:path.join(out,'射击游戏-直升机登机.png')});
 await a.keyboard.press('KeyF',{delay:90});await wait(a,()=>__campusQA.state.player.extracted);
 assert.equal(bb.extracted,false);assert.equal(survival.winner,null);assert.notEqual(survival.phase,'finished');pass('accelerated ten-minute arrival / boarding / individual extraction');
 await a.screenshot({path:path.join(out,'射击游戏-个人撤离成功.png')});
 const fps=await b.evaluate(()=>__campusQA.fps);pass('runtime measurement',{desktopHeadlessFPS:fps});
 assert.deepEqual(httpErrors,[]);assert.deepEqual(errors,[]);pass('no browser or shader errors / no missing game assets');
 await ca.close();await cb.close();
})().catch(e=>{errors.push(e.stack);console.error(e);process.exitCode=1;}).finally(async()=>{
 if(browser)await browser.close();app.close();
 fs.writeFileSync(path.join(out,'游戏验收结果.json'),JSON.stringify({results,errors,httpErrors,note:'Browser emulation is not a physical-phone test. Helicopter timing uses an accelerated server clock.'},null,2));
});
