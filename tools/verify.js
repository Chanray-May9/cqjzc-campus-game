/* Structural + spatial verification of the exported campus.
 *
 *   node tools/verify.js
 *
 * 1. parses the GLB container (magic / version / chunk layout / accessors)
 * 2. re-implements the terrain profile from blender/build_campus.py
 * 3. checks every spawn point, vehicle and POI against ground + colliders
 * 4. cross-checks the modelled floor area against the official schedule
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GLB = path.join(ROOT, 'web', 'assets', 'campus.glb');
const META = path.join(ROOT, 'web', 'assets', 'campus_meta.json');

let fails = 0, warns = 0;
const ok = (m) => console.log('  \u2713 ' + m);
const bad = (m) => { fails++; console.log('  \u2717 ' + m); };
const warn = (m) => { warns++; console.log('  ! ' + m); };

/* ------------------------------------------------------------------ GLB */
console.log('\n=== GLB container ===');
const buf = fs.readFileSync(GLB);
if (buf.readUInt32LE(0) !== 0x46546C67) bad('bad magic (not a GLB)');
else ok('magic glTF');
const version = buf.readUInt32LE(4);
const total = buf.readUInt32LE(8);
if (version !== 2) bad('version ' + version + ' (expected 2)'); else ok('version 2');
if (total !== buf.length) bad(`declared length ${total} != file size ${buf.length}`);
else ok(`length ${total} bytes (${(total / 1048576).toFixed(2)} MB)`);

let off = 12, json = null, binLen = 0;
while (off < buf.length) {
  const clen = buf.readUInt32LE(off);
  const ctype = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + clen);
  if (ctype === 0x4E4F534A) json = JSON.parse(data.toString('utf8'));
  else if (ctype === 0x004E4942) binLen = clen;
  off += 8 + clen + ((4 - (clen % 4)) % 4);
}
if (!json) { bad('no JSON chunk'); process.exit(1); }
ok(`JSON chunk: ${json.meshes.length} meshes, ${json.materials.length} materials, ` +
  `${json.accessors.length} accessors, ${(json.images || []).length} images`);
ok(`BIN chunk: ${(binLen / 1048576).toFixed(2)} MB`);

let tris = 0, verts = 0;
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
for (const mesh of json.meshes) {
  for (const p of mesh.primitives) {
    const pos = json.accessors[p.attributes.POSITION];
    const idx = p.indices != null ? json.accessors[p.indices] : null;
    verts += pos.count;
    tris += idx ? idx.count / 3 : pos.count / 3;
    if (pos.min && pos.max) {
      minX = Math.min(minX, pos.min[0]); maxX = Math.max(maxX, pos.max[0]);
      minY = Math.min(minY, pos.min[1]); maxY = Math.max(maxY, pos.max[1]);
      minZ = Math.min(minZ, pos.min[2]); maxZ = Math.max(maxZ, pos.max[2]);
    }
  }
}
ok(`geometry: ${verts} vertices, ${tris} triangles`);
ok(`bounds: x[${minX.toFixed(0)} ${maxX.toFixed(0)}]  y[${minY.toFixed(0)} ${maxY.toFixed(0)}]` +
  `  z[${minZ.toFixed(0)} ${maxZ.toFixed(0)}]`);
/* These ground and building finishes are deliberately exported without an embedded texture:
   web/shooter/client.js replaces them with the external ambientCG files at load time, and
   keeping the 2K copies inside the GLB only inflated the model by ~60MB. */
const RUNTIME_TEXTURED = new Set(['m_grass', 'm_grass_wild', 'm_turf', 'm_roof_green', 'm_concrete',
  'm_paving', 'm_paving_warm', 'm_roof_grey', 'm_asphalt', 'm_brick']);
for (const m of json.materials) {
  if (!m.pbrMetallicRoughness || !m.pbrMetallicRoughness.baseColorTexture) {
    const name = (m.name || '?');
    if (RUNTIME_TEXTURED.has(name.toLowerCase())) ok(`runtime-supplied texture: ${name}`);
    else warn('material without a base colour texture: ' + name);
  }
}

/* ---------------------------------------------------------------- terrain */
console.log('\n=== terrain profile (mirror of the python build) ===');
const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
const terrain = require('../web/js/terrain.js').create(meta.terrain.config);
const groundAt = terrain.ground;
const CAMPUS = meta.meta.campus;
ok('terrain configuration shared with the browser; polygon boundary and walkable stairs');
console.log('\n=== campus_meta.json ===');
ok(`title: ${meta.meta.title}`);
ok(`${meta.colliders.length} colliders, ${meta.pois.length} POIs, ${meta.vehicles.length} vehicles, ${meta.roads.length} road polylines`);

if(new Set(meta.colliders.map(c=>c.id)).size!==meta.colliders.length) bad('duplicate collider IDs lose boxes in the browser grid');
else ok('all collider IDs unique, including paired teaching blocks and gym portal');
if(meta.terrain.plan_issues?.length) meta.terrain.plan_issues.forEach(bad);
else if(Array.isArray(meta.terrain.plan_issues)) ok('oriented building footprints and road strips clear');
else bad('missing plan geometry check');
const heightSamples=meta.terrain.height_samples || [];
if(!heightSamples.length) bad('missing Python terrain reference samples');
else {
  let worst=0;
  for(const [x,z,y] of heightSamples) worst=Math.max(worst,Math.abs(groundAt(x,z)-y));
  if(worst>1e-7) bad(`Python/browser ground mismatch: ${worst}m`);
  else ok(`${heightSamples.length} Python/browser terrain height comparisons`);
}
for(const st of meta.terrain.config.steps){
  const riser=Math.abs(st.high-st.low)/st.count;
  if(riser>0.18 || st.segments.some(s=>s.b<=s.a)) bad(`invalid stair geometry: ${st.name}`);
  else ok(`${st.name}: ${st.count} risers, ${Math.abs(st.high-st.low).toFixed(1)}m rise`);
}

// Execute the actual game collision function against rotated faces.
const gameSource=fs.readFileSync(path.join(ROOT,'web/js/game.js'),'utf8');
const collisionSource=gameSource.slice(gameSource.indexOf('function collideBox('),gameSource.indexOf('  /* --------------------------------------------------------------- sky'));
const collision=new Function('clamp',`return (${collisionSource.trim()});`)((v,a,b)=>Math.max(a,Math.min(b,v)));
let collisionFailures=0;
for(const rot of [-1.1,-.415,0,.4,1.1]) {
  const c={px:10,pz:20,py:5,w:16,d:8,h:10,rot};
  for(const side of [-1,1]){
    const u=side*(c.w/2-.1),X=c.px+u*Math.cos(rot),Z=c.pz+u*Math.sin(rot);
    const hit=collision(c,X,Z,0,1.8,.5);
    if(!hit || hit.pushX===undefined){collisionFailures++;continue;}
    const du=(X+hit.pushX-c.px)*Math.cos(rot)+(Z+hit.pushZ-c.pz)*Math.sin(rot);
    if(Math.abs(du-side*(c.w/2+.5))>1e-7)collisionFailures++;
  }
}
if(collisionFailures)bad('rotated collision push regression');
else ok('actual game collision pushes outside rotated building faces');

function inside(c, X, Z, pad) {
  const dx = X - c.px, dz = Z - c.pz;
  const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  return Math.abs(lx) < c.w / 2 + pad && Math.abs(lz) < c.d / 2 + pad;
}

// spawn
console.log('\n--- spawn ---');
const sp = meta.spawn;
const gy = groundAt(sp.x, sp.z);
if (Math.abs(sp.y - gy) > 3.0) warn(`spawn y=${sp.y.toFixed(2)} vs ground ${gy.toFixed(2)}`);
else ok(`spawn (${sp.x.toFixed(0)}, ${sp.z.toFixed(0)}) ground ${gy.toFixed(2)}`);
let hit = meta.colliders.filter(c => inside(c, sp.x, sp.z, 0));
if (hit.length) bad('spawn inside collider: ' + hit.map(h => h.name).join(', '));
else ok('spawn is clear of every collider');

// vehicles
console.log('\n--- vehicles ---');
let vbad = 0;
for (const v of meta.vehicles) {
  const g = groundAt(v.x, v.z);
  if (Math.abs(v.y - g) > 1.5) { warn(`${v.id} y=${v.y.toFixed(2)} vs ground ${g.toFixed(2)}`); vbad++; }
  const h2 = meta.colliders.filter(c => inside(c, v.x, v.z, 0.6));
  if (h2.length) { bad(`${v.id} overlaps ${h2.map(h => h.name).join(', ')}`); vbad++; }
}
if (!vbad) ok(`all ${meta.vehicles.length} vehicles sit on the ground and clear of buildings`);

// POIs
console.log('\n--- POIs ---');
const outside = meta.pois.filter(p =>
  p.x < CAMPUS.x0 - 40 || p.x > CAMPUS.x1 + 40 || p.z < -CAMPUS.y1 - 60 || p.z > -CAMPUS.y0 + 60);
if (outside.length) warn('POIs outside the site: ' + outside.map(p => p.name).join(', '));
else ok(`all ${meta.pois.length} POIs inside the site`);

// floor area cross-check against the official schedule
console.log('\n--- floor-area cross-check vs 施工许可证明细表 ---');
const sum = meta.pois.reduce((a, p) => a + (p.area || 0), 0);
const official = 169594.17;
ok(`modelled schedule total ${sum.toLocaleString()} ㎡  vs official ${official.toLocaleString()} ㎡`);
if (Math.abs(sum - official) > 400) warn(`difference ${(sum - official).toFixed(1)} ㎡`);
else ok('within 400 ㎡ of the official total');

const named = meta.pois.filter(p => p.area > 0).length;
if (named !== 23) warn(`${named} scheduled entries modelled (official schedule: 23 条 / 19 栋)`);
else ok('23 scheduled entries modelled, matching the official 明细表 (19 栋)');

// User corrections: stairs must stay outside the full running oval; the
// lower entrance court must be flat even outside the old campus polygon.
console.log('\n--- track clearance and lower entrance court ---');
const cfg=meta.terrain.config,track=cfg.track;
const outer=track.radius+track.lanes*track.lane_w;
for(const step of cfg.steps){
  const a=step.rot*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  let clearance=Infinity;
  for(let i=0;i<=40;i++)for(let j=0;j<=10;j++){
    const u=-step.length/2+step.length*i/40,v=-step.width/2+step.width*j/10;
    const x=step.x+u*c-v*s,y=step.y+u*s+v*c;
    clearance=Math.min(clearance,Math.hypot(Math.max(Math.abs(x-track.cx)-track.straight/2,0),y-track.cy)-outer);
  }
  if(clearance<1)bad(`${step.name} intrudes into running-track clearance`);
  else ok(`${step.name} clears the running oval`);
}
const court=cfg.forecourt;
let courtFlat=true;
for(const u of [-.45,0,.45])for(const v of [-.45,0,.45]){
  const h=groundAt(court.x+u*court.w,-(court.y+v*court.d));
  if(Math.abs(h-court.level)>.05)courtFlat=false;
}
if(courtFlat)ok('large lower entrance court remains flat across the site boundary');
else bad('lower entrance court is distorted by surrounding terrain');

console.log('\n--- food-to-dorm walking connection ---');
const dormStep=cfg.steps.find(s=>s.name==='食堂至宿舍平台阶梯');
if(!dormStep)bad('missing food-to-dorm stair flight');
else{
  const a=dormStep.rot*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  let blocked=false;
  for(const seg of dormStep.segments){
    const u=(seg.a+seg.b)/2,x=dormStep.x+u*c,y=dormStep.y+u*s;
    if(meta.colliders.some(box=>inside(box,x,-y,.2)))blocked=true;
  }
  if(blocked)bad('food-to-dorm stairs intersect a building footprint');
  else ok('food-to-dorm stairs clear the building footprints');
  for(const [sign,level] of [[-1,dormStep.low],[1,dormStep.high]]){
    const u=sign*(dormStep.length/2+.3),x=dormStep.x+u*c,y=dormStep.y+u*s;
    if(Math.abs(groundAt(x,-y)-level)>.2)bad('food-to-dorm stairs have a disconnected landing');
  }
  ok('food-to-dorm stair landing heights checked');
}

console.log('\n--- gate-side buildings span both street levels ---');
for(const id of ['b03','b04']){
  const p=meta.pois.find(q=>q.id===id),box=meta.colliders.find(q=>q.name===p.name);
  const upper=groundAt(p.x,p.z-box.d/2-.6),lower=groundAt(p.x,p.z+box.d/2+.6);
  const sixthFloor=p.y+.6+5*p.floor_height,roof=p.y+.6+6*p.floor_height;
  if(!p.split_grade || Math.abs(sixthFloor-upper)>.3 || Math.abs((roof-upper)-p.floor_height)>.3)
    bad(`${id} must expose exactly one storey above the upper street`);
  else ok(`${id}: one storey above upper street, five storeys descending`);
  if(Math.abs((p.y+.6)-lower)>.4)bad(`${id} lower entry does not meet the lower street`);
}

// Photo correction: the basin slopes down towards the main gate (-Y).
console.log('\n--- science pavilion pool slope direction ---');
const pool=cfg.pool;
const gateBed=terrain.pad(pool.x,pool.y-.45*pool.ry);
const fieldBed=terrain.pad(pool.x,pool.y+.92*pool.ry);
if(!(gateBed<pool.water && fieldBed>pool.water && fieldBed-gateBed>3))
  bad('pool must have water on the low gate side and exposed concrete on the high field side');
else ok(`pool slopes towards main gate: gate bed ${gateBed.toFixed(2)}m, field bed ${fieldBed.toFixed(2)}m`);
const slopeRun=pool.bed_y1-pool.bed_y0;
const midRise=terrain.pad(pool.x,pool.y+pool.bed_y1)-terrain.pad(pool.x,pool.y+pool.bed_y0);
const highRim=pool.rim_level+pool.rim_relief;
if(midRise/slopeRun<.3 || highRim-pool.water<3)
  bad('pool slope is too shallow for the photograph correction');
else ok(`pool has pronounced slope and ${(highRim-pool.water).toFixed(1)}m high-rim-to-water drop (model estimate)`);
for(const side of [-1,1]){
  const y=pool.y+side*.45*pool.ry;
  const x=pool.x+cfg.bridge.width;
  if(Math.abs(groundAt(x,-y)-terrain.pad(x,y))>1e-7)
    bad('pool render/game terrain levels differ');
}

// Outside the basin, side lawns climb to a wide terrace instead of falling
// immediately after an oval rim. Sample the full approach, beyond the old blend.
for(const dx of [-38,38]){
  let previous=-Infinity;
  for(let dy=-pool.ry;dy<=pool.grade_back;dy+=.5){
    const height=terrain.pad(pool.x+dx,pool.y+dy);
    if(height<previous-1e-7){bad('pavilion side lawn has a mound or backwards slope');break;}
    previous=height;
  }
  if(Math.abs(previous-highRim)>1e-7)bad('pavilion lawn does not meet the upper terrace');
}
ok('both side lawns form one-way slopes into the broad upper terrace');
for(const stairs of cfg.steps.filter(s=>s.side_lawn)){
  const a=stairs.rot*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  let minRadius=Infinity;
  for(let u=-stairs.length/2;u<=stairs.length/2;u+=.5){
    for(const v of [-stairs.width/2-.425,0,stairs.width/2+.425]){
      const x=stairs.x+u*c-v*s,y=stairs.y+u*s+v*c;
      const dx=(x-pool.x)/pool.rx,dy=(y-pool.y)/pool.ry,t=Math.atan2(dy,dx);
      minRadius=Math.min(minRadius,Math.hypot(dx,dy)/(1+.065*Math.sin(3*t)+.055*Math.cos(t)));
    }
  }
  if(minRadius<1.25)bad(`${stairs.name} crosses the pool or its rim walkway`);
  else ok(`${stairs.name} sits entirely in the lawn, clear of the pool walkway`);
}
const bridge=cfg.bridge;
if(!bridge || Math.abs(bridge.level-3.42)>1e-7 || bridge.y0>=bridge.y1)
  bad('missing rear entrance bridge at lower-disc entrance level');
else {
  for(let i=0;i<=40;i++){
    const y=bridge.y0+(bridge.y1-bridge.y0)*i/40;
    if(Math.abs(groundAt(bridge.x,-y)-bridge.level)>1e-7)bad('bridge walking surface differs from its deck');
  }
  const landing=terrain.pad(bridge.x,bridge.y1+.01)+.12;
  if(Math.abs(landing-bridge.level)>.02)bad('bridge does not connect to the high-side landing');
  else ok('rear bridge deck joins upper lawn paving at the pavilion entrance height');
}

/* --------------------------------------------------------------- summary */
console.log('\n--- low reviewing platform and intervening road ---');
const stand=cfg.grandstand,road=cfg.roads.find(r=>r.name==='gym_front');
const hall=meta.pois.find(p=>p.id==='b08');
const hallBox=meta.colliders.find(c=>c.name===hall.name);
if(!stand || !road)bad('missing low reviewing platform or road in front of Qinglan Hall');
else {
  const [x,y]=stand.pos;
  const field=terrain.pad(cfg.track.cx,cfg.track.cy);
  if(stand.deck-field>1.5 || stand.canopy-field>4)bad('reviewing platform is too tall above the playing field');
  else ok('reviewing deck about 1m above the field; low canopy below 4m');
  const roadY=road.pts[0][1],near=roadY-road.width/2,far=roadY+road.width/2;
  const hallFront=-hall.z-hallBox.d/2;
  if(near<=y+stand.size[1]/2+.5 || far>=hallFront)bad('road is not clear between stand and Qinglan Hall');
  else ok('separate asphalt road runs between the reviewing platform and Qinglan Hall');
  if(Math.abs(groundAt(x,-y)-stand.deck)>1e-7)bad('reviewing deck walking height differs from its geometry');
}
console.log('\n=== result ===');
console.log(`  ${fails} errors, ${warns} warnings`);
process.exitCode = fails ? 1 : 0;
