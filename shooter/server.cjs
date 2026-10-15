const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {WebSocketServer}=require('ws');
const {Navigation}=require('./world.cjs');
const {Match}=require('./match.cjs');
const {WEAPONS}=require('./weapons.cjs');
const {MOVEMENT}=require('./movement.cjs');
const root=path.resolve(__dirname,'..'),port=Number(process.env.SHOOTER_PORT||8124);
const nav=new Navigation(),rooms=new Map(),clients=new Map(),sessions=new Map();
const addresses=()=>Object.values(os.networkInterfaces()).flat().filter(a=>a.family==='IPv4'&&!a.internal).map(a=>`http://${a.address}:${port}`);
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.css':'text/css','.glb':'model/gltf-binary','.jpg':'image/jpeg','.png':'image/png','.hdr':'application/octet-stream','.ogg':'audio/ogg','.txt':'text/plain; charset=utf-8'};
const server=http.createServer((req,res)=>{
  let uri;
  try{uri=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400);res.end();return;}
  if(uri==='/favicon.ico'){res.writeHead(204);res.end();return;}
  if(uri==='/api/status'){
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({addresses:addresses(),version:'1.0.0',navNodes:nav.nodes.length,
      rooms:[...rooms.values()].map(m=>({mode:m.mode,players:[...m.actors.values()].filter(a=>a.human).length,time:m.elapsed,phase:m.phase}))}));return;
  }
  if(uri==='/api/weapons'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(WEAPONS));return;}
  if(uri==='/api/movement'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(MOVEMENT));return;}
  let base=path.join(root,'web'),relative=uri==='/'?'shooter/index.html':uri.slice(1);
  if(uri.startsWith('/modules/')){base=path.join(root,'node_modules');relative=uri.slice(9);}
  if(uri==='/explore'){relative='explore.html';}
  const file=path.resolve(base,relative);
  if(!file.startsWith(path.resolve(base)+path.sep)){res.writeHead(403);res.end();return;}
  fs.stat(file,(err,stat)=>{
    if(err||!stat.isFile()){res.writeHead(404);res.end('Not found');return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
    fs.createReadStream(file).pipe(res);
  });
});
const wss=new WebSocketServer({server,maxPayload:4096});
const send=(ws,message)=>{if(ws.readyState===1)ws.send(JSON.stringify(message));};
wss.on('connection',(ws,request)=>{
  const supplied=new URL(request.url,'http://localhost').searchParams.get('session');
  let client=sessions.get(supplied);
  if(client?.socket&&client.socket.readyState===1){send(ws,{type:'error',message:'此角色已在其他连接中作战'});ws.close();return;}
  if(!client){client={id:crypto.randomUUID(),token:crypto.randomBytes(24).toString('hex'),room:null,lastEvent:0,lastInput:0};sessions.set(client.token,client);}
  client.socket=ws;client.expires=Infinity;clients.set(ws,client);
  send(ws,{type:'welcome',id:client.id,session:client.token,addresses:addresses()});
  if(client.room?.actors.has(client.id)){
    send(ws,{type:'joined',id:client.id,mode:client.room.mode,resumed:true,team:client.room.actors.get(client.id).team});
    send(ws,client.room.snapshot(client.id,client.lastEvent));
  }
  ws.on('message',buffer=>{
    let m;try{m=JSON.parse(buffer.toString());}catch{return;}
    try{
      if(m.type==='join'){
        if(client.room?.actors.has(client.id)&&client.room.mode===m.mode){
          send(ws,{type:'joined',id:client.id,mode:client.room.mode,resumed:true,team:client.room.actors.get(client.id).team});return;
        }
        if(client.room)client.room.leave(client.id);
        if(!['tdm','survival'].includes(m.mode))throw Error('无效模式');
        let room=rooms.get(m.mode);
        if(!room||room.phase==='finished'&&![...room.actors.values()].some(a=>a.human)){
          room=new Match(m.mode,nav);rooms.set(m.mode,room);
        }
        if(room.phase==='finished')throw Error('本局已经结束，请等待房间重新开始');
        room.join(client.id,m.name,m.team,m.avatar);client.room=room;client.lastEvent=0;
        send(ws,{type:'joined',id:client.id,mode:m.mode});
        send(ws,room.snapshot(client.id,0));
      }else if(m.type==='input'&&client.room){client.room.setInput(client.id,m);}
      else if(m.type==='leave'){client.room?.leave(client.id);client.room=null;send(ws,{type:'left'});}
      else if(m.type==='ping')send(ws,{type:'pong',stamp:m.stamp});
    }catch(e){send(ws,{type:'error',message:e.message});}
  });
  ws.on('close',()=>{
    if(client.socket===ws){client.socket=null;client.expires=Date.now()+45000;
      const actor=client.room?.actors.get(client.id);if(actor)actor.input={};}
    clients.delete(ws);
  });
  ws.on('error',()=>{});
});
let previous=performance.now(),tick=0;
const timer=setInterval(()=>{
  const now=performance.now(),clockDelta=(now-previous)/1000,dt=Math.min(.1,clockDelta);previous=now;
  for(const [token,c]of sessions)if(c.expires<Date.now()){c.room?.leave(c.id);sessions.delete(token);}
  for(const [key,room] of rooms){
    if(![...room.actors.values()].some(a=>a.human)){rooms.delete(key);continue;}
    room.tick(dt,clockDelta);
  }
  if(++tick%2===0)for(const [ws,c] of clients){
    if(!c.room||ws.bufferedAmount>300000)continue;
    send(ws,c.room.snapshot(c.id,c.lastEvent));c.lastEvent=c.room.eventSerial;
  }
},1000/30);
server.listen(port,'0.0.0.0',()=>{
  console.log(`Campus shooter http://127.0.0.1:${port}`);
  console.log(`LAN ${addresses().join(' | ')}`);
  console.log(`YUKA navigation ${nav.nodes.length} nodes; authoritative 30Hz simulation`);
});
function close(){clearInterval(timer);wss.close();server.close();}
process.on('SIGINT',()=>{close();process.exit(0);});
module.exports={server,wss,rooms,clients,sessions,nav,close};
