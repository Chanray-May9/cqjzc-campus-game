const test=require('node:test'),assert=require('node:assert/strict');
const {WebSocket}=require('ws');
process.env.SHOOTER_PORT='8126';
const app=require('../server.cjs');
const sockets=[];
async function connect(token=''){
 const ws=new WebSocket(`ws://127.0.0.1:8126/?session=${token}`);sockets.push(ws);const messages=[];
 ws.on('message',b=>messages.push(JSON.parse(b.toString())));
 await new Promise((resolve,reject)=>{ws.on('open',resolve);ws.on('error',reject);});
 const wait=async predicate=>{const start=Date.now();while(Date.now()-start<5000){const i=messages.findIndex(predicate);if(i>=0)return messages.splice(i,1)[0];await new Promise(r=>setTimeout(r,20));}throw Error('message timeout');};
 return {ws,wait,welcome:await wait(m=>m.type==='welcome')};
}
test.after(()=>{for(const s of sockets)s.terminate();app.close();});
test('LAN clients join same/opposite teams and share authoritative scores',async()=>{
 const a=await connect(),b=await connect(),c=await connect();
 a.ws.send(JSON.stringify({type:'join',mode:'tdm',team:'blue',name:'A'}));
 b.ws.send(JSON.stringify({type:'join',mode:'tdm',team:'blue',name:'B'}));
 c.ws.send(JSON.stringify({type:'join',mode:'tdm',team:'red',name:'C'}));
 const sa=await a.wait(m=>m.type==='state'&&m.actors.filter(a=>a.human).length===3);
 const sc=await c.wait(m=>m.type==='state');
 assert.equal(sa.actors.length,60);assert.equal(sa.player.team,'blue');assert.equal(sc.player.team,'red');
 assert.deepEqual(sa.score,sc.score);
 a.ws.send(JSON.stringify({type:'input',weapon:'pistol',yaw:0}));
 const pistol=await a.wait(m=>m.type==='state'&&m.player.weapon==='pistol');assert.equal(pistol.player.ammo,12);
 a.ws.close();b.ws.close();c.ws.close();
});
test('disconnect/reconnect restores the same player, ammo, position and statistics',async()=>{
 const first=await connect();first.ws.send(JSON.stringify({type:'join',mode:'survival',name:'恢复测试'}));
 await first.wait(m=>m.type==='joined');const room=app.rooms.get('survival'),actor=room.actors.get(first.welcome.id);
 actor.kills=7;actor.ammo=19;actor.x=-35;actor.z=-26;actor.y=0;actor.hp=73;actor.damageAt=room.elapsed;
 first.ws.close();await new Promise(r=>first.ws.once('close',r));
 assert.ok(room.actors.has(actor.id));
 const second=await connect(first.welcome.session);const joined=await second.wait(m=>m.type==='joined');
 const restored=await second.wait(m=>m.type==='state');assert.equal(joined.resumed,true);
 assert.equal(restored.you,actor.id);assert.equal(restored.player.kills,7);assert.equal(restored.player.ammo,19);assert.equal(restored.player.hp,73);
 assert.equal(restored.actors.find(a=>a.id===actor.id).x,-35);
 second.ws.close();
});
