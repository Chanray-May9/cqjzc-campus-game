import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RGBELoader} from 'three/addons/loaders/RGBELoader.js';
import {clone as cloneSkeleton} from 'three/addons/utils/SkeletonUtils.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {GTAOPass} from 'three/addons/postprocessing/GTAOPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {SMAAPass} from 'three/addons/postprocessing/SMAAPass.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';

const $=id=>document.getElementById(id),clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
/* Server-owned movement constants. The client predicts with these exact numbers so a human and a
   bot cover the same ground per second; see shooter/movement.cjs. */
let MOVEMENT={WALK:4.1,SPRINT:6.8,CROUCH:2.2,JUMP:6.7,GRAVITY:20,ZOMBIE_WALK:2,ZOMBIE_RAMP:.65,ZOMBIE_RAMP_SECONDS:600};
function speedFor(o){if(o.kind==='zombie')return MOVEMENT.ZOMBIE_WALK+((o.elapsed||0)/MOVEMENT.ZOMBIE_RAMP_SECONDS)*MOVEMENT.ZOMBIE_RAMP;if(o.crouch)return MOVEMENT.CROUCH;if(o.sprint&&!(o.aim||o.fire))return MOVEMENT.SPRINT;return MOVEMENT.WALK;}
const G={ready:false,playing:false,mode:'tdm',team:'blue',ws:null,id:null,state:null,actors:new Map(),keys:{},
  yaw:Math.PI*.5,pitch:-.05,fire:false,aim:false,locked:false,third:false,clock:0,frames:0,fps:0,ping:0,
  predicted:null,lastFrame:performance.now(),noticeUntil:0,hitUntil:0,damageUntil:0,recoil:0,lastShot:0,
  volume:.7,sensitivity:.0018,quality:'medium',sounds:new Map(),effects:[],resultShown:false,weapon:'rifle',weaponModels:{},
  touch:navigator.maxTouchPoints>0&&matchMedia('(pointer:coarse)').matches,touchMove:{forward:0,side:0,sprint:false},crouch:false,extractUntil:0,treeBatches:[],pulses:{},frameTimes:[],profile:{},
  avatar:Number(localStorage.getItem('campus-avatar')||0),avatarShare:100,
  muzzleUntil:0,muzzleAt:0,reloadAnim:0};
{const requested=new URLSearchParams(location.search).get('avatars');
  if(requested!==null){G.avatarShare=clamp(Number(requested)||0,0,100);G.avatarSharePinned=true;}}
if(G.touch)document.body.classList.add('touch');
const controlsActive=()=>G.playing&&!G.resultShown&&$('pause').classList.contains('hidden')&&(G.locked||G.touch);
const renderer=new THREE.WebGLRenderer({canvas:$('scene'),antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(G.touch?Math.min(devicePixelRatio,1.1):Math.min(devicePixelRatio,1.6));renderer.setSize(innerWidth,innerHeight);
renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.AgXToneMapping;
renderer.toneMappingExposure=.95;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.info.autoReset=false;
const scene=new THREE.Scene();scene.background=new THREE.Color('#b5c9d5');scene.fog=new THREE.Fog('#bfccd0',400,1150);
const camera=new THREE.PerspectiveCamera(68,innerWidth/innerHeight,.055,1600);camera.rotation.order='YXZ';scene.add(camera);
const hemi=new THREE.HemisphereLight('#d6e2e7','#636953',.55);scene.add(hemi);
const sun=new THREE.DirectionalLight('#fff4df',3.0);sun.position.set(-140,260,-90);sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-170,right:170,top:170,bottom:-170,near:1,far:650});
sun.shadow.bias=-.00035;sun.shadow.normalBias=.08;scene.add(sun,sun.target);
const composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));
/* Ambient occlusion is by far the most expensive thing in the frame: it re-renders the whole
   scene into a depth/normal buffer before the AO itself runs, which roughly doubles the draw
   calls on its own (measured 1604 with it against 778 without, 46 fps against 91). It is
   therefore evaluated at half resolution with half the samples, and switched off entirely when
   the frame budget is blown. */
const aoPass=new GTAOPass(scene,camera,innerWidth,innerHeight);
aoPass.blendIntensity=.5;
aoPass.updateGtaoMaterial({radius:1.2,thickness:1.0,distanceExponent:1.5,scale:1,samples:8});
aoPass.updatePdMaterial({radius:5,rings:2,samples:8});aoPass.enabled=!G.touch;composer.addPass(aoPass);
const grade=new ShaderPass({uniforms:{tDiffuse:{value:null}},vertexShader:'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
  fragmentShader:`uniform sampler2D tDiffuse; varying vec2 vUv;
  void main(){vec4 c=texture2D(tDiffuse,vUv);float l=dot(c.rgb,vec3(.2126,.7152,.0722));
  c.rgb=mix(vec3(l),c.rgb,.92);c.rgb*=vec3(1.015,1.005,.99);c.rgb*=1.0-.08*pow(length(vUv-.5),2.0);gl_FragColor=c;}`});
composer.addPass(grade);composer.addPass(new OutputPass());
const aaPass=new SMAAPass(innerWidth*renderer.getPixelRatio(),innerHeight*renderer.getPixelRatio());composer.addPass(aaPass);
function resizeEffects(){composer.setPixelRatio(renderer.getPixelRatio());composer.setSize(innerWidth,innerHeight);aoPass.enabled=G.quality!=='low'&&!G.touch;}
resizeEffects();
const textureLoader=new THREE.TextureLoader(),gltfLoader=new GLTFLoader(),rgbLoader=new RGBELoader();
gltfLoader.setMeshoptDecoder(MeshoptDecoder);
let meta,terrain,campus,soldierTemplate,zombieTemplate,rifleTemplate,weapon,helicopter,weaponSpecs;
let zombieTemplates=[];
let flashSprite=null,flashLight=null,motionSource=null,motionClips=[];
/* A/B switch for the rig-frame conversion, so the two retarget variants can be measured. */
const THREE_NS=THREE;
const USE_YAW_ALIGN=new URLSearchParams(location.search).get('yawalign')!=='0';const muzzleTexture=null;
const actorsRoot=new THREE.Group();scene.add(actorsRoot);
const loadTexture=async(url,color=false)=>{
  const t=await textureLoader.loadAsync(url);t.wrapS=t.wrapT=THREE.RepeatWrapping;
  t.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());return t;
};
async function pbr(folder,stem){
  const base=`/assets/shooter/${folder}/${stem}_${G.touch&&!['plaster','brick'].includes(folder)?'1K':'2K'}-JPG_`;
  const [map,normalMap,roughnessMap]=await Promise.all([loadTexture(base+'Color.jpg',true),loadTexture(base+'NormalGL.jpg'),loadTexture(base+'Roughness.jpg')]);
  return {map,normalMap,roughnessMap};
}
function applySurface(material, source, repeat){
  for(const [key, texture] of Object.entries(source)){
    const t=texture.clone();t.repeat.set(repeat,repeat);material[key]=t;
  }
  material.color.set('#ffffff');material.normalScale.set(.45,.45);material.roughness=.9;material.metalness=0;material.needsUpdate=true;
}
function wallDetail(material,detail,glazing=false){
  material.onBeforeCompile=shader=>{
    shader.uniforms.detailPhoto={value:detail};
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vSurfaceWorld;')
      .replace('#include <project_vertex>','vSurfaceWorld=(modelMatrix*vec4(transformed,1.0)).xyz;\n#include <project_vertex>');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 vSurfaceWorld; uniform sampler2D detailPhoto;')
      .replace('#include <map_fragment>',`#include <map_fragment>
      vec3 nw=pow(abs(normalize(cross(dFdx(vSurfaceWorld),dFdy(vSurfaceWorld)))),vec3(6.));nw/=max(nw.x+nw.y+nw.z,.0001);
      vec3 detail=texture2D(detailPhoto,vSurfaceWorld.yz*.5).rgb*nw.x+texture2D(detailPhoto,vSurfaceWorld.xz*.5).rgb*nw.y+texture2D(detailPhoto,vSurfaceWorld.xy*.5).rgb*nw.z;
      float wallMask=smoothstep(.09,.38,dot(diffuseColor.rgb,vec3(.2126,.7152,.0722)));
      diffuseColor.rgb*=mix(vec3(.95),clamp(detail*1.6,vec3(.65),vec3(1.03)),wallMask*.65);
      float weather=.96+.04*sin(vSurfaceWorld.x*.035+sin(vSurfaceWorld.z*.049));diffuseColor.rgb*=weather;`)
      .replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>
      roughnessFactor=${glazing?'mix(.38,max(.82,roughnessFactor),wallMask)':'max(.85,roughnessFactor)'};`);
  };
  material.customProgramCacheKey=()=> 'photographic-wall-v2-'+glazing;material.needsUpdate=true;
}
function groundVariation(material){
  material.onBeforeCompile=shader=>{
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vTerrainWorld;')
      .replace('#include <project_vertex>','vTerrainWorld=(modelMatrix*vec4(transformed,1.0)).xyz;\n#include <project_vertex>');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 vTerrainWorld;')
      .replace('#include <map_fragment>',`#include <map_fragment>
      float variation=sin(vTerrainWorld.x*.067+sin(vTerrainWorld.z*.041)*2.)*sin(vTerrainWorld.z*.055);
      diffuseColor.rgb*=mix(vec3(.72,.77,.66),vec3(.96,.95,.89),.5+.5*variation);`)
      .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=max(.93,roughnessFactor);');
  };material.customProgramCacheKey=()=> 'ground-macro-v1';material.needsUpdate=true;
}
function drySurface(material,min=.86){
  material.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>\nroughnessFactor=max(${min.toFixed(2)},roughnessFactor);`);};
  material.customProgramCacheKey=()=> 'dry-surface-'+min;material.needsUpdate=true;
}
function gunFinish(root){
  root.traverse(o=>{if(!o.isMesh)return;for(const m of Array.isArray(o.material)?o.material:[o.material]){
    if(m.isMeshStandardMaterial){m.envMapIntensity=.25;m.metalness=Math.min(m.metalness,.55);m.roughness=Math.max(m.roughness,.58);drySurface(m,.48);}
  }});
}
function addTrees(gltf,lod){
  const normalized=normalizeModel(gltf,1),root=normalized.root;root.updateMatrixWorld(true);
  root.traverse(o=>{if(!o.isMesh)return;
    const materials=Array.isArray(o.material)?o.material:[o.material];
    for(const m of materials){if(m.transparent){m.transparent=false;m.alphaTest=lod===0?.35:.08;m.depthWrite=true;m.color.set('#8d9c70');}m.side=THREE.DoubleSide;}
    const batch=new THREE.InstancedMesh(o.geometry,o.material,meta.trees.length);
    batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);batch.castShadow=lod===0;batch.receiveShadow=true;
    batch.count=0;batch.frustumCulled=false;scene.add(batch);
    G.treeBatches.push({batch,source:o.matrixWorld.clone(),lod});
  });
}
function updateTrees(){
  if(G.clock-(G.treesAt??-10)<.5)return;G.treesAt=G.clock;
  const temp=new THREE.Object3D(),matrix=new THREE.Matrix4(),position=G.predicted||camera.position;
  const near=G.quality==='low'?35:G.touch?70:G.quality==='high'?150:110;
  const lists=[[],[]];
  for(const t of meta.trees||[]){const distance=Math.hypot(t.x-position.x,t.z-position.z);if(distance<650)lists[distance<near?0:1].push(t);}
  for(const {batch,source,lod} of G.treeBatches){
    const trees=lists[lod];batch.count=trees.length;
    trees.forEach((t,i)=>{temp.position.set(t.x,t.y,t.z);temp.rotation.set(0,t.yaw,0);temp.scale.setScalar(t.height);temp.updateMatrix();matrix.multiplyMatrices(temp.matrix,source);batch.setMatrixAt(i,matrix);});
    batch.instanceMatrix.needsUpdate=true;
  }
  G.treeCounts=lists.map(x=>x.length);
}
/* Rig-agnostic facing probe: in a humanoid bind pose the foot bone points at the toe
   along the character's forward axis, so the sign of that Z component tells us whether
   the authored model faces -Z (the game convention) or +Z and needs a half turn. */
/* World position is authoritative from the server, so any baked hip travel in a clip would
   fight it and make characters slide. Flatten the horizontal channels, keep the vertical bob. */
function stripRootMotion(clips){
  for(const clip of clips||[])for(const track of clip.tracks){
    if(!/\.position$/.test(track.name)||!/(hips|pelvis|root|armature)/i.test(track.name))continue;
    const values=track.values;if(!values||values.length<3)continue;
    const x0=values[0],z0=values[2];
    for(let i=0;i<values.length;i+=3){values[i]=x0;values[i+2]=z0;}
  }
}
function detectFacing(object){
  object.updateMatrixWorld(true);
  const bones=[];object.traverse(o=>{if(o.isBone)bones.push(o);});
  const pick=re=>bones.find(b=>re.test(b.name.toLowerCase()));
  const foot=pick(/left.*(foot|ankle)|(foot|ankle).*left/)||pick(/(foot|ankle)/);
  const toe=pick(/left.*toe|toe.*left/)||pick(/toe/);
  if(!foot||!toe)return null;
  const f=foot.getWorldPosition(new THREE.Vector3()),t=toe.getWorldPosition(new THREE.Vector3());
  const v=new THREE.Vector3(t.x-f.x,0,t.z-f.z);
  if(v.lengthSq()<1e-6)return null;
  return v.z>0?Math.PI:0;
}
/* ---------------- muzzle flash: geometry, not a decal ---------------- */
/* The old version was a single additive sprite cut from muzzle.png. That is a flat billboard:
   its rectangular edge and its bright-but-not-zero border were both plainly visible against
   the grass, and it never occupied any space. This builds an actual flash volume instead:
   a star of petals around the bore plus a forward cone, a hot core, a few spark streaks and
   a real point light, all randomised per shot. */
const flashMaterial=new THREE.MeshBasicMaterial({color:'#ffd9a2',transparent:true,opacity:1,
  blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide,fog:false});
function buildFlashStar(petals=6,outer=.33,inner=.1,depth=.14){
  const positions=[];
  for(let i=0;i<petals;i++){
    const a=i/petals*Math.PI*2+Math.PI/petals*((i%2)?1:-1)*.6;
    const tip=[Math.cos(a)*outer,Math.sin(a)*outer,depth*.35];
    const left=[Math.cos(a-.46)*inner,Math.sin(a-.46)*inner,-depth*.3];
    const right=[Math.cos(a+.46)*inner,Math.sin(a+.46)*inner,-depth*.3];
    positions.push(...left,...right,...tip);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.computeVertexNormals();
  return geometry;
}
function buildFlashCone(radius=.105,length=.3,segments=8){
  const geometry=new THREE.ConeGeometry(radius,length,segments,1,true);
  geometry.translate(0,0,-length/2);   // apex at the muzzle, opening forward along -Z
  geometry.rotateX(-Math.PI/2);
  return geometry;
}
const FLASH_GEOMETRY={
  star:buildFlashStar(),cone:buildFlashCone(),core:new THREE.SphereGeometry(.062,12,9),spark:new THREE.BoxGeometry(.012,.012,.16)};
const FLASH_LIFE=.075;          // a real muzzle flash is two to four frames
const SMOKE_LIFE=.42;           // the puff that hangs in the air afterwards
/* Every muzzle flash gets its own material so its opacity can be animated, and its own random
   roll, petal spread and spark layout - repeating the identical silhouette every shot is the
   single biggest reason a flash reads as a decal. */
function spawnFlash(scale=1){
  const material=flashMaterial.clone();
  const group=new THREE.Group();group.userData.material=material;
  const cone=new THREE.Mesh(FLASH_GEOMETRY.cone,material);
  cone.rotation.x=Math.PI/2;
  const star=new THREE.Mesh(FLASH_GEOMETRY.star,material);
  star.scale.setScalar(.85+Math.random()*.5);
  const inner=new THREE.Mesh(FLASH_GEOMETRY.star,material);
  inner.scale.setScalar(.45+Math.random()*.25);
  inner.rotation.z=Math.PI/7;
  const core=new THREE.Mesh(FLASH_GEOMETRY.core,material);
  core.scale.setScalar(.95+Math.random()*.7);
  group.add(star,inner,cone,core);
  const sparks=3+Math.floor(Math.random()*3);
  for(let i=0;i<sparks;i++){
    const spark=new THREE.Mesh(FLASH_GEOMETRY.spark,material);
    const a=Math.random()*Math.PI*2;
    spark.position.set(Math.cos(a)*.06,Math.sin(a)*.06,-.14-Math.random()*.16);
    spark.rotation.set(Math.random()*1.4-.7,Math.random()*1.4-.7,a);
    group.add(spark);
  }
  group.rotation.set((Math.random()-.5)*.5,0,Math.random()*Math.PI*2);
  group.userData.baseScale=scale*(.95+Math.random()*.45);
  group.scale.setScalar(group.userData.baseScale);
  return group;
}
/* Rise fast, collapse fast, fade out. Driven by a lifetime curve instead of a binary on/off,
   which is what makes it read as a burst rather than a sticker. */
function animateFlash(group,age,life=FLASH_LIFE){
  const t=clamp(age/life,0,1);
  /* Snap on, then decay. A soft attack meant the first frame of every shot rendered at zero
     opacity, which reads as the flash arriving late. */
  const rise=Math.min(1,t/.05);
  const decay=Math.pow(1-t,1.3);
  const material=group.userData.material||flashMaterial;
  material.opacity=Math.min(1,rise*1.7)*decay;
  group.scale.setScalar((group.userData.baseScale||1)*(.62+.55*rise)*(.6+.6*decay));
  group.rotation.z+=(Math.random()-.5)*.06;
}
function hideFlash(group){if(group.userData.material)group.userData.material.opacity=0;}
/* ---------------- cast: real imported character models ---------------- */
const avatarTemplates=[];
const TEAM_TINT={blue:new THREE.Color('#4c86c8'),red:new THREE.Color('#c8674c'),horde:new THREE.Color('#8a9a5b')};
/* One semantic skeleton description that matches every rig we load: the built-in Mixamo
   soldier, the Universal Animation Library mannequin, and the VRoid J_Bip_* humanoids. */
const HUMANOID_BONE={
  hips:['mixamorigHips','DEF-hips','J_Bip_C_Hips','Hips','hips','pelvis'],
  spine:['mixamorigSpine','DEF-spine','DEF-spine.001','J_Bip_C_Spine','Spine','spine','spine.001'],
  chest:['mixamorigSpine1','DEF-spine.002','J_Bip_C_Chest','Spine1','Chest','chest','spine.002'],
  upperChest:['mixamorigSpine2','DEF-spine.003','J_Bip_C_UpperChest','Spine2','UpperChest','upper_chest','spine.003'],
  neck:['mixamorigNeck','DEF-neck','J_Bip_C_Neck','Neck','neck'],
  head:['mixamorigHead','DEF-head','J_Bip_C_Head','Head','head','head 1'],
  leftShoulder:['mixamorigLeftShoulder','DEF-shoulder.L','J_Bip_L_Shoulder','LeftShoulder','shoulder.L'],
  leftUpperArm:['mixamorigLeftArm','DEF-upper_arm.L','J_Bip_L_UpperArm','LeftArm','LeftUpperArm','upper_arm.L','arm.L'],
  leftLowerArm:['mixamorigLeftForeArm','DEF-forearm.L','J_Bip_L_LowerArm','LeftForeArm','LeftLowerArm','forearm.L','lower_arm.L'],
  leftHand:['mixamorigLeftHand','DEF-hand.L','J_Bip_L_Hand','LeftHand','hand.L','wrist.L'],
  rightShoulder:['mixamorigRightShoulder','DEF-shoulder.R','J_Bip_R_Shoulder','RightShoulder','shoulder.R'],
  rightUpperArm:['mixamorigRightArm','DEF-upper_arm.R','J_Bip_R_UpperArm','RightArm','RightUpperArm','upper_arm.R','arm.R'],
  rightLowerArm:['mixamorigRightForeArm','DEF-forearm.R','J_Bip_R_LowerArm','RightForeArm','RightLowerArm','forearm.R','lower_arm.R'],
  rightHand:['mixamorigRightHand','DEF-hand.R','J_Bip_R_Hand','RightHand','hand.R','wrist.R'],
  leftUpperLeg:['mixamorigLeftUpLeg','DEF-thigh.L','J_Bip_L_UpperLeg','LeftUpLeg','LeftUpperLeg','thigh.L','upleg.L'],
  leftLowerLeg:['mixamorigLeftLeg','DEF-shin.L','J_Bip_L_LowerLeg','LeftLeg','LeftLowerLeg','shin.L','leg.L','calf.L'],
  leftFoot:['mixamorigLeftFoot','DEF-foot.L','J_Bip_L_Foot','LeftFoot','foot.L','ankle.L'],
  leftToe:['mixamorigLeftToeBase','DEF-toe.L','J_Bip_L_ToeBase','LeftToeBase','toe.L','toebase.L'],
  rightUpperLeg:['mixamorigRightUpLeg','DEF-thigh.R','J_Bip_R_UpperLeg','RightUpLeg','RightUpperLeg','thigh.R','upleg.R'],
  rightLowerLeg:['mixamorigRightLeg','DEF-shin.R','J_Bip_R_LowerLeg','RightLeg','RightLowerLeg','shin.R','leg.R','calf.R'],
  rightFoot:['mixamorigRightFoot','DEF-foot.R','J_Bip_R_Foot','RightFoot','foot.R','ankle.R'],
  rightToe:['mixamorigRightToeBase','DEF-toe.R','J_Bip_R_ToeBase','RightToeBase','toe.R','toebase.R'],
};
const ROLE_OF_BONE=new Map();
/* three.js strips . : / [ ] from node names when it loads a glTF, so `DEF-thigh.L` arrives
   as `DEF-thighL`, and rigs disagree on capitalisation (`hips` vs `Hips`). Sanitise and fold
   case on both sides or almost nothing matches. */
const sanitizeNodeName=name=>name.replace(/\s/g,'_').replace(/[\[\]\.:\/]/g,'').toLowerCase();
for(const [role,aliases]of Object.entries(HUMANOID_BONE))for(const alias of aliases)ROLE_OF_BONE.set(sanitizeNodeName(alias),role);
/* Match a target skeleton's bones to a source skeleton's by semantic role first, then by a
   normalised name, so a rig with entirely different bone names still receives the motion. */
function buildBoneNames(targetRoot,sourceRoot){
  const sourceByRole=new Map(),sourceByKey=new Map();
  sourceRoot.traverse(o=>{
    if(!o.isBone)return;
    const role=roleOf(o.name);
    if(role&&!sourceByRole.has(role))sourceByRole.set(role,o.name);
    sourceByKey.set(boneKey(o.name),o.name);
  });
  const names={};let mapped=0;
  targetRoot.traverse(o=>{
    if(!o.isBone)return;
    const role=roleOf(o.name);
    if(role&&sourceByRole.has(role)){names[o.name]=sourceByRole.get(role);mapped++;return;}
    const key=boneKey(o.name);
    if(sourceByKey.has(key)){names[o.name]=sourceByKey.get(key);mapped++;}
  });
  return mapped>=6?names:null;
}
/* Rigs exported from Blender often carry an armature prefix: the zombie's bones are
   Armature_ZombieHips, Armature_ZombieLeftUpLeg and so on. Stripping it turns them back into
   ordinary Mixamo names, which is what lets the role table match - without it the whole skeleton
   failed to match, so the zombie never received a death animation and a corpse still on its feet
   looked exactly like a live target. Written without the /i flag on purpose: a case-insensitive
   [A-Z] would also swallow the "mixamo" in mixamorigLeftUpLeg. */
function bareBoneName(name){
  const out=String(name).replace(/^[Aa]rmature[_:]?/,'');
  const trimmed=out.replace(/^(?:[Zz]ombie|[Cc]haracter|[Mm]ixamo|[Aa]rmature|[Rr]ig|[Rr]oot)(?=[A-Z_]|$)/,'');
  return trimmed||out;
}
const boneKey=name=>bareBoneName(name).toLowerCase().replace(/^mixamorig[:_]?/,'').replace(/^j_bip_?[lrc]_/,'').replace(/^def-/,'').replace(/[^a-z0-9]/g,'').replace(/[_.]?\d+$/,'');
/* Some exporters append a serial number, e.g. the armoured zombie ships mixamorigHips_01 and
   mixamorigLeftUpLeg_044. The exact name is tried first, because Blender's own duplicate suffixes
   are meaningful - DEF-spine.001 is the chest, not the spine - and only then is a trailing serial
   dropped. */
function roleOf(name){
  const bare=bareBoneName(String(name)).toLowerCase();
  return ROLE_OF_BONE.get(sanitizeNodeName(bare))
    ?? ROLE_OF_BONE.get(sanitizeNodeName(bare.replace(/[_.]\d+$/,'')))
    ?? null;
}
function skinnedOf(root){let found=null;root.traverse(o=>{if(!found&&o.isSkinnedMesh)found=o;});return found;}
/* Clips the game asks for, and where each comes from in the motion library. */
const MOTION_LIBRARY=[['Idle_Loop','idle'],['Walk_Loop','walk'],['Jog_Fwd_Loop','run'],['Sprint_Loop','sprint'],
  ['Death01','death'],['Pistol_Reload','reload'],['Hit_Chest','hit'],['Crouch_Idle_Loop','crouch']];
/* The rest pose is the pose the file was authored in, not Skeleton.pose(). Rebuilding the bind
   pose from the inverse bind matrices produced a rest that disagreed with the clips, which threw
   everybody's arms over their heads; the loaded default is captured and restored instead. */
function captureLocalPose(root){
  const map=new Map();
  root.traverse(o=>{if(o.isBone)map.set(o.name,{q:o.quaternion.clone(),p:o.position.clone()});});
  return map;
}
function restoreLocalPose(root,map){
  if(!map)return;
  root.traverse(o=>{if(!o.isBone)return;const saved=map.get(o.name);if(!saved)return;o.quaternion.copy(saved.q);o.position.copy(saved.p);});
  root.updateMatrixWorld(true);
}
function bakeRetarget(targetRoot,sourceRoot,clip,names,fps=24,sourceRest=null,targetRest=null,yawAlign=0){
  const targetSkinned=skinnedOf(targetRoot),sourceSkinned=skinnedOf(sourceRoot);
  if(!targetSkinned||!sourceSkinned)return null;
  restoreLocalPose(targetRoot,targetRest);restoreLocalPose(sourceRoot,sourceRest);
  /* A world rotation copied between two rigs that were authored facing opposite ways lands on
     the mirrored limb: the animation-library mannequin looks down +Z while the built-in soldier
     and the VRoid characters look down -Z, which is why the left leg played the right leg's
     motion. Rotating the delta by the yaw between the two authored facings puts it in the
     target's own frame. (The earlier attempt used the parent node's orientation, but that half
     turn lives in the bone orientations themselves, not above them.) */
  const yawQuat=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),yawAlign);
  const yawQuatInv=yawQuat.clone().invert();
  const useYaw=USE_YAW_ALIGN&&Math.abs(yawAlign)>1e-3;
  const restTarget=new Map(),restSource=new Map();
  targetRoot.traverse(o=>{if(o.isBone)restTarget.set(o.name,o.getWorldQuaternion(new THREE.Quaternion()));});
  sourceRoot.traverse(o=>{if(o.isBone)restSource.set(o.name,o.getWorldQuaternion(new THREE.Quaternion()));});
  const sourceBones=new Map();sourceRoot.traverse(o=>{if(o.isBone)sourceBones.set(o.name,o);});
  const ordered=[];const parentName=new Map();
  targetRoot.traverse(o=>{if(!o.isBone)return;ordered.push(o);parentName.set(o.name,o.parent&&o.parent.isBone?o.parent.name:null);});
  const usable=ordered.filter(bone=>names[bone.name]&&sourceBones.has(names[bone.name]));
  if(usable.length<6)return null;
  const frames=Math.max(2,Math.round(clip.duration*fps));
  const delta=clip.duration/(frames-1);
  const times=new Float32Array(frames);
  const values=new Map();for(const bone of usable)values.set(bone.name,new Float32Array(frames*4));
  const mixer=new THREE.AnimationMixer(sourceRoot);
  mixer.clipAction(clip).play();
  const quat=new THREE.Quaternion(),deltaQuat=new THREE.Quaternion(),rigQuat=new THREE.Quaternion(),world=new Map(),parentWorld=new THREE.Quaternion();
  for(let frame=0;frame<frames;frame++){
    mixer.update(frame===0?0:delta);
    sourceRoot.updateMatrixWorld(true);
    world.clear();
    for(const bone of usable){
      const sourceBone=sourceBones.get(names[bone.name]);
      sourceBone.getWorldQuaternion(quat);
      deltaQuat.copy(quat).multiply(restSource.get(sourceBone.name).clone().invert());
      if(useYaw){rigQuat.copy(yawQuat).multiply(deltaQuat).multiply(yawQuatInv);deltaQuat.copy(rigQuat);}
      const targetWorld=deltaQuat.clone().multiply(restTarget.get(bone.name));
      const parent=parentName.get(bone.name);
      if(parent&&world.has(parent))parentWorld.copy(world.get(parent));
      else if(bone.parent)bone.parent.getWorldQuaternion(parentWorld);
      else parentWorld.identity();
      const local=parentWorld.clone().invert().multiply(targetWorld);
      bone.quaternion.copy(local);
      world.set(bone.name,targetWorld);
      const target=values.get(bone.name);
      target[frame*4]=local.x;target[frame*4+1]=local.y;target[frame*4+2]=local.z;target[frame*4+3]=local.w;
      times[frame]=frame*delta;
    }
  }
  mixer.stopAllAction();mixer.uncacheClip(clip);
  restoreLocalPose(targetRoot,targetRest);restoreLocalPose(sourceRoot,sourceRest);
  const tracks=usable.map(bone=>new THREE.QuaternionKeyframeTrack(bone.name+'.quaternion',times,values.get(bone.name)));
  return new THREE.AnimationClip(clip.name,clip.duration,tracks);
}
function retargetTemplate(targetRoot,sourceRoot,clips,rename={}){
  if(!targetRoot||!sourceRoot||!clips?.length)return [];
  const targetSkin=skinnedOf(targetRoot),sourceSkin=skinnedOf(sourceRoot);
  if(!targetSkin||!sourceSkin){console.warn('重定向跳过：缺少蒙皮目标或来源',!!targetSkin,!!sourceSkin);return [];}
  sourceRoot.updateMatrixWorld(true);
  const names=buildBoneNames(targetRoot,sourceRoot);
  if(!names){console.warn('重定向跳过：骨架语义匹配不足');return [];}
  /* Both rigs are still unrotated here, so their authored facings can be compared directly. */
  const yawAlign=(detectFacing(sourceRoot)??0)-(detectFacing(targetRoot)??0);
  const sourceRest=captureLocalPose(sourceRoot),targetRest=captureLocalPose(targetRoot);
  const out=[];
  for(const clip of clips){
    try{
      const baked=bakeRetarget(targetRoot,sourceRoot,clip,names,18,sourceRest,targetRest,yawAlign);
      if(baked){baked.name=rename[clip.name]||clip.name;out.push(baked);}
      else console.warn('重定向失败（可用骨骼不足）：'+clip.name);
    }catch(error){console.warn('动作重定向失败 '+clip.name,error);}
  }
  restoreLocalPose(sourceRoot,sourceRest);restoreLocalPose(targetRoot,targetRest);
  return out;
}

function seedHash(text,seed){
  let h=(2166136261^seed)>>>0;
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}
  return h>>>0;
}
function avatarIndexFor(a){
  if(!avatarTemplates.length)return -1;
  if(Number.isInteger(a.avatar)&&a.avatar>=0&&a.avatar<avatarTemplates.length)return a.avatar;
  const seed=G.state?.seed||0;
  /* Imported characters cost one draw call per material, so the share of the crowd that
     wears them is tunable: ?avatars=60 keeps the rest on the cheap built-in rig. */
  if(seedHash('share'+a.id,seed)%100>=G.avatarShare)return -1;
  return seedHash(String(a.id),seed)%avatarTemplates.length;
}
async function loadAvatars(progress){
  try{
    const manifest=await (await fetch('/assets/shooter/avatars/MANIFEST.json')).json();
    const list=(manifest.avatars||[]).slice(0,32);
    if(!list.length)return;
    progress(80,`载入角色模型 0/${list.length}`);
    let done=0;
    const settled=await Promise.all(list.map(async entry=>{
      try{
        const gltf=await gltfLoader.loadAsync('/assets/shooter/avatars/'+entry.file);
        const facing=detectFacing(gltf.scene)??0;
        stripRootMotion(gltf.animations);
        /* Normalise unrotated, retarget, then apply the facing turn: retargeting bakes world
           matrices, so a parent rotation would leak into the converted bone rotations. */
        const normalized=normalizeModel(gltf,1.8,0,'idle');
        const retargeted=retargetTemplate(normalized.root,soldierTemplate.root,soldierTemplate.animations);
        normalized.root.rotation.y=facing;
        return {...entry,root:normalized.root,animations:retargeted.length?retargeted:gltf.animations,
          facing,retargeted:retargeted.length,skinned:!!skinnedOf(normalized.root)};
      }catch(error){console.warn('角色模型不可用：'+entry.file,error);return null;}
      finally{progress(80+Math.round(18*(++done)/list.length),`载入角色模型 ${done}/${list.length}`);}
    }));
    for(const item of settled)if(item)avatarTemplates.push(item);
  }catch(error){console.warn('角色清单不可用',error);}
}
function buildAvatarPicker(){
  const grid=$('avatar-grid');if(!grid)return;
  grid.replaceChildren();
  const choose=index=>{
    G.avatar=index;localStorage.setItem('campus-avatar',String(index));
    for(const button of grid.querySelectorAll('button'))button.classList.toggle('picked',Number(button.dataset.index)===index);
    showAvatarPreview(index);
  };
  const random=document.createElement('button');
  random.className='avatar-card';random.dataset.index='-1';random.innerHTML='<b>随机</b><small>每局由系统分配</small>';
  random.onclick=()=>choose(-1);grid.append(random);
  avatarTemplates.forEach((item,index)=>{
    const card=document.createElement('button');card.className='avatar-card';card.dataset.index=String(index);
    const label=item.label||item.file.replace(/\.\w+$/,'');
    card.innerHTML=`<b></b><small></small>`;
    card.querySelector('b').textContent=label;
    card.querySelector('small').textContent=(item.style==='anime'?'二次元':item.style||'角色')+(item.character?` · ${item.character}`:'');
    card.title=`来源：${item.source||'未知'}\n许可：${item.license||'未标注'}`;
    card.onclick=()=>choose(index);
    grid.append(card);
  });
  if(!avatarTemplates.length){
    const empty=document.createElement('p');empty.className='hint';empty.textContent='未找到可用的角色模型，将使用默认士兵外观。';grid.append(empty);
  }
  const chosen=Number(localStorage.getItem('campus-avatar')||0);
  for(const button of grid.querySelectorAll('button'))button.classList.toggle('picked',Number(button.dataset.index)===chosen);
}
/* A tiny studio above the campus so the lobby can actually show the chosen model. */
const avatarShowcase=new THREE.Group();scene.add(avatarShowcase);
avatarShowcase.position.set(0,320,0);
const showcasePad=mesh(new THREE.CircleGeometry(1.1,40),new THREE.MeshStandardMaterial({color:'#3a4249',roughness:.9}),avatarShowcase);
showcasePad.rotation.x=-Math.PI/2;showcasePad.position.y=.02;
let showcaseIndex=-2,showcaseMixer=null;
function showAvatarPreview(index){
  const template=index>=0?avatarTemplates[index]:avatarTemplates[0];
  if(showcaseIndex===index||!template)return;
  showcaseIndex=index;
  while(avatarShowcase.children.length>1)avatarShowcase.remove(avatarShowcase.children.at(-1));
  const model=cloneSkeleton(template.root);avatarShowcase.add(model);
  showcaseMixer=new THREE.AnimationMixer(model);
  const clips=template.animations||[];
  const clip=clips.find(c=>/idle/i.test(c.name))||clips[0];
  if(clip)showcaseMixer.clipAction(clip).play();
  const target=new THREE.Vector3(0,320.9,0);
  G.preview={position:new THREE.Vector3(2.3,321.15,3.5),target};
}
function clearAvatarPreview(){G.preview=null;if(showcaseMixer){showcaseMixer.stopAllAction();showcaseMixer=null;}}
/* Overhead identification: friendlies keep a persistent blue tag, hostiles get a
   depth-tested red chevron so they are only marked while actually in sight. */
function markerSprite(actor){
  const friendly=actor.team==='blue';
  const name=(actor.name||'').slice(0,8);
  const canvas=document.createElement('canvas');const c=canvas.getContext('2d');
  if(friendly){
    /* The plate is sized to the text instead of the other way round. The old canvas was 256x72
       with the text on one 44px band, so two thirds of every name plate was empty box that sat
       in the middle of the screen and blocked the view. */
    const font='bold 26px "Microsoft YaHei",sans-serif';
    c.font=font;
    const width=Math.ceil(c.measureText(name).width)+26,height=38;
    canvas.width=width;canvas.height=height;
    const d=canvas.getContext('2d');
    d.font=font;d.textAlign='center';d.textBaseline='middle';
    d.fillStyle='rgba(10,20,28,.46)';d.beginPath();d.roundRect(1,1,width-2,height-2,9);d.fill();
    d.fillStyle='#9ccbea';d.fillText(name,width/2,height/2+1);
  }else if(actor.kind==='zombie'&&actor.variant!==1){
    /* plain zombie: no overhead marker at all */
    canvas.width=2;canvas.height=2;
  }else{
    canvas.width=72;canvas.height=44;
    const d=canvas.getContext('2d');
    d.fillStyle='#e0705c';d.beginPath();d.moveTo(36,6);d.lineTo(52,32);d.lineTo(20,32);d.closePath();d.fill();
    d.fillStyle='rgba(224,112,92,.8)';d.fillRect(24,36,24,6);
  }
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthTest:!friendly,depthWrite:false,opacity:friendly?.8:.9}));
  /* One world unit of height per 38 canvas pixels keeps the text size constant whatever the name. */
  if(friendly)sprite.scale.set(canvas.width/38*.19,.19,1);
  else sprite.scale.set(.62,.38,1);
  sprite.position.y=friendly?2.14:2.05;
  sprite.renderOrder=friendly?4:3;
  return sprite;
}
function tintTeam(root,team){
  const tint=TEAM_TINT[team]||TEAM_TINT.blue;
  root.traverse(o=>{
    if(!o.isMesh)return;
    const list=Array.isArray(o.material)?o.material:[o.material];
    const cloned=list.map(material=>{
      const copy=material.clone();
      if(copy.emissive){copy.emissive=copy.emissive.clone().lerp(tint,.6);copy.emissiveIntensity=.22;}
      return copy;
    });
    o.material=Array.isArray(o.material)?cloned:cloned[0];
  });
}
function chooseAction(actions){
  const match=(...patterns)=>{
    for(const pattern of patterns)for(const [name,action] of Object.entries(actions))if(pattern.test(name))return action;
    return null;
  };
  const idle=match(/^idle$/)||match(/idle/);
  const walk=match(/^walk$/)||match(/walk/);
  const run=match(/^run$/)||match(/jog/)||walk;
  const crouch=match(/^crouch$/)||idle;
  return {idle,walk:walk||idle,run:run||idle,sprint:match(/^sprint$/)||run||idle,crouch,
    death:match(/^death$/)||match(/death|dead|dying|die|fall/),
    reload:match(/^reload$/)||match(/reload|recharge|rearm/),
    hit:match(/^hit$/)||match(/hit_|hit\b/),
    attack:match(/^attack$/)||match(/attack|shoot|fire|skill|spotted/)};
}

function normalizeModel(gltf,height,rotation=0,settleClip=null){
  const model=gltf.scene;
  /* Some rigs ship an unposed bind pose, so the idle clip is played first to get a truthful
     bounding box - and the box has to be measured WHILE that clip is still running. Stopping the
     action first restores the authored rest pose, which for the armoured zombie sits a full metre
     away from the pose its clips actually use: it was grounded against the rest pose, then
     floated a metre in the air the moment the idle played, which also put it above its own
     hitbox so shots aimed at it missed. */
  let mixer=null;
  if(settleClip&&gltf.animations?.length){
    const clip=gltf.animations.find(a=>a.name.toLowerCase().includes(settleClip));
    if(clip){mixer=new THREE.AnimationMixer(model);mixer.clipAction(clip).play();mixer.update(clip.duration>.4?.4:clip.duration*.5);}
  }
  model.updateMatrixWorld(true);
  const box=new THREE.Box3().setFromObject(model),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
  const scale=height/Math.max(.001,size.y);model.scale.multiplyScalar(scale);model.position.set(-center.x*scale,-box.min.y*scale,-center.z*scale);
  if(mixer){mixer.stopAllAction();mixer.uncacheRoot(model);}
  const pivot=new THREE.Group();pivot.add(model);pivot.rotation.y=rotation;
  return {root:pivot,animations:gltf.animations};
}
function normalizedGun(gltf,length=.8){
  const inner=gltf.scene,box=new THREE.Box3().setFromObject(inner),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
  const scale=length/Math.max(size.x,size.y,size.z);inner.scale.multiplyScalar(scale);inner.position.copy(center.multiplyScalar(-scale));
  const pivot=new THREE.Group();pivot.add(inner);
  if(size.x>size.z&&size.x>size.y)pivot.rotation.y=Math.PI/2;
  else if(size.y>size.z)pivot.rotation.x=Math.PI/2;
  const root=new THREE.Group();root.add(pivot);return root;
}
function mesh(geometry,material,parent=scene){const m=new THREE.Mesh(geometry,material);parent.add(m);return m;}
function createHelicopter(){
  const root=new THREE.Group(),metal=new THREE.MeshStandardMaterial({color:'#3b443d',roughness:.52,metalness:.62}),dark=new THREE.MeshStandardMaterial({color:'#151c1e',roughness:.2,metalness:.6});
  const verts=[],indices=[],sections=[[-3.9,.25,.4,1.2],[-3.1,.85,.75,1.25],[-1.9,1.15,1.05,1.25],[1.5,1.05,.95,1.2],[2.8,.5,.6,1.35]];
  for(const [z,rx,ry,cy] of sections)for(let j=0;j<12;j++){const a=j/12*Math.PI*2;verts.push(Math.sin(a)*rx,cy+Math.cos(a)*ry,z);}
  for(let i=0;i<sections.length-1;i++)for(let j=0;j<12;j++){const a=i*12+j,b=i*12+(j+1)%12,c=b+12,d=a+12;indices.push(a,b,c,a,c,d);}
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));geo.setIndex(indices);geo.computeVertexNormals();mesh(geo,metal,root);
  const cockpit=mesh(new THREE.SphereGeometry(1,20,12),dark,root);cockpit.position.set(0,1.65,-2.3);cockpit.scale.set(.85,.5,.95);
  const tail=mesh(new THREE.CylinderGeometry(.14,.42,6.4,12),metal,root);tail.position.set(0,1.9,5.7);tail.rotation.x=Math.PI/2;
  const fin=mesh(new THREE.BoxGeometry(.12,2.1,1.1),metal,root);fin.position.set(0,2.55,8.8);fin.rotation.x=-.25;
  for(const side of [-1,1]){
    const engine=mesh(new THREE.CylinderGeometry(.34,.36,2.4,12),metal,root);engine.position.set(side*.62,2.35,.3);engine.rotation.x=Math.PI/2;
    const skid=mesh(new THREE.CylinderGeometry(.07,.07,5.2,8),dark,root);skid.position.set(side*1.4,-.05,-.05);skid.rotation.x=Math.PI/2;
    for(const z of [-1.5,1.4]){const strut=mesh(new THREE.CylinderGeometry(.07,.07,1.0,8),dark,root);strut.position.set(side*1.15,.38,z);strut.rotation.z=side*-.5;}
    const door=mesh(new THREE.BoxGeometry(.025,1.25,1.6),dark,root);door.position.set(side*1.06,1.28,.1);
  }
  const mast=mesh(new THREE.CylinderGeometry(.11,.16,1.05,10),dark,root);mast.position.set(0,2.85,.2);
  const rotor=new THREE.Group();rotor.position.set(0,3.4,.2);root.add(rotor);
  for(let i=0;i<4;i++){const blade=mesh(new THREE.BoxGeometry(.25,.04,5),dark,rotor);blade.position.set(Math.sin(i*Math.PI/2)*2.7,0,Math.cos(i*Math.PI/2)*2.7);blade.rotation.y=i*Math.PI/2;}
  const tailRotor=new THREE.Group();tailRotor.position.set(.25,2.5,8.9);root.add(tailRotor);
  for(let i=0;i<2;i++){const b=mesh(new THREE.BoxGeometry(.04,2.3,.12),dark,tailRotor);b.rotation.x=i*Math.PI/2;}
  root.userData={rotor,tailRotor};root.visible=false;root.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});scene.add(root);return root;
}
function clinicSign(){
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=160;const c=canvas.getContext('2d');
  c.fillStyle='#e3e6df';c.fillRect(0,0,512,160);c.fillStyle='#963a32';c.fillRect(28,62,90,30);c.fillRect(58,32,30,90);
  c.fillStyle='#303d35';c.font='bold 54px Microsoft YaHei';c.fillText('医务室',155,102);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const room=G.clinicAccess?.room;
  const p=room?{x:room.x,z:room.doorZ}:{x:-13.6,z:-93.1};
  const y=terrain.ground(p.x,p.z);
  const sign=mesh(new THREE.BoxGeometry(3.1,.98,.09),new THREE.MeshStandardMaterial({map:texture,roughness:.65}));sign.position.set(p.x,y+2.55,p.z-.14);
  const pole=mesh(new THREE.CylinderGeometry(.06,.06,2.5,8),new THREE.MeshStandardMaterial({color:'#5a615a',metalness:.7,roughness:.5}));pole.position.set(p.x,y+1.3,p.z-.05);
  /* Interior fill light so the opened room reads as walkable instead of a black shell. */
  if(room){
    const light=new THREE.PointLight('#eaf3e6',9,13,2);light.position.set(room.x,room.y+2.5,room.z);scene.add(light);
    const lamp=mesh(new THREE.BoxGeometry(1.5,.08,.42),new THREE.MeshStandardMaterial({color:'#dfe7dc',emissive:'#cfe0c8',emissiveIntensity:.9,roughness:.5}));lamp.position.set(room.x,room.y+2.42,room.z);
    for(const side of [-.5,.5]){
      const bed=mesh(new THREE.BoxGeometry(.95,.42,1.9),new THREE.MeshStandardMaterial({color:'#c7cfc4',roughness:.85}));bed.position.set(room.x+side*2.1,room.y+.21,room.z-.9);
      const sheet=mesh(new THREE.BoxGeometry(.9,.07,1.5),new THREE.MeshStandardMaterial({color:'#93a89a',roughness:.95}));sheet.position.set(room.x+side*2.1,room.y+.45,room.z-1.1);
    }
    const crate=mesh(new THREE.BoxGeometry(1.1,.75,.7),new THREE.MeshStandardMaterial({color:'#7c8378',roughness:.9}));crate.position.set(room.x+2.9,room.y+.38,room.z+3.4);
    const cross=mesh(new THREE.BoxGeometry(.8,.24,.12),new THREE.MeshStandardMaterial({color:'#b04a3f',emissive:'#7a2f28',emissiveIntensity:.35,roughness:.7}));cross.position.set(room.x,room.y+2.0,room.z+5.6);
    const cross2=mesh(new THREE.BoxGeometry(.24,.8,.12),cross.material);cross2.position.copy(cross.position);
  }
}
async function load(){
  const progress=(n,text)=>{$('loadbar').style.width=n+'%';$('loadtext').textContent=text;};
  try{
    progress(8,'正在加载校园模型与战区高程…');
    meta=await (await fetch('/assets/campus_meta.json')).json();
    weaponSpecs=await (await fetch('/api/weapons')).json();
    Object.assign(MOVEMENT,await (await fetch('/api/movement')).json());
    await import('/js/terrain.js');await import('/js/clinic.js');
    terrain=globalThis.CampusTerrain.create(meta.terrain.config);
    /* Same clinic access rules the server uses, so the client never predicts an air wall. */
    const clinic=globalThis.CampusClinic.create(terrain,meta.colliders);
    terrain=clinic.terrain;meta.colliders=clinic.colliders;G.clinicAccess=clinic;
    const [gltf,soldier,zombie,zombieArmored,rifle,sky,grass,concrete,asphalt,treeNear,treeFar,plaster,brick,motionLibrary]=await Promise.all([
      gltfLoader.loadAsync('/assets/campus.glb'),gltfLoader.loadAsync('/assets/shooter/three-Soldier.glb'),
      gltfLoader.loadAsync('/assets/shooter/zombie.glb'),gltfLoader.loadAsync('/assets/shooter/zombie-animated.glb'),
      gltfLoader.loadAsync('/assets/shooter/assaultRifle.glb'),
      rgbLoader.loadAsync('/assets/shooter/sky.hdr'),pbr('grass','Grass001'),pbr('concrete','Concrete034'),pbr('asphalt','Asphalt012'),
      gltfLoader.loadAsync('/assets/shooter/tree/tree-game.glb'),gltfLoader.loadAsync('/assets/shooter/tree/tree-far.glb'),pbr('plaster','Plaster001'),pbr('brick','Bricks059'),
      gltfLoader.loadAsync('/assets/shooter/anim-library.glb').catch(()=>null)]);
    progress(72,'建立真实材质、角色与自然日光…');
    sky.mapping=THREE.EquirectangularReflectionMapping;scene.background=sky;
    const pmrem=new THREE.PMREMGenerator(renderer);scene.environment=pmrem.fromEquirectangular(sky).texture;pmrem.dispose();scene.environmentIntensity=.9;
    campus=gltf.scene;
    const done=new Set();campus.traverse(o=>{
      if(!o.isMesh)return;o.receiveShadow=true;o.castShadow=!/grass|paving|water|asphalt|leaf/i.test(o.name);
      if(/(?:leaf|leaf_dark|bark)_near$/.test(o.name)&&meta.trees?.length)o.visible=false;
      const list=Array.isArray(o.material)?o.material:[o.material];
      for(const m of list){
        if(done.has(m))continue;done.add(m);m.emissiveIntensity=0;m.envMapIntensity=.45;
        const name=m.name.toLowerCase();let source=null;
        if(name==='m_grass'||name==='m_grass_wild'||name==='m_turf')source=grass;
        if(name==='m_concrete'||name==='m_paving'||name==='m_paving_warm')source=concrete;
        if(name==='m_asphalt')source=asphalt;
        if(name==='m_brick')source=brick;
        if(name==='m_roof_green')source=grass;
        if(name==='m_roof_grey')source=concrete;
        if(source){const repeat=name==='m_grass_wild'?7:name==='m_grass'||name==='m_turf'?3.5:name==='m_asphalt'?3:name.includes('paving')?2:1;applySurface(m,source,repeat);}
        if(/m_(grass|grass_wild|turf|roof_green|asphalt|concrete|paving|paving_warm|roof_grey|brick|track)$/.test(name)){m.envMapIntensity=.13;m.normalScale.set(.22,.22);drySurface(m);}
        if(/m_(grass|grass_wild|turf|roof_green)$/.test(name))groundVariation(m);
        if(name==='m_glass'){m.color.set('#a7bfc5');m.metalness=0;m.roughness=.35;m.envMapIntensity=.45;}
        if(/m_(facade|panel_red|louver_red|perforated_red|concrete|roof_tile)/.test(name))wallDetail(m,plaster.map,name==='m_facade');
        if(/m_(panel_red|louver_red|perforated_red)/.test(name)){m.color.set('#d7beb0');m.roughness=.8;m.metalness=.05;}
        if(name==='m_track'){m.color.set('#d1b7ac');m.normalMap=asphalt.normalMap.clone();m.normalMap.repeat.set(4,4);m.normalScale.set(.16,.16);m.roughness=.95;}
      }
    });scene.add(campus);if(meta.trees?.length){addTrees(treeNear,0);addTrees(treeFar,1);}
    /* Build every rig unrotated first: retargeting bakes world matrices, so a facing turn
       applied beforehand would leak into the converted bone rotations. */
    soldierTemplate=normalizeModel(soldier,1.8,0);
    soldierTemplate.facing=detectFacing(soldier.scene)??0;
    zombieTemplates=[zombie,zombieArmored].map(g=>{stripRootMotion(g.animations);const t=normalizeModel(g,1.8,0,'idle');t.facing=detectFacing(g.scene)??0;return t;});
    zombieTemplate=zombieTemplates[0];
    /* The Universal Animation Library drives every rig: the built-in soldier, the zombies and
       all imported characters, so death, reload and crouch are real clips instead of poses. */
    try{
      if(!motionLibrary)throw new Error('动作库缺失');
      motionSource=motionLibrary.scene;motionClips=motionLibrary.animations||[];
      const wanted=MOTION_LIBRARY.map(([name])=>motionLibrary.animations.find(clip=>clip.name===name)).filter(Boolean);
      const rename=Object.fromEntries(MOTION_LIBRARY.map(([name,alias])=>[name,alias]));
      const soldierClips=retargetTemplate(soldierTemplate.root,motionSource,wanted,rename);
      if(soldierClips.length)soldierTemplate.animations=soldierClips;
      const deathClips=wanted.filter(clip=>/Death01|Hit_Chest/.test(clip.name));
      for(const template of zombieTemplates){
        const baked=retargetTemplate(template.root,motionSource,deathClips,rename);
        if(baked.length)template.animations=[...(template.animations||[]),...baked];
      }
    }catch(error){console.warn('动作库不可用，继续使用内置动作',error);}
    soldierTemplate.root.rotation.y=soldierTemplate.facing;
    for(const template of zombieTemplates)template.root.rotation.y=template.facing;
    rifleTemplate=normalizedGun(rifle);gunFinish(rifleTemplate);weapon=new THREE.Group();camera.add(weapon);weapon.position.set(.28,-.28,-.68);weapon.visible=false;
    G.weaponModels.rifle=cloneSkeleton(rifleTemplate);weapon.add(G.weaponModels.rifle);
    flashSprite=spawnFlash(1);flashSprite.position.set(0,-.02,-.60);flashSprite.visible=false;weapon.add(flashSprite);
    flashLight=new THREE.PointLight('#ffcf8a',0,11,2);flashLight.position.set(0,0,-.55);weapon.add(flashLight);
    const [shotgun,pistol]=await Promise.all([gltfLoader.loadAsync('/assets/shooter/shotgun.glb'),gltfLoader.loadAsync('/assets/shooter/pistol.glb')]);
    G.weaponModels.shotgun=normalizedGun(shotgun,.92);G.weaponModels.pistol=normalizedGun(pistol,.30);
    gunFinish(G.weaponModels.shotgun);gunFinish(G.weaponModels.pistol);
    for(const key of ['shotgun','pistol']){weapon.add(G.weaponModels[key]);G.weaponModels[key].visible=false;}
    const sleeve=new THREE.MeshStandardMaterial({color:'#40483c',roughness:.87});
    const glove=new THREE.MeshStandardMaterial({color:'#282b26',roughness:.7});
    for(const side of [-1,1]){
      const arm=mesh(new THREE.CylinderGeometry(.065,.09,.38,10),sleeve,weapon);arm.position.set(side*.11,-.12,.26);arm.rotation.x=1.35;
      const hand=mesh(new THREE.SphereGeometry(.07,12,8),glove,weapon);hand.position.set(side*.11,-.06,.06);hand.scale.set(.8,.7,1.3);
    }
    helicopter=createHelicopter();clinicSign();
    await loadAvatars(progress);buildAvatarPicker();
    for(const name of ['shot','reload','empty','impact1','step1','step2']){const a=new Audio('/assets/shooter/'+name+'.ogg');a.preload='auto';G.sounds.set(name,a);}
    progress(100,'战区准备完成');G.ready=true;$('loading').classList.add('hidden');$('lobby').classList.remove('hidden');updateReady();
  }catch(e){console.error(e);$('loadtext').textContent='加载失败：'+e.message;}
}
function updateReady(){$('deploy').disabled=!(G.ready&&G.ws?.readyState===1);}
function connect(){
  const token=sessionStorage.getItem('campus-session');
  const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/?session=${encodeURIComponent(token||'')}`);G.ws=ws;
  ws.onopen=()=>{$('connection').textContent='服务器在线 · 局域网房间';updateReady();};
  ws.onmessage=e=>{
    const data=JSON.parse(e.data);
    if(data.type==='welcome'){G.id=data.id;sessionStorage.setItem('campus-session',data.session);G.address=data.addresses[0]||location.origin;$('lan-address').textContent=G.address;}
    if(data.type==='error'){$('lobby-error').textContent=data.message;notice(data.message);}
    if(data.type==='pong')G.ping=Math.round(performance.now()-data.stamp);
    if(data.type==='joined'){
      if(data.team)G.team=data.team;if(data.resumed)G.mode=data.mode;
      G.playing=true;G.resultShown=false;G.predicted=null;G.resumeWeapon=!!data.resumed;G.fire=false;G.keys={};G.resetTouch?.();$('pause').classList.add('hidden');$('lobby-error').textContent='';$('lobby').classList.add('hidden');$('hud').classList.remove('hidden');$('result').classList.add('hidden');
      if(G.touch)$('touch-controls').classList.remove('hidden');
      G.setSpawnView=true;G.pitch=-.05;requestLock();
    }
    if(data.type==='state')receive(data);
  };
  ws.onclose=()=>{
    G.fire=false;G.aim=false;G.keys={};G.resetTouch?.();$('touch-controls').classList.add('hidden');$('pause').classList.add('hidden');
    G.playing=false;$('hud').classList.add('hidden');$('lobby').classList.remove('hidden');$('connection').textContent='连接中断';$('lobby-error').textContent='服务器连接中断，正在重新连接…';
    updateReady();setTimeout(connect,1500);
  };
  ws.onerror=()=>{$('connection').textContent='无法连接服务器';};
}
function send(data){if(G.ws?.readyState===1)G.ws.send(JSON.stringify(data));}
function sound(name,gain=1){const base=G.sounds.get(name);if(!base||G.volume<=0)return;const a=base.cloneNode();a.volume=clamp(G.volume*gain,0,1);a.play().catch(()=>{});}
function notice(text){$('notice').textContent=text;G.noticeUntil=G.clock+3;}
function spawnVisual(a){
  let source;
  /* The server owns the grade, so the model on screen always matches the health pool behind it. */
  if(a.kind==='zombie')source=zombieTemplates[a.variant?1:0]||zombieTemplate;
  else{
    const index=avatarIndexFor(a);
    if(index>=0)source=avatarTemplates[index];
  }
  if(!source)source=soldierTemplate;
  if(!source)return null;
  const model=cloneSkeleton(source.root),root=new THREE.Group();root.rotation.order='YXZ';
  root.add(model);root.position.set(a.x,a.y,a.z);actorsRoot.add(root);
  const mixer=new THREE.AnimationMixer(model),actions={};
  for(const clip of source.animations||[])actions[clip.name.toLowerCase()]=mixer.clipAction(clip);
  const clip=chooseAction(actions);
  /* Death and reload are one-shots: looping a fall looks broken, and a reload that restarts
     mid-way reads as the character racking the weapon twice. */
  for(const name of ['death','hit']){
    if(clip[name]){clip[name].setLoop(THREE.LoopOnce,1);clip[name].clampWhenFinished=true;}
  }
  if(clip.reload){clip.reload.setLoop(THREE.LoopOnce,1);clip.reload.clampWhenFinished=true;clip.reload.setEffectiveTimeScale(Math.max(.6,clip.reload.getClip().duration/2.1));}
  const visual={root,model,mixer,actions,clip,current:null,reloading:false,deathAt:-1,deathPlayed:false,
    fall:0,position:new THREE.Vector3(a.x,a.y,a.z),yaw:a.yaw,kind:a.kind,isAvatar:a.kind!=='zombie'&&avatarTemplates.includes(source),avatarLabel:source&&source.label};
  if(clip.idle)visual.current='idle';
  const opening=clip.idle||Object.values(actions)[0];
  if(opening){
    /* Stagger the phase and cadence: a whole squad marching in perfect lockstep is the
       single biggest reason crowd animation reads as mechanical. */
    opening.reset();opening.time=Math.random()*Math.max(.001,opening.getClip().duration);
    opening.setEffectiveTimeScale(.92+Math.random()*.16);opening.play();
  }
  visual.cadence=.92+Math.random()*.16;
  const legs=[];model.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
  if(!visual.isAvatar)tintTeam(root,a.team);
  if(a.kind!=='zombie'){
    const gun=cloneSkeleton(rifleTemplate);gun.scale.setScalar(.75);gun.position.set(.22,1.2,-.30);gun.rotation.x=-.05;root.add(gun);
    visual.gun=gun;visual.gunRest=gun.rotation.x;
    const patch=mesh(new THREE.BoxGeometry(.035,.11,.13),new THREE.MeshStandardMaterial({color:a.team==='blue'?'#47647b':'#805149',roughness:1}),root);patch.position.set(-.29,1.43,0);
  }
  const marker=markerSprite(a);root.add(marker);visual.marker=marker;
  visual.skinned=!!skinnedOf(model);visual.modelBaseY=model.position.y;
  G.actors.set(a.id,visual);return visual;
}
function playClip(v,name,speed=1){
  const next=v.clip[name];
  if(!next||v.current===name)return;
  for(const action of Object.values(v.clip)){
    if(!action||action===next||!action.isRunning())continue;
    if(action.getEffectiveWeight()>.001)action.fadeOut(.18);
  }
  next.reset();next.setEffectiveTimeScale(speed);next.setEffectiveWeight(1);next.play();
  v.current=name;
}
function receive(state){
  if(!G.ready||!G.playing)return;
  const old=G.state;G.state=state;
  if(G.resumeWeapon&&state.player){G.weapon=state.player.weapon;G.resumeWeapon=false;}
  const own=state.actors.find(a=>a.id===G.id);
  if(own&&(G.setSpawnView||old?.player&&!old.player.alive&&state.player?.alive)){
    const target=state.spawnAreas?.[G.team==='blue'?'red':'blue']||state.landing;
    G.yaw=Math.atan2(-(target.x-own.x),-(target.z-own.z));G.setSpawnView=false;
  }
  if(own){
    if(!G.predicted||!old?.player?.alive&&state.player?.alive||Math.hypot(G.predicted.x-own.x,G.predicted.z-own.z)>4)G.predicted={x:own.x,y:own.y,z:own.z,vy:0};
    else{G.predicted.x+=(own.x-G.predicted.x)*.28;G.predicted.z+=(own.z-G.predicted.z)*.28;if(Math.abs(G.predicted.y-own.y)>1.7)G.predicted.y=own.y;}
  }
  const keep=new Set();
  for(const a of state.actors){keep.add(a.id);const v=G.actors.get(a.id)||spawnVisual(a);if(!v)continue;v.target=a;v.position.set(a.x,a.y,a.z);}
  for(const [id,v]of G.actors)if(!keep.has(id)){actorsRoot.remove(v.root);G.actors.delete(id);}
  for(const e of state.events){
    if(e.type==='shot'){
      addTracer(e);
      if(e.id===G.id){if(e.hit)G.hitUntil=G.clock+.18;addBillboard(e.tx,e.ty,e.tz,e.hit?.15:.09,.1,e.hit?'#e2a08e':'#c8c2ae',.6);}
      else if(G.predicted){
        const d=Math.hypot(e.x-G.predicted.x,e.z-G.predicted.z);
        if(d<90)addRemoteShot(e);
        if(d<55)sound('shot',.14*(1-d/65));
      }
    }
    if(e.type==='kill'){
      const row=document.createElement('div');row.textContent=`${e.killer}  ›  ${e.victim}`;row.style.borderColor=e.team==='blue'?'#81aac5':'#c2857f';$('killfeed').prepend(row);
      while($('killfeed').children.length>5)$('killfeed').lastElementChild.remove();setTimeout(()=>row.remove(),6000);
      if(e.killerId===G.id)notice('目标击倒');
    }
    if(e.type==='helicopter')notice('直升机正在接近 · 前往操场撤离区');
    if(e.type==='reload'&&e.id===G.id)sound('reload',.6);
  }
  if(old?.player&&state.player&&state.player.hp<old.player.hp){G.damageUntil=G.clock+.55;}
  updateHUD();
  if(state.player?.extracted)showResult('撤离完成','你已登上直升机，成功离开战区。','PERSONAL EXTRACTION');
  else if(state.phase==='finished')showResult(state.winner===state.player?.team?'胜利':'本局失利',`${state.winner==='blue'?'蓝队':'红队'}率先获得 150 次击杀。`,'MATCH REPORT');
  else if(state.mode==='survival'&&state.player&&!state.player.alive)showResult('行动失败','你已阵亡。','ACTION REPORT');
}
function addTracer(e){
  const geometry=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(e.x,e.y,e.z),new THREE.Vector3(e.tx,e.ty,e.tz)]);
  const line=new THREE.Line(geometry,new THREE.LineBasicMaterial({color:'#ddd3a3',transparent:true,opacity:.42}));scene.add(line);G.effects.push({object:line,until:G.clock+.07});
}
/* A soft round dot drawn in code. Invented rather than sampled, so the falloff is guaranteed
   to reach zero well inside the border and no rectangle can ever show up. */
function softDotTexture(){
  const size=64,canvas=document.createElement('canvas');canvas.width=canvas.height=size;
  const c=canvas.getContext('2d');
  const gradient=c.createRadialGradient(size/2,size/2,0,size/2,size/2,size/2);
  gradient.addColorStop(0,'rgba(255,255,255,1)');
  gradient.addColorStop(.3,'rgba(255,255,255,.42)');
  gradient.addColorStop(.55,'rgba(255,255,255,.10)');
  gradient.addColorStop(.72,'rgba(255,255,255,0)');
  gradient.addColorStop(1,'rgba(255,255,255,0)');
  c.fillStyle=gradient;c.fillRect(0,0,size,size);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  /* No mipmaps: at lower mip levels the radial ramp averages towards a flat value and the
     sprite starts showing its square edge, which is exactly the artefact being chased here. */
  texture.generateMipmaps=false;
  texture.minFilter=THREE.LinearFilter;
  texture.magFilter=THREE.LinearFilter;
  return texture;
}
const dotTexture=softDotTexture();
/* Effects are objects with a lifetime. An optional update(object, age, t) lets a burst animate
   over its life instead of being switched on and off. */
function addEffect(object,life,update=null){
  scene.add(object);
  G.effects.push({object,until:G.clock+life,born:G.clock,life,update});
  return object;
}
/* The puff that keeps drifting after the flash is gone. Gun smoke is the cue that sells the
   shot far more than the flash itself. */
/* Brass leaving the ejection port. It is the small secondary motion that makes a burst feel
   like it is happening to a machine rather than to a picture. */
function addCasing(origin,dir){
  /* Brass, not dark metal: a highly metallic box reflected almost nothing against the bright
     sky and read on screen as a black square drifting through the air. */
  const shell=new THREE.Mesh(new THREE.BoxGeometry(.010,.010,.026),
    new THREE.MeshStandardMaterial({color:'#e0bb63',metalness:.25,roughness:.45,
      emissive:'#4a3608',emissiveIntensity:.5}));
  shell.position.copy(origin);
  const right=new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion);
  const up=new THREE.Vector3(0,1,0).applyQuaternion(camera.quaternion);
  const velocity=right.multiplyScalar(.7+Math.random()*.4)
    .addScaledVector(up,.15+Math.random()*.25)
    .addScaledVector(dir,.25);
  const spin=new THREE.Vector3((Math.random()-.5)*22,(Math.random()-.5)*22,(Math.random()-.5)*22);
  return addEffect(shell,.55,(object,age)=>{
    const step=Math.min(.05,age-(object.userData.lastAge||0));
    object.userData.lastAge=age;
    velocity.y-=11*step;
    object.position.addScaledVector(velocity,step);
    object.rotation.x+=spin.x*step;object.rotation.y+=spin.y*step;object.rotation.z+=spin.z*step;
  });
}
/* Everything that happens at the muzzle the instant the shot is fired. The flash itself is
   immediate; the impact puff still arrives with the authoritative server event. */
function muzzleEmit(){
  if(!flashSprite)return;
  camera.updateMatrixWorld(true);
  const origin=flashSprite.getWorldPosition(new THREE.Vector3());
  const dir=new THREE.Vector3(0,0,-1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
  addSmokePuff(origin.x,origin.y,origin.z,dir.x,dir.y,dir.z,.45);
  addCasing(origin,dir);
}
function addSmokePuff(x,y,z,ux=0,uy=0,uz=-1,scale=.5){
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTexture,color:'#b9bcb4',transparent:true,opacity:.2,depthWrite:false}));
  /* Start the puff clear of the camera. A gun-smoke sprite spawned at the muzzle and then
     allowed to grow sat right in front of the lens as a big washed-out quad - the very artefact
     the flash itself was rebuilt to avoid. */
  const ox=x+ux*.55,oy=y+uy*.55-.06,oz=z+uz*.55;
  sprite.position.set(ox,oy,oz);
  sprite.scale.setScalar(scale*.22);
  const spread=.06+.08*Math.random();
  const vx=ux*.8+(Math.random()-.5)*spread,vy=uy*.8+.12+Math.random()*spread,vz=uz*.8+(Math.random()-.5)*spread;
  return addEffect(sprite,SMOKE_LIFE,(object,age,t)=>{
    object.position.set(ox+vx*age,oy+vy*age,oz+vz*age);
    object.scale.setScalar(scale*(.22+t*.5));
    object.material.opacity=.2*Math.pow(1-t,1.5);
    object.material.rotation+=.015;
  });
}
function addBillboard(x,y,z,scale,life,color,opacity){
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTexture,color,transparent:true,opacity,blending:THREE.AdditiveBlending,depthWrite:false}));
  sprite.position.set(x,y,z);sprite.scale.setScalar(scale);
  scene.add(sprite);G.effects.push({object:sprite,until:G.clock+life});
}
/* A real flash volume on somebody else's rifle, plus the impact puff where the round landed. */
function addRemoteShot(e){
  const dx=e.tx-e.x,dy=e.ty-e.y,dz=e.tz-e.z,length=Math.hypot(dx,dy,dz)||1;
  const ux=dx/length,uy=dy/length,uz=dz/length;
  const mx=e.x+ux*.62,my=e.y+uy*.62-.05,mz=e.z+uz*.62;
  const flash=spawnFlash(.85);
  flash.position.set(mx,my,mz);
  flash.lookAt(e.tx,e.ty,e.tz);
  addEffect(flash,FLASH_LIFE,(object,age)=>animateFlash(object,age,FLASH_LIFE));
  addSmokePuff(mx,my,mz,ux,uy,uz,.5);
  addBillboard(e.tx,e.ty,e.tz,e.hit?.3:.2,.16,e.hit?'#e2a08e':'#c8c2ae',e.hit?.85:.5);
}
function showResult(title,text,label){
  if(G.resultShown)return;G.resultShown=true;$('result-title').textContent=title;$('result-detail').textContent=text;$('result-label').textContent=label;
  const p=G.state.player;$('result-stats').textContent=`击杀 ${p.kills}　 /　阵亡 ${p.deaths}`;$('result').classList.remove('hidden');$('touch-controls').classList.add('hidden');document.exitPointerLock();G.fire=false;G.keys={};
}
function updateHUD(){
  const s=G.state,p=s?.player;if(!p)return;
  $('hp').textContent=Math.ceil(p.hp);$('healthbar').style.width=p.hp+'%';$('ammo').textContent=p.ammo;$('reserve').textContent=p.reserve;
  $('weapon-name').textContent=(weaponSpecs[p.weapon]?.name||'突击步枪')+' / '+(p.weapon==='rifle'?'全自动':'单发');
  for(const [key,model]of Object.entries(G.weaponModels))model.visible=key===p.weapon;
  $('player-name').textContent=$('callsign').value;$('blue-score').textContent=s.mode==='tdm'?s.score.blue:s.counts.blue;
  $('red-score').textContent=s.mode==='tdm'?s.score.red:s.counts.zombies;
  $('blue-label').textContent=s.mode==='tdm'?'蓝队':'队员';$('red-label').textContent=s.mode==='tdm'?'红队':'丧尸';
  $('mode-title').textContent=s.mode==='tdm'?'团队竞技':'丧尸生存';
  const time=s.mode==='tdm'?s.time:Math.max(0,600-s.time);$('round-clock').textContent=formatTime(time)+(s.mode==='tdm'?' / 150':'');
  $('objective').textContent=s.mode==='tdm'?'消灭敌方队员':s.helicopter?(s.helicopter.arrived?'直升机已就位 · 前往操场登机':'直升机正在接近撤离区'):'坚守阵地，等待直升机抵达';
  $('reload-status').textContent=p.reloading>0?`换弹中 ${p.reloading.toFixed(1)}s`:'';
  if(s.mode==='tdm'&&!p.alive)$('notice').textContent=`阵亡 · ${Math.ceil(p.respawn)} 秒后重返战场`;
  drawRadar();
}
function formatTime(t){return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`;}
function validMove(x,z,ignoreBodies){
  if(!terrain.inside(x,-z))return false;const y=terrain.ground(x,z);
  for(const c of meta.colliders){
    if(c.py-c.h/2>y+1.75||c.py+c.h/2<y+.3)continue;
    const cs=Math.cos(c.rot),sn=Math.sin(c.rot),dx=x-c.px,dz=z-c.pz;
    if(Math.abs(dx*cs+dz*sn)<c.w/2+.38&&Math.abs(-dx*sn+dz*cs)<c.d/2+.38)return false;
  }
  /* Other people are solid as well. Without this the client predicts walking straight through
     them and the authoritative push-out arrives as a rubber-band. */
  if(!ignoreBodies){
    const mine=G.state?.you;
    for(const [id,v]of G.actors){
      const a=v.target;
      if(!a||!a.alive||a.extracted||id===mine)continue;
      if(Math.abs((a.y||0)-(G.predicted?.y||0))>1.7)continue;
      if(Math.hypot(a.x-x,a.z-z)<.84)return false;
    }
  }
  return true;
}
function predict(dt){
  const a=G.predicted;if(!a||!G.state?.player?.alive||G.state.player.extracted||!controlsActive())return;
  const f=G.touch?G.touchMove.forward:(G.keys.KeyW?1:0)-(G.keys.KeyS?1:0),s=G.touch?G.touchMove.side:(G.keys.KeyD?1:0)-(G.keys.KeyA?1:0);
  const crouch=G.touch?G.crouch:G.keys.ControlLeft;
  const n=Math.max(1,Math.hypot(f,s));
  const speed=speedFor({kind:'soldier',crouch,sprint:!!(G.keys.ShiftLeft||G.touchMove.sprint),aim:G.aim,fire:G.fire,elapsed:0});
  const dx=(-Math.sin(G.yaw)*f+Math.cos(G.yaw)*s)/n*speed*dt,dz=(-Math.cos(G.yaw)*f-Math.sin(G.yaw)*s)/n*speed*dt;
  if(validMove(a.x+dx,a.z))a.x+=dx;if(validMove(a.x,a.z+dz))a.z+=dz;
  const floor=terrain.ground(a.x,a.z);if((G.keys.Space||G.clock<G.pulses.Space)&&!crouch&&Math.abs(a.y-floor)<.1)a.vy=MOVEMENT.JUMP;
  a.vy-=MOVEMENT.GRAVITY*dt;a.y+=a.vy*dt;if(a.y<floor||a.y-floor<.36&&a.vy<=0){a.y=floor;a.vy=0;}
}
function drawRadar(){
  const s=G.state,p=G.predicted;if(!s||!p)return;const c=$('radar').getContext('2d'),n=360,scale=2.2;
  c.clearRect(0,0,n,n);c.fillStyle='#12191ad0';c.fillRect(0,0,n,n);
  c.strokeStyle='#cad0c327';c.lineWidth=1;
  for(let i=0;i<=n;i+=45){c.beginPath();c.moveTo(i,0);c.lineTo(i,n);c.moveTo(0,i);c.lineTo(n,i);c.stroke();}
  c.save();c.translate(n/2,n/2);
  c.strokeStyle='#bbbba970';
  for(const b of meta.colliders){const x=(b.px-p.x)*scale,z=(b.pz-p.z)*scale;if(Math.abs(x)>300||Math.abs(z)>300)continue;c.save();c.translate(x,z);c.rotate(b.rot);c.strokeRect(-b.w/2*scale,-b.d/2*scale,b.w*scale,b.d*scale);c.restore();}
  for(const a of s.actors){if(!a.alive||a.extracted||a.id===G.id)continue;const d=Math.hypot(a.x-p.x,a.z-p.z);
    if(a.team!==s.player.team&&d>55)continue;c.fillStyle=a.team===s.player.team?'#81aac5':a.kind==='zombie'?'#bb9f79':'#c2857f';c.fillRect((a.x-p.x)*scale-2,(a.z-p.z)*scale-2,4,4);}
  const clinic=s.clinic;c.fillStyle='#a1c69c';c.fillRect((clinic.x-p.x)*scale-3,(clinic.z-p.z)*scale-3,6,6);
  if(s.helicopter){c.strokeStyle='#c5bc96';c.strokeRect((s.landing.x-p.x)*scale-7,(s.landing.z-p.z)*scale-7,14,14);}
  c.rotate(-G.yaw);c.fillStyle='#eee9dc';c.beginPath();c.moveTo(0,-7);c.lineTo(5,6);c.lineTo(-5,6);c.fill();c.restore();
  c.fillStyle='#ddd9c7';c.font='17px Bahnschrift';c.fillText('N',n/2-6,22);
}
function animateActors(dt){
  for(const [id,v]of G.actors){const a=v.target;if(!a)continue;
    const d=G.predicted?Math.hypot(a.x-G.predicted.x,a.z-G.predicted.z):0;
    const near=d<190;
    if(!a.alive&&v.deathAt<0)v.deathAt=G.clock;
    if(a.alive)v.deathAt=-1;
    /* A corpse stays for a few seconds so kills are readable, but it must never be mistaken for
       a live target: it is dimmed and desaturated so shooting one is obviously wasted. Zombies
       in particular used to have no death clip at all, so a body killed by a team-mate simply
       stood there looking alive. */
    const corpse=!a.alive&&G.clock-v.deathAt<6;
    if(v.root.visible===true&&!a.alive){
      const k=v.corpseTint==null?1:v.corpseTint;
      v.corpseTint=Math.max(0,k-dt*1.6);
      v.root.traverse(o=>{
        if(!o.isMesh||!o.material)return;
        const materials=Array.isArray(o.material)?o.material:[o.material];
        for(const m of materials){
          if(m.userData.liveColor===undefined&&m.color)m.userData.liveColor=m.color.getHex();
          if(m.userData.liveColor!==undefined)m.color.setHex(m.userData.liveColor).multiplyScalar(.35+.65*v.corpseTint);
        }
      });
    }
    /* 30v30 across a whole campus: anything past 150m is a few pixels, so it is not worth
       its draw calls. Corpses and the local player are always kept. */
    v.root.visible=!a.extracted&&(a.alive||corpse)&&(id!==G.id||G.third)&&near&&(d<150||!a.alive);
    if(!v.root.visible)continue;
    v.model.scale.y=THREE.MathUtils.lerp(v.model.scale.y,a.crouch?.72:1,dt*10);
    v.root.position.lerp(v.position,1-Math.exp(-13*dt));
    let delta=((a.yaw-v.root.rotation.y+Math.PI)%(Math.PI*2))-Math.PI;if(delta<-Math.PI)delta+=Math.PI*2;
    if(a.alive)v.root.rotation.y+=delta*(1-Math.exp(-15*dt));
    /* ---- death: play the authored clip when the rig has one, otherwise fall over ---- */
    const targetFall=a.alive?0:1;
    if(Math.abs(v.fall-targetFall)>.001){
      v.fall+=(targetFall-v.fall)*Math.min(1,dt*(a.alive?5:3.2));
      v.root.rotation.x=v.fall*Math.PI*.46;
      v.root.position.y=v.position.y-Math.sin(Math.min(1,v.fall)*Math.PI)*.12;
    }
    if(!a.alive){
      if(!v.deathPlayed){v.deathPlayed=true;if(v.clip.death)playClip(v,'death');}
      v.mixer.update(dt);
      if(v.marker)v.marker.visible=false;
      continue;
    }
    /* ---- locomotion: cadence follows the actor's real ground speed ---- */
    const dx=v.position.x-(v.sampleX??v.position.x),dz=v.position.z-(v.sampleZ??v.position.z);
    const instant=Math.hypot(dx,dz)/Math.max(dt,1e-3);
    const previousSpeed=Number.isFinite(v.speed)?v.speed:instant;
    v.speed=previousSpeed+(instant-previousSpeed)*Math.min(1,dt*5);
    v.sampleX=v.position.x;v.sampleZ=v.position.z;
    if(!v.skinned){ // rigless models get a small hop so they do not slide like statues
      const hop=a.moving?Math.abs(Math.sin(G.clock*5+v.cadence*9))*.14:0;
      v.model.position.y=v.modelBaseY+hop;
      v.model.rotation.z=a.moving?Math.sin(G.clock*5+v.cadence*9)*.05:0;
    }
    const reloading=!!a.reloading;
    const wanted=reloading&&v.clip.reload?'reload':!a.moving?(a.crouch?'crouch':'idle'):a.sprinting?'sprint':'walk';
    playClip(v,wanted,1);
    const current=v.clip[v.current];
    if(current&&a.moving&&!reloading){
      const nominal=a.kind==='zombie'?MOVEMENT.ZOMBIE_WALK:(v.current==='sprint'?MOVEMENT.SPRINT:MOVEMENT.WALK);
      const rate=clamp(v.speed/Math.max(1,nominal),.6,1.7)*(v.cadence||1);
      if(Number.isFinite(rate))current.setEffectiveTimeScale(rate);
    }
    v.reloading=reloading;
    if(v.gun){
      /* Reloading raises the weapon toward the magazine well; it must not press it down. */
      v.gunDip=(v.gunDip??0)+((reloading?1:0)-(v.gunDip??0))*Math.min(1,dt*7);
      v.gun.rotation.x=v.gunRest+v.gunDip*.55;v.gun.rotation.z=-v.gunDip*.4;v.gun.position.y=1.2+v.gunDip*.07;
      v.gun.position.z=-.30-v.gunDip*.05;
    }
    /* ---- firing: brief attack pose when a zombie lunges ---- */
    if(a.kind==='zombie'&&v.clip.attack&&a.shot!==v.lastShot){
      v.lastShot=a.shot;playClip(v,'attack');v.attackUntil=G.clock+.7;
    }
    if(v.attackUntil&&G.clock>v.attackUntil){v.attackUntil=0;playClip(v,wanted);}
    /* Only the hazmat elite gets an overhead marker: the plain zombies are the common enemy and
       an arrow over every one of them was pure clutter. */
    if(v.marker){const elite=a.kind==='zombie'&&a.variant===1;v.marker.visible=a.team==='blue'?d<78:(elite?d<110:d<70);}
    /* Crowd shadows are only worth their draw calls close to the camera. */
    const wantShadow=d<48&&G.quality!=='low'&&a.kind!=='zombie'||d<70&&a.kind==='zombie';
    if(v.shadowOn!==wantShadow){v.shadowOn=wantShadow;v.root.traverse(o=>{if(o.isMesh)o.castShadow=wantShadow;});}
    if(d<170)v.mixer.update(dt);   }   /* Footsteps for everyone else. There were none at all before, which is why the battlefield      felt silent around you. Budgeted so a 30-a-side match cannot turn into a wall of noise:      the nearest actors win, and only about six steps a second are ever played. */   const due=[];   for(const [id,v] of G.actors){     const a=v.target;     if(!a||!a.alive||a.extracted||!a.moving||id===G.id||!v.root.visible)continue;     const d=G.predicted?Math.hypot(a.x-G.predicted.x,a.z-G.predicted.z):999;     if(d>24||(v.speed||0)<.6)continue;     if(G.clock<(v.stepAt||0))continue;     const stride=a.sprinting?2.3:1.65;     v.stepAt=G.clock+clamp(stride/Math.max(.9,v.speed),.3,.8);     due.push({flip:v.stepFlip,d});     v.stepFlip=!v.stepFlip;   }   due.sort((x,y)=>x.d-y.d);   G.stepBudget=Math.min(3,(G.stepBudget||0)+dt*6);   for(const step of due){     if(G.stepBudget<1)break;     const gain=.55*Math.pow(1-step.d/24,1.5);     if(gain<=.05)continue;     G.stepBudget-=1;     sound(step.flip?'step1':'step2',gain);   } }
function frame(now){
  const frameStart=performance.now();
  requestAnimationFrame(frame);const dt=Math.min(.05,(now-G.lastFrame)/1000);G.lastFrame=now;G.clock+=dt;G.frames++;
  if(G.clock-(G.fpsAt||0)>1){G.fps=G.frames;G.frames=0;G.fpsAt=G.clock;}
  if(G.ready){
    if(G.playing&&G.predicted&&!G.preview){
      predict(dt);const p=G.predicted,bob=(G.keys.KeyW||G.keys.KeyS||G.keys.KeyA||G.keys.KeyD)&&G.locked?Math.sin(G.clock*10)*.018:0;
      const head=(G.touch?G.crouch:G.keys.ControlLeft)?1.17:1.62;
      camera.position.set(p.x,p.y+head+bob,p.z);camera.rotation.set(G.pitch,G.yaw,0,'YXZ');
      if(G.third){camera.position.x+=Math.sin(G.yaw)*4;camera.position.z+=Math.cos(G.yaw)*4;camera.position.y+=1.1;}
      camera.fov=THREE.MathUtils.lerp(camera.fov,G.aim?48:68,dt*12);camera.updateProjectionMatrix();
      weapon.visible=!G.third&&G.state?.player?.alive&&!G.state.player.extracted;
      const walking=G.touch?Math.hypot(G.touchMove.forward,G.touchMove.side)>.2:G.keys.KeyW||G.keys.KeyS||G.keys.KeyA||G.keys.KeyD;
      if(walking&&controlsActive()&&Math.abs(p.y-terrain.ground(p.x,p.z))<.1&&G.clock-(G.stepAt||0)>.43){sound(G.frames%2?'step1':'step2',.5);G.stepAt=G.clock;}
      const baseX=G.aim?.035:.28,baseY=G.aim?-.24:-.28;G.recoil=Math.max(0,G.recoil-dt*4);
      /* Reload is a real pose change, not just a caption. */
      const reloading=(G.state?.player?.reloading||0)>0;
      G.reloadAnim+=(Number(reloading)-G.reloadAnim)*Math.min(1,dt*7);
      const gunMoving=G.touch?Math.hypot(G.touchMove.forward,G.touchMove.side)>.2:(G.keys.KeyW||G.keys.KeyS||G.keys.KeyA||G.keys.KeyD);
      const sprinting=gunMoving&&!G.aim&&(G.keys.ShiftLeft||G.touchMove.sprint);
      const sway=gunMoving&&!G.aim?Math.sin(G.clock*(sprinting?11:8))*.012:0;
      /* Reloading lifts the weapon and rolls it inboard toward the magazine well. */
      weapon.position.set(baseX+sway,baseY-bob-G.recoil*.025+G.reloadAnim*.05,-.68+G.recoil*.08-G.reloadAnim*.04);
      weapon.rotation.set(G.recoil*.04+G.reloadAnim*.5,0,-G.reloadAnim*.4);
      if(G.fire&&G.state?.player?.alive&&!G.state.player.extracted&&controlsActive()&&G.clock-G.lastShot>(weaponSpecs[G.state?.player?.weapon]?.interval||.12)&&G.state?.player?.ammo>0&&!reloading){
        G.lastShot=G.clock;G.recoil=1;G.muzzleStart=G.clock;G.muzzleShots=(G.muzzleShots||0)+1;sound('shot',.65);
        muzzleEmit();
      }
      if(flashSprite){
        const age=G.flashFreeze!=null?G.flashFreeze:G.clock-(G.muzzleStart??-99);
        const lit=age>=0&&age<FLASH_LIFE;
        if(lit&&!flashSprite.visible){
          flashSprite.rotation.set((Math.random()-.5)*.5,0,Math.random()*Math.PI*2);
          flashSprite.userData.baseScale=.82+Math.random()*.42;
          flashSprite.userData.skin=(flashSprite.userData.skin??0)===0?0:1;
        }
        flashSprite.visible=lit;
        if(lit){
          animateFlash(flashSprite,age,FLASH_LIFE);
          /* Fast attack, fast decay, slight flicker - a constant intensity reads as a lamp. */
          flashLight.intensity=4.6*Math.pow(1-age/FLASH_LIFE,2)*(.78+Math.random()*.4);
        } else flashLight.intensity=0;
      }
      const s=G.state;
      if(s){
        const medical=Math.hypot(p.x-s.clinic.x,p.z-s.clinic.z)<s.clinic.radius;$('medical-status').textContent=medical?'医务室 · 恢复与补给中':'';
        const extraction=s.helicopter?.arrived&&Math.hypot(p.x-s.landing.x,p.z-s.landing.z)<7&&s.player.alive;
        $('interact').style.display=extraction?'block':'none';$('interact').textContent='按 F 登上直升机';
        if(G.touch){$('interact').style.display='none';$('touch-extract').classList.toggle('hidden',!extraction);}
      }
      if(G.clock-(G.shadowAt||0)>.35){sun.position.set(p.x-130,p.y+260,p.z-90);sun.target.position.set(p.x,p.y,p.z);G.shadowAt=G.clock;}
    }else{
      weapon.visible=false;
      camera.position.copy(G.preview?.position||new THREE.Vector3(-160,75,-145));camera.lookAt(G.preview?.target||new THREE.Vector3(-25,5,-15));
      if(showcaseMixer)showcaseMixer.update(dt);
    }
    const tRad=performance.now();drawRadar();G.profile.radar=+((G.profile.radar||0)+performance.now()-tRad).toFixed(2);
    const tA=performance.now();animateActors(dt);G.profile.actors=+((G.profile.actors||0)+performance.now()-tA).toFixed(2);
    if(helicopter&&G.state?.helicopter){
      const h=G.state.helicopter,p=G.state.landing,t=clamp(h.t/16,0,1),ease=1-(1-t)**2;
      helicopter.visible=true;helicopter.position.set(p.x+110*(1-ease),p.y+1.3+100*(1-ease),p.z-145*(1-ease));
      helicopter.rotation.y=.3;helicopter.userData.rotor.rotation.y+=dt*45;helicopter.userData.tailRotor.rotation.x+=dt*55;
    }else if(helicopter)helicopter.visible=false;
    for(let i=G.effects.length-1;i>=0;i--){
      const e=G.effects[i];
      if(e.update&&G.clock<=e.until)e.update(e.object,G.clock-e.born,Math.min(1,(G.clock-e.born)/e.life));
      if(G.clock<=e.until)continue;
      scene.remove(e.object);
      if(e.object.material&&e.object.material.dispose)e.object.material.dispose();
      e.object.traverse(o=>{
        /* Sprites share one geometry module-wide; disposing it would break every sprite. */
        if(!o.isMesh)return;
        if(o.geometry&&o.geometry!==FLASH_GEOMETRY.star&&o.geometry!==FLASH_GEOMETRY.cone&&o.geometry!==FLASH_GEOMETRY.core&&o.geometry!==FLASH_GEOMETRY.spark)o.geometry.dispose();
        if(o.material&&o.material.dispose)o.material.dispose();
      });
      G.effects.splice(i,1);
    }
    const tR=performance.now();updateTrees();renderer.info.reset();composer.render();G.profile.render=+((G.profile.render||0)+performance.now()-tR).toFixed(2);
    G.lastCalls=renderer.info.render.calls;G.lastTriangles=renderer.info.render.triangles;
  }
  const tH=performance.now();$('hitmarker').style.opacity=G.clock<G.hitUntil?1:0;$('damage-overlay').style.opacity=clamp((G.damageUntil-G.clock)*1.4,0,.75);
  $('reticle').style.setProperty('--gap',(G.aim?4:7)+(G.recoil*4)+'px');
  if(G.clock>G.noticeUntil&&G.state?.player?.alive)$('notice').textContent='';
  G.profile.hud=+((G.profile.hud||0)+performance.now()-tH).toFixed(2);
  $('telemetry').textContent=`${G.ping} ms · ${G.fps} FPS`;
  /* Frame-time distribution, not just an average: stutter lives in the tail, and an average
     hides it completely. `cost` is the javascript side of the frame, `dt` the whole frame. */
  G.frameTimes.push({dt:+(dt*1000).toFixed(2),cost:+(performance.now()-frameStart).toFixed(2),...G.profile});
  G.profile={};
  if(G.frameTimes.length>900)G.frameTimes.splice(0,G.frameTimes.length-900);
}
function requestLock(){if(G.touch)return;const promise=$('scene').requestPointerLock?.();promise?.catch?.(()=>{});}
function inputs(){
  if(!G.playing||!G.state?.player)return;
  const active=controlsActive();
  send({type:'input',forward:active?(G.touch?G.touchMove.forward:(G.keys.KeyW?1:0)-(G.keys.KeyS?1:0)):0,side:active?(G.touch?G.touchMove.side:(G.keys.KeyD?1:0)-(G.keys.KeyA?1:0)):0,
    yaw:G.yaw,pitch:G.pitch,sprint:active&&!!(G.keys.ShiftLeft||G.touchMove.sprint),fire:active&&G.fire,aim:G.aim,jump:active&&(!!G.keys.Space||G.clock<G.pulses.Space),
    reload:active&&(!!G.keys.KeyR||G.clock<G.pulses.KeyR),extract:active&&(!!G.keys.KeyF||G.clock<G.extractUntil||G.clock<G.pulses.KeyF),weapon:G.weapon,crouch:active&&(G.touch?G.crouch:!!G.keys.ControlLeft)});
}
function scoreboard(){
  $('scoreboard-rows').replaceChildren();if(!G.state)return;
  for(const team of G.mode==='survival'?['blue']:['blue','red']){const column=document.createElement('div'),title=document.createElement('h3');title.textContent=G.mode==='survival'?'撤离小队':team==='blue'?'蓝队':'红队';column.append(title);
    for(const a of G.state.actors.filter(a=>a.team===team)){const row=document.createElement('div');row.className='row';const name=document.createElement('span');name.textContent=a.name+(a.human?'':' · AI');const state=document.createElement('small');state.textContent=`${a.kills} / ${a.deaths}　`+(a.extracted?'已撤离':a.alive?'作战中':'阵亡');row.append(name,state);column.append(row);}
    $('scoreboard-rows').append(column);
  }
}
function leave(){send({type:'leave'});G.playing=false;G.state=null;G.predicted=null;G.fire=false;G.keys={};G.resultShown=false;
  G.pulses={};
  G.aim=false;G.crouch=false;G.third=false;G.resetTouch?.();
  for(const v of G.actors.values())actorsRoot.remove(v.root);G.actors.clear();weapon.visible=false;
  for(const id of ['hud','result','pause','scoreboard','touch-controls'])$(id).classList.add('hidden');$('lobby').classList.remove('hidden');document.exitPointerLock();G.touchMove={forward:0,side:0,sprint:false};
}
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{G.mode=b.dataset.mode;document.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('active',x===b));
  $('brief').textContent=G.mode==='tdm'?'与队友协同作战。率先获得 150 次击杀的队伍赢得本局。':'感染者会从四面八方围上来。坚持 10 分钟，直升机落地后登机撤离。';
  $('teams').classList.toggle('hidden',G.mode==='survival');$('teamnote').textContent=G.mode==='tdm'?'队友与敌人外观各异，靠头顶标记分辨敌我。':'医务室可以恢复生命并补充弹药，尸群会避开你的视线生成。';});
document.querySelectorAll('[data-team]').forEach(b=>b.onclick=()=>{G.team=b.dataset.team;document.querySelectorAll('[data-team]').forEach(x=>x.classList.toggle('selected',x===b));});
$('callsign').value=localStorage.getItem('campus-callsign')||'队员-'+Math.floor(Math.random()*900+100);
$('deploy').onclick=()=>{localStorage.setItem('campus-callsign',$('callsign').value);$('lobby-error').textContent='';G.weapon='rifle';G.avatar=Number(localStorage.getItem('campus-avatar')||0);send({type:'join',mode:G.mode,name:$('callsign').value,team:G.team,avatar:G.avatar});requestLock();};
const roomAddress=()=>G.address||location.origin;
const copyRoom=async(feedback)=>{
  const address=roomAddress();
  try{await navigator.clipboard.writeText(address);feedback.textContent='已复制';}
  catch{$('lan-address').textContent=address;$('lan-room-address').value=address;feedback.textContent='请手动复制';}
  setTimeout(()=>{feedback.textContent='复制房间地址';},1800);
};
$('copy-address').onclick=()=>copyRoom($('copy-address'));
$('lan-copy').onclick=()=>copyRoom($('lan-copy'));
/* The lobby button used to only copy a URL. It now opens the real room dialog. */
function openLanDialog(){$('lan-room-address').value=roomAddress();$('lan-error').textContent='';$('lan-dialog').classList.remove('hidden');}
$('nav-lan').onclick=openLanDialog;
$('lan-close').onclick=()=>$('lan-dialog').classList.add('hidden');
$('lan-join').onclick=()=>{
  const raw=$('join-room-address').value.trim();
  const normalised=/^https?:\/\//i.test(raw)?raw:'http://'+raw;
  let parsed;try{parsed=new URL(normalised);}catch{$('lan-error').textContent='地址格式不正确，例如 http://192.168.1.20:8124';return;}
  if(!/^https?:$/.test(parsed.protocol)||!parsed.hostname){$('lan-error').textContent='地址格式不正确，例如 http://192.168.1.20:8124';return;}
  $('lan-error').textContent='正在进入 '+parsed.origin+' …';
  location.assign(parsed.origin+location.pathname);
};
function openAvatarDialog(){clearAvatarPreview();showAvatarPreview(Number(localStorage.getItem('campus-avatar')||0));$('avatar-modal').classList.remove('hidden');}
$('nav-avatar').onclick=openAvatarDialog;
$('avatar-close').onclick=()=>{$('avatar-modal').classList.add('hidden');clearAvatarPreview();};
$('scene').onclick=()=>{if(G.playing&&!G.resultShown)requestLock();};
document.addEventListener('pointerlockchange',()=>{G.locked=document.pointerLockElement===$('scene');if(!G.locked&&G.playing&&!G.resultShown)$('pause').classList.remove('hidden');});
document.addEventListener('mousemove',e=>{if(G.locked){G.yaw-=e.movementX*G.sensitivity;G.pitch=clamp(G.pitch-e.movementY*G.sensitivity,-1.42,1.42);}});
document.addEventListener('mousedown',e=>{if(G.locked){if(e.button===0)G.fire=true;if(e.button===2)G.aim=true;}});
document.addEventListener('mouseup',e=>{if(e.button===0)G.fire=false;if(e.button===2)G.aim=false;});
document.addEventListener('contextmenu',e=>e.preventDefault());
document.addEventListener('keydown',e=>{if(e.target.tagName==='INPUT')return;G.keys[e.code]=true;
  if(controlsActive()&&['KeyR','KeyF','Space'].includes(e.code))G.pulses[e.code]=G.clock+.18;
  if(G.playing&&['Space','Tab'].includes(e.code))e.preventDefault();
  if(e.code==='KeyC'&&G.playing)G.third=!G.third;
  if(G.playing&&['Digit1','Digit2','Digit3'].includes(e.code)){G.weapon={Digit1:'rifle',Digit2:'shotgun',Digit3:'pistol'}[e.code];}
  if(e.code==='Tab'&&G.playing){scoreboard();$('scoreboard').classList.remove('hidden');}
});
document.addEventListener('keyup',e=>{G.keys[e.code]=false;if(e.code==='Tab')$('scoreboard').classList.add('hidden');});
window.addEventListener('blur',()=>{G.keys={};G.fire=false;G.resetTouch?.();});
$('resume').onclick=()=>{$('pause').classList.add('hidden');if(G.touch)$('touch-controls').classList.remove('hidden');requestLock();};$('leave').onclick=leave;$('result-leave').onclick=leave;
$('spectate').onclick=()=>{$('result').classList.add('hidden');G.third=true;};
for(const id of ['open-settings','pause-settings'])$(id).onclick=()=>{$('settings').classList.remove('hidden');};
$('settings-close').onclick=()=>{$('settings').classList.add('hidden');};
$('quality').onchange=e=>{G.quality=e.target.value;renderer.setPixelRatio(G.quality==='high'?Math.min(devicePixelRatio,1.8):G.quality==='low'?.75:Math.min(devicePixelRatio,1.4));renderer.shadowMap.enabled=G.quality!=='low';resizeEffects();G.treesAt=-10;applyQualityDefaults();};
/* Imported characters cost one draw call per material, so how much of the crowd wears them
   follows the quality setting and stays user-adjustable. */
/* The numbers behind each weapon, spelled out. Damage falls off between the two distances and
   stops entirely at the range limit, and the player should be able to see that rather than
   discover it by feel. */
function renderArmory(){
  const keys=Object.keys(weaponSpecs||{});
  if(!keys.length)return;
  const dps=w=>`${(w.damage*w.pellets/(w.interval)).toFixed(0)}`;
  $('armory-list').innerHTML=keys.map((key,index)=>{
    const w=weaponSpecs[key];
    const close=(w.damage*w.pellets).toFixed(0),far=(w.damage*w.pellets*w.minDamage).toFixed(0);
    return `<article class="armory-card">
      <header><b>${index+1}　${w.name}</b><span>${w.pellets>1?w.pellets+' 发弹丸':'单发'} · ${w.interval<.2?'全自动':'单发'} · 弹匣 ${w.magazine}</span></header>
      <dl>
        <div><dt>贴脸伤害</dt><dd>${close}</dd></div>
        <div><dt>${Math.round(w.falloffStart)}–${Math.round(w.falloffEnd)} 米</dt><dd>${close} → ${far}</dd></div>
        <div><dt>射程上限</dt><dd>${Math.round(w.range)} 米</dd></div>
        <div><dt>射速</dt><dd>${(1/w.interval).toFixed(1)} 发/秒</dd></div>
      </dl>
      <p class="hint">${key==='shotgun'?'近距离一枪定胜负，出了二十米几乎没有威胁。':key==='pistol'?'中距离仍然可靠，比霰弹枪打得远，但伤害低一档。':'中距离主力，五十米外明显乏力，一百二十米外完全打不到。'}</p>
    </article>`;
  }).join('');
}function applyQualityDefaults(){
  if(G.avatarSharePinned)return;
  G.avatarShare=G.quality==='high'?100:G.quality==='low'?35:90;
  $('avatar-share').value=String(G.avatarShare);
}
$('avatar-share').onchange=e=>{G.avatarSharePinned=true;G.avatarShare=Number(e.target.value);};
$('volume').oninput=e=>G.volume=Number(e.target.value);$('sensitivity').oninput=e=>G.sensitivity=Number(e.target.value);
$('nav-combat').onclick=()=>{$('armory').classList.add('hidden');$('settings').classList.add('hidden');$('lan-dialog').classList.add('hidden');$('avatar-modal').classList.add('hidden');clearAvatarPreview();};
$('nav-armory').onclick=()=>{$('lan-dialog').classList.add('hidden');$('avatar-modal').classList.add('hidden');clearAvatarPreview();renderArmory();$('armory').classList.remove('hidden');};$('armory-close').onclick=()=>{$('armory').classList.add('hidden');};
if(G.touch){
  const lookPointers=new Map(),firePointers=new Set();let movePointer=null,moveOrigin=null;
  const updateLook=(e,p)=>{const dx=e.clientX-p.x,dy=e.clientY-p.y;G.yaw-=dx*.004;G.pitch=clamp(G.pitch-dy*.004,-1.42,1.42);p.x=e.clientX;p.y=e.clientY;};
  $('scene').addEventListener('pointerdown',e=>{if(!controlsActive()||e.clientX<innerWidth*.33)return;e.preventDefault();lookPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});$('scene').setPointerCapture(e.pointerId);});
  $('scene').addEventListener('pointermove',e=>{const p=lookPointers.get(e.pointerId);if(p&&controlsActive())updateLook(e,p);});
  const stopLook=e=>lookPointers.delete(e.pointerId);
  $('scene').addEventListener('pointerup',stopLook);$('scene').addEventListener('pointercancel',stopLook);
  const zone=$('move-zone'),knob=$('joystick').querySelector('i');
  G.resetTouch=()=>{lookPointers.clear();firePointers.clear();movePointer=null;moveOrigin=null;G.touchMove={forward:0,side:0,sprint:false};G.crouch=false;knob.style.transform='';document.querySelectorAll('#touch-controls .on').forEach(b=>b.classList.remove('on'));};
  zone.addEventListener('pointerdown',e=>{if(!controlsActive()||movePointer!==null)return;e.preventDefault();movePointer=e.pointerId;moveOrigin={x:e.clientX,y:e.clientY};zone.setPointerCapture(e.pointerId);});
  zone.addEventListener('pointermove',e=>{if(e.pointerId!==movePointer||!moveOrigin)return;e.preventDefault();const dx=e.clientX-moveOrigin.x,dy=e.clientY-moveOrigin.y,r=48,n=Math.max(1,Math.hypot(dx,dy)/r);G.touchMove.side=clamp(dx/r,-1,1);G.touchMove.forward=clamp(-dy/r,-1,1);G.touchMove.sprint=-dy>64&&!G.aim;knob.style.transform=`translate(${dx/n}px,${dy/n}px)`;});
  const stopMove=e=>{if(e.pointerId!==movePointer)return;movePointer=null;moveOrigin=null;G.touchMove={forward:0,side:0,sprint:false};knob.style.transform='';};
  zone.addEventListener('pointerup',stopMove);zone.addEventListener('pointercancel',stopMove);
  for(const id of ['touch-fire','touch-fire-left']){
    const button=$(id);let aim=null;
    button.addEventListener('pointerdown',e=>{if(!controlsActive())return;e.preventDefault();firePointers.add(e.pointerId);G.fire=true;button.setPointerCapture(e.pointerId);button.classList.add('on');aim={x:e.clientX,y:e.clientY};G.touchMove.sprint=false;});
    button.addEventListener('pointermove',e=>{if(firePointers.has(e.pointerId)&&aim)updateLook(e,aim);});
    const stop=e=>{firePointers.delete(e.pointerId);G.fire=firePointers.size>0;button.classList.remove('on');aim=null;};
    button.addEventListener('pointerup',stop);button.addEventListener('pointercancel',stop);
  }
  function pulse(key){G.keys[key]=true;setTimeout(()=>G.keys[key]=false,180);}
  $('touch-aim').onclick=()=>{G.aim=!G.aim;G.touchMove.sprint=false;$('touch-aim').classList.toggle('on',G.aim);};
  $('touch-jump').onclick=()=>{G.crouch=false;$('touch-crouch').classList.remove('on');pulse('Space');};
  $('touch-crouch').onclick=()=>{G.crouch=!G.crouch;G.touchMove.sprint=false;$('touch-crouch').classList.toggle('on',G.crouch);};
  $('touch-reload').onclick=()=>pulse('KeyR');$('touch-extract').onclick=()=>G.extractUntil=G.clock+.35;
  document.querySelectorAll('[data-weapon]').forEach(b=>b.onclick=()=>{G.weapon=b.dataset.weapon;document.querySelectorAll('[data-weapon]').forEach(x=>x.classList.toggle('on',x===b));});
  $('touch-menu').onclick=()=>{G.fire=false;G.keys={};G.touchMove={forward:0,side:0,sprint:false};$('pause').classList.remove('hidden');$('touch-controls').classList.add('hidden');};
}
window.addEventListener('resize',()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();resizeEffects();});
setInterval(inputs,1000/30);setInterval(()=>send({type:'ping',stamp:performance.now()}),2000);
applyQualityDefaults();
window.__campusQA={get avatars(){return avatarTemplates.map(a=>({file:a.file,label:a.label,style:a.style,license:a.license,clips:(a.animations||[]).map(c=>c.name),bones:skinnedOf(a.root)?.skeleton?.bones?.length||0,retargeted:a.retargeted||0,skinned:!!a.skinned,facing:a.facing}));},get effects(){return G.effects.length;},get muzzle(){return {visible:!!flashSprite?.visible,intensity:flashLight?.intensity||0,shots:G.muzzleShots||0,opacity:flashSprite?+(flashSprite.userData.material?.opacity??1).toFixed(3):0,scale:flashSprite?+flashSprite.scale.x.toFixed(3):0,smoke:[...G.effects].filter(e=>e.life&&e.life>0.5).length};},get actorsRoot(){return actorsRoot;},get three(){return THREE;},get state(){return G.state;},
  probe(x,z){return {standable:validMove(x,z),ground:terrain.ground(x,z)};},
  bodies(){const out=[];for(const [id,v]of G.actors){const a=v.target;if(a&&a.alive&&!a.extracted)out.push({id,x:+a.x.toFixed(2),z:+a.z.toFixed(2),y:+a.y.toFixed(2)});}return out;},
  canStand(x,z){return validMove(x,z);},
  get perf(){return {fps:G.fps,calls:G.lastCalls|0,triangles:G.lastTriangles|0,actors:G.actors.size,avatars:avatarTemplates.length,share:G.avatarShare,ao:aoPass.enabled,shadows:renderer.shadowMap.enabled};},
  zombieState(){const out=[];for(const [id,v]of G.actors){const a=v.target;if(!a||a.kind!=='zombie')continue;const g=terrain.ground(a.x,a.z);out.push({id,alive:a.alive,serverY:+a.y.toFixed(2),groundY:+g.toFixed(2),floatAboveGround:+(a.y-g).toFixed(2),visualY:+v.root.position.y.toFixed(2),label:v.avatarLabel||'',dist:+Math.hypot(a.x-(G.predicted?.x||0),a.z-(G.predicted?.z||0)).toFixed(1)});}return out;},
  zombieDetail(){const THREE=THREE_NS;const out=[];for(const [id,v]of G.actors){const a=v.target;if(!a||a.kind!=='zombie')continue;const g=terrain.ground(a.x,a.z);let low=Infinity,foot=null,colors=new Set(),tris=0;v.root.updateWorldMatrix(true,true);v.root.traverse(o=>{if(o.isBone&&/foot|toe/i.test(o.name)){const p=o.getWorldPosition(new THREE.Vector3());if(p.y<low){low=p.y;foot=o.name;}}if(o.isSkinnedMesh||o.isMesh){const m=o.material;const list=Array.isArray(m)?m:[m];for(const mm of list)if(mm&&mm.color)colors.add(mm.color.getHexString());}});out.push({id,alive:a.alive,dist:+Math.hypot(a.x-(G.predicted?.x||0),a.z-(G.predicted?.z||0)).toFixed(1),footBone:foot,footY:low===Infinity?null:+low.toFixed(3),groundY:+g.toFixed(3),footAboveGround:low===Infinity?null:+(low-g).toFixed(3),colors:[...colors].slice(0,3),bones:(()=>{let n=0;v.root.traverse(o=>{if(o.isBone)n++;});return n;})()});}return out;},
  templateFeet(){const THREE=THREE_NS;const probe=(label,root)=>{if(!root)return {label,missing:true};root.updateMatrixWorld(true);const plain=new THREE.Box3().setFromObject(root);const precise=new THREE.Box3().setFromObject(root,true);let low=Infinity,lowBone=null;root.traverse(o=>{if(o.isBone){const p=o.getWorldPosition(new THREE.Vector3());if(p.y<low){low=p.y;lowBone=o.name;}}});return {label,rootY:+root.position.y.toFixed(3),plainMinY:+plain.min.y.toFixed(3),preciseMinY:+precise.min.y.toFixed(3),lowestBoneY:low===Infinity?null:+low.toFixed(3),lowestBone:lowBone};};return [probe('soldier',soldierTemplate && soldierTemplate.root),...zombieTemplates.map((t,i)=>probe('zombie'+i,t.root)),...avatarTemplates.slice(0,3).map(a=>probe(a.file,a.root))];},
  zombieTracks(){const out=[];for(const [i,t]of zombieTemplates.entries()){const clips=[];for(const clip of (t.animations||[])){const tracks=[];for(const tr of clip.tracks){if(!/\.position$/.test(tr.name))continue;const v=tr.values;tracks.push({name:tr.name,keys:v.length/3,first:[+v[0].toFixed(3),+v[1].toFixed(3),+v[2].toFixed(3)],maxY:+Math.max(...Array.from({length:v.length/3},(_,k)=>v[k*3+1])).toFixed(3),minY:+Math.min(...Array.from({length:v.length/3},(_,k)=>v[k*3+1])).toFixed(3)});}clips.push({clip:clip.name,positionTracks:tracks});}out.push({template:i,bones:(()=>{let n=0;t.root.traverse(o=>{if(o.isBone)n++;});return n;})(),clips});}return out;},
  probeZombie(templateIndex,clipName){const THREE=THREE_NS;const t=zombieTemplates[templateIndex];if(!t)return null;const root=t.root;root.updateMatrixWorld(true);const grab=()=>{root.updateMatrixWorld(true);const out={};root.traverse(o=>{if(!o.isBone)return;if(/hips/i.test(o.name)||/root/i.test(o.name)||/toe|foot/i.test(o.name)){const p=o.getWorldPosition(new THREE.Vector3());out[o.name]=+p.y.toFixed(3);}});return out;};const rest=grab();const clip=(t.animations||[]).find(c=>c.name===clipName);if(!clip)return {rest,error:'no clip'};const mixer=new THREE.AnimationMixer(root);const action=mixer.clipAction(clip);action.play();mixer.update(.3);const playing=grab();action.stop();mixer.uncacheRoot(root);root.updateMatrixWorld(true);const after=grab();let model=null;root.traverse(o=>{if(!model&&o.isSkinnedMesh)model=o;});return {rest,playing,after,rootScale:+root.scale.y.toFixed(4),modelScale:model?+model.scale.y.toFixed(4):null,modelPosY:model?+model.position.y.toFixed(3):null,modelParentScale:model&&model.parent?+model.parent.scale.y.toFixed(4):null};},
  zombieHierarchy(index){const t=zombieTemplates[index];if(!t)return null;const rows=[];const walk=(o,depth)=>{if(depth<4)rows.push({name:o.name,type:o.type,depth,parent:o.parent?o.parent.name:null,localY:+o.position.y.toFixed(4)});for(const ch of o.children)walk(ch,depth+1);};walk(t.root,0);const clip=(t.animations||[]).find(c=>c.name==='Zombie_Idle');return {rows:rows.slice(0,14),tracks:clip?clip.tracks.filter(tr=>/position/.test(tr.name)).map(tr=>tr.name):[]};},
  setPass(name,on){if(name==='ao')aoPass.enabled=!!on;if(name==='aa')aaPass.enabled=!!on;if(name==='shadow')renderer.shadowMap.enabled=!!on;if(name==='grade')grade.enabled=!!on;return {ao:aoPass.enabled,aa:aaPass.enabled,shadow:renderer.shadowMap.enabled,grade:grade.enabled};},
  showZombies(){const THREE=THREE_NS;const p=G.predicted;if(!p)return null;const out=[];zombieTemplates.forEach((t,i)=>{const c=cloneSkeleton(t.root);c.position.set(p.x+(i?-1.6:1.6),terrain.ground(p.x,p.z),p.z-4);c.rotation.y=G.yaw+Math.PI;c.visible=true;scene.add(c);const mixer=new THREE.AnimationMixer(c);const act=chooseAction((t.animations||[]).reduce((m,cl)=>{m[cl.name]=mixer.clipAction(cl);return m;},{}));if(act.idle)act.idle.play();out.push({i,file:i?'zombie-animated.glb':'zombie.glb',clip:act.idle?act.idle.getClip().name:null,x:c.position.x,z:c.position.z});});G.actorPreview=c=>{};return out;},
  drawBreakdown(){let actorMeshes=0,actorSprites=0,treeMeshes=0,otherMeshes=0,buildMeshes=0,shadowCasters=0;const actorRoots=new Set();for(const [,v]of G.actors)actorRoots.add(v.root);for(const [,v]of G.actors)v.root.traverse(o=>{if(!o.visible)return;if(o.isSprite)actorSprites++;else if(o.isMesh){actorMeshes++;if(o.castShadow)shadowCasters++;}});for(const b of G.treeBatches){if(b.batch&&b.batch.visible){treeMeshes++;if(b.batch.castShadow)shadowCasters++;}}scene.traverse(o=>{if(!o.visible||!o.isMesh)return;let p=o,isActor=false;while(p){if(actorRoots.has(p)){isActor=true;break;}p=p.parent;}if(isActor)return;if(/tree|leaf|bark/i.test(o.name||''))return;if(o.castShadow)shadowCasters++;if(/building|facade|wall|roof|slab|stair|window/i.test(o.name||''))buildMeshes++;else otherMeshes++;});const matCount=new Map();for(const [,v]of G.actors)v.root.traverse(o=>{if(o.isMesh&&o.material){const m=Array.isArray(o.material)?o.material:[o.material];for(const x of m)matCount.set(x.uuid,(matCount.get(x.uuid)||0)+1);}});let multiMaterialActors=0;for(const [,v]of G.actors){let n=0;v.root.traverse(o=>{if(o.isMesh)n++;});if(n>3)multiMaterialActors++;}return {actorMeshes,actorSprites,treeMeshes,buildMeshes,otherMeshes,shadowCasters,visibleActors:G.actors.size,actorsWithManyMeshes:multiMaterialActors,distinctActorMaterials:matCount.size,renderCalls:G.lastCalls|0};},
  frameStats(){const f=G.frameTimes||[];if(f.length<30)return {samples:f.length};const pct=(key,p)=>{const s=f.map(x=>+(x[key]||0)).sort((a,b)=>a-b);return +s[Math.min(s.length-1,Math.floor(s.length*p))].toFixed(2);};return {samples:f.length,dt:{p50:pct('dt',.5),p95:pct('dt',.95),p99:pct('dt',.99),max:+Math.max(...f.map(x=>x.dt)).toFixed(1)},js:{p50:pct('cost',.5),p95:pct('cost',.95),max:+Math.max(...f.map(x=>x.cost)).toFixed(1)},parts:['actors','render','radar','hud'].map(k=>({k,p50:pct(k,.5),p95:pct(k,.95)}))};},
  zombieBones(){return zombieTemplates.map(t=>{const out=[];t.root.traverse(o=>{if(o.isBone)out.push(o.name);});return {file:t.file,clips:(t.animations||[]).map(c=>c.name),first:out.slice(0,4),count:out.length};});},
  get mix(){let av=0,sold=0;const names={};for(const [,v]of G.actors){if(v.isAvatar){av++;const n=v.avatarLabel||'?';names[n]=(names[n]||0)+1;}else sold++;}return {avatars:av,soldiers:sold,share:G.avatarShare,distinct:Object.keys(names).length,names};},
  freezeFlash(age){G.flashFreeze=age==null?null:age;return true;},
  flashFor(seconds){G.muzzleStart=G.clock;return true;},
  get corpses(){let n=0;for(const [,v]of G.actors)if(v.target&&!v.target.alive&&v.root.visible)n++;return n;},
  deadSpot(){for(const [id,v]of G.actors)if(v.target&&!v.target.alive&&v.root.visible)return {id,x:v.position.x,y:v.position.y,z:v.position.z,yaw:v.target.yaw};return null;},
  get clipSpread(){const probe=soldierTemplate?.animations||[];const out=[];for(const c of probe){let mn=Infinity,mx=-Infinity;for(const t of c.tracks)for(let i=0;i<t.values.length;i++){mn=Math.min(mn,t.values[i]);mx=Math.max(mx,t.values[i]);}out.push({name:c.name,tracks:c.tracks.length,duration:+c.duration.toFixed(3),min:+mn.toFixed(4),max:+mx.toFixed(4)});}return out;},
  visualState(){const out=[];for(const [id,v]of G.actors){out.push({id,current:v.current,mixer:+(v.mixer.time.toFixed(2)),clips:Object.keys(v.clip).filter(k=>v.clip[k]).length,weights:Object.entries(v.clip).filter(([,a])=>a&&a.isRunning()&&a.getEffectiveWeight()>0.01).map(([k,a])=>k+':w'+a.getEffectiveWeight().toFixed(2)+',t'+a.time.toFixed(2)+',ts'+a.getEffectiveTimeScale().toFixed(2)+(a.paused?',PAUSED':'')+(a.enabled?'':',DISABLED'))});if(out.length>=6)break;}return out;},  visualOf(id,probeRe){const v=G.actors.get(id);if(!v)return null;const running=Object.entries(v.clip).filter(([,a])=>a&&a.isRunning()).map(([k,a])=>k+':w'+a.getEffectiveWeight().toFixed(2)+',t'+a.time.toFixed(2)+',ts'+a.getEffectiveTimeScale().toFixed(2)+(a.paused?',PAUSED':'')+(a.enabled?'':',DISABLED'));let bone=null;if(probeRe){v.root.traverse(o=>{if(!bone&&o.isBone&&new RegExp(probeRe,'i').test(o.name))bone=o;});}return {current:v.current,mixer:+v.mixer.time.toFixed(2),running,boneName:bone?bone.name:null,boneQ:bone?[+bone.quaternion.x.toFixed(4),+bone.quaternion.y.toFixed(4),+bone.quaternion.z.toFixed(4),+bone.quaternion.w.toFixed(4)]:null,rootX:+v.root.rotation.x.toFixed(4),visible:v.root.visible};},
  trackStats(file,clipName,re){const t=avatarTemplates.find(a=>a.file===file);if(!t)return 'no template '+file;const c=(t.animations||[]).find(x=>x.name===clipName);if(!c)return 'no clip '+clipName;const out=[];for(const tr of c.tracks){if(!new RegExp(re,'i').test(tr.name))continue;let mn=Infinity,mx=-Infinity;for(let i=0;i<tr.values.length;i++){mn=Math.min(mn,tr.values[i]);mx=Math.max(mx,tr.values[i]);}out.push({name:tr.name,keys:tr.times.length,min:+mn.toFixed(3),max:+mx.toFixed(3)});}return out;},
  /* ---- self-audit helpers: every claim about animation and facing gets measured ---- */
  auditAnimation(file,clipName){
    const template=avatarTemplates.find(a=>a.file===file);
    if(!template)return {file,error:'unknown template'};
    const model=cloneSkeleton(template.root),holder=new THREE.Group();
    holder.position.set(0,-900,0);scene.add(holder);holder.add(model);
    const mixer=new THREE.AnimationMixer(model),actions={};
    for(const c of template.animations||[])actions[c.name]=mixer.clipAction(c);
    const bones=[];model.traverse(o=>{if(o.isBone)bones.push(o);});
    const pick=re=>bones.find(b=>new RegExp(re,'i').test(b.name));
    const probeBones={hips:pick('hips|pelvis'),foot:pick('left.*foot|foot.*left|_l_foot|footl')||pick('foot|ankle'),
      hand:pick('left.*hand|hand.*left|_l_hand|handl')||pick('hand|wrist'),head:pick('head')};
    const probe={};for(const [k,b]of Object.entries(probeBones))probe[k]=b?b.name:null;
    const result={file,bones:bones.length,clips:Object.keys(actions),probe,travel:{}};
    const action=actions[clipName];
    if(!action){result.error='no clip '+clipName;scene.remove(holder);return result;}
    action.play();
    const rows=[],quatTrace=[],worldTrace=[];
    for(let i=0;i<14;i++){
      mixer.update(.11);model.updateMatrixWorld(true);
      const row={};
      for(const [k,b]of Object.entries(probeBones))if(b)row[k]=model.worldToLocal(b.getWorldPosition(new THREE.Vector3()));
      rows.push(row);
      if(probeBones.foot)quatTrace.push(probeBones.foot.quaternion.toArray().map(v=>+v.toFixed(4)));
      if(probeBones.foot)worldTrace.push(probeBones.foot.getWorldPosition(new THREE.Vector3()).toArray().map(v=>+v.toFixed(4)));
    result.quatTrace=quatTrace;result.worldTrace=worldTrace;
    result.mixerTime=+mixer.time.toFixed(3);result.actionTime=+action.time.toFixed(3);
    result.weight=action.getEffectiveWeight();result.running=action.isRunning();
    result.bound=probeBones.foot?probeBones.foot.name:null;
    }
    for(const [k,b]of Object.entries(probeBones)){
      if(!b)continue;
      const span=ax=>{const v=rows.map(r=>r[k][ax]);return Math.max(...v)-Math.min(...v);};
      result.travel[k]={x:+span('x').toFixed(3),y:+span('y').toFixed(3),z:+span('z').toFixed(3),
        max:+Math.max(span('x'),span('y'),span('z')).toFixed(3)};
    }
    try{
      const tr=action.getClip().tracks.find(t=>/foot\.quaternion$/i.test(t.name));
      result.footTrackName=tr?tr.name:null;
      result.footTrackSample=tr?Array.from(tr.values.slice(0,8)).map(v=>+v.toFixed(3)):null;
      const mixes=action._propertyBindings||[];
      result.bindingSample=mixes.slice(0,4).map(m=>({path:m.binding&&m.binding.path,node:m.binding&&m.binding.node?m.binding.node.name:'NULL'}));
    }catch(e){result.trackError=String(e);}
    mixer.stopAllAction();scene.remove(holder);
    return result;
  },
  /* Independent of bones: in a bind pose the toes reach further from the ankle than the heel
     does, so the foot vertices alone reveal which way the mesh was modelled to face. */
  /* Independent of the rig: the ankle is the pivot of the foot, and toes stick out further
     than the heel does, so the foot vertices alone reveal the authored facing. Using the
     ankle rather than the body centroid matters - a big back bow skews a centroid test. */
  /* Facing, decided from the mesh rather than the rig. VRoid exposes the face and eyes as their
     own material groups, and those only ever exist on the front of the head, so the face group's
     offset from the head bone is a direct answer. Rigs without such groups fall back to null and
     the caller keeps the bone-based estimate. */
  facingAudit(file){
    const template=avatarTemplates.find(a=>a.file===file);
    if(!template)return {file,error:'unknown template'};
    const root=cloneSkeleton(template.root);root.updateMatrixWorld(true);
    let head=null;
    root.traverse(o=>{if(!head&&o.isBone&&/head/i.test(o.name))head=o;});
    const headZ=head?root.worldToLocal(head.getWorldPosition(new THREE.Vector3())).z:null;
    let faceZ=0,faceN=0,otherZ=0,otherN=0,minY=Infinity,maxY=-Infinity;
    const v=new THREE.Vector3();
    const meshes=[];root.traverse(o=>{if(o.isMesh&&o.geometry.attributes.position)meshes.push(o);});
    for(const o of meshes){
      const geo=o.geometry,pos=geo.attributes.position;
      const mats=Array.isArray(o.material)?o.material:[o.material];
      const groups=(geo.groups&&geo.groups.length)?geo.groups:[{start:0,count:(geo.index?geo.index.count:pos.count),materialIndex:0}];
      for(const g of groups){
        const name=(mats[g.materialIndex]||mats[0]||{}).name||'';
        const isFace=/face|eye|mouth|brow|lash/i.test(name);
        const step=Math.max(1,Math.floor((g.count||1)/1200));
        for(let k=0;k<g.count;k+=step){
          const idx=geo.index?geo.index.getX(g.start+k):(g.start+k);
          v.fromBufferAttribute(pos,idx);o.localToWorld(v);
          const local=root.worldToLocal(v.clone());
          minY=Math.min(minY,local.y);maxY=Math.max(maxY,local.y);
          if(local.y<maxY-0.35)continue;
          if(isFace){faceZ+=local.z;faceN++;}else{otherZ+=local.z;otherN++;}
        }
      }
    }
    const result={file,faceVertices:faceN,otherVertices:otherN,
      headZ:headZ===null?null:+headZ.toFixed(3),
      faceZ:faceN?+(faceZ/faceN).toFixed(3):null,otherZ:otherN?+(otherZ/otherN).toFixed(3):null};
    if(faceN>=25&&headZ!==null){
      const d=(faceZ/faceN)-headZ;
      result.faceOffset=+d.toFixed(3);
      result.meshForward=d>0?'+Z':'-Z';
      result.meshForwardZ=d>0?1:-1;
      result.method='face-material';
    }else result.method='none';
    return result;
  },
  rawTrack(file,clipName,re){const t=avatarTemplates.find(a=>a.file===file);if(!t)return 'no template';const c=(t.animations||[]).find(x=>x.name===clipName);if(!c)return 'no clip';const tr=c.tracks.find(x=>new RegExp(re,'i').test(x.name));if(!tr)return 'no track';return {name:tr.name,keys:tr.times.length,values:Array.from(tr.values).map(v=>+v.toFixed(3))};},
  flashInfo(){let meshes=0,sprites=0;flashSprite&&flashSprite.traverse(o=>{if(o.isMesh)meshes++;if(o.isSprite)sprites++;});
    return {type:flashSprite?flashSprite.type:'none',meshes,sprites,hasLight:!!flashLight,
      textureFree:!muzzleTexture,color:flashMaterial.color.getHexString(),additive:flashMaterial.blending===THREE.AdditiveBlending};},
  /* Does each limb bend the way a human limb bends? Forward is defined by the foot->toe
     direction, so this needs no assumption about the rig's own axes. A human knee sits in
     FRONT of the hip-ankle chord when flexed; an elbow sits BEHIND the shoulder-wrist chord.
     If a retarget mirrors the lower body these signs flip, which is exactly what it looks like. */
  limbAudit(file,clipName='walk'){
    let root,clips;
    if(file==='__source'){root=motionSource;clips=motionClips;}
    else if(file==='__soldier'){root=cloneSkeleton(soldierTemplate.root);clips=soldierTemplate.animations||[];}
    else{const t=avatarTemplates.find(a=>a.file===file);if(!t)return {file,error:'unknown'};root=cloneSkeleton(t.root);clips=t.animations||[];}
    if(!root)return {file,error:'no rig'};
    const holder=new THREE.Group();holder.position.set(0,-900,0);scene.add(holder);holder.add(root);
    const byRole=role=>{let f=null;root.traverse(o=>{if(f||!o.isBone)return;if(roleOf(o.name)===role)f=o;});return f;};
    const bones={hipL:byRole('leftUpperLeg'),kneeL:byRole('leftLowerLeg'),ankleL:byRole('leftFoot'),toeL:byRole('leftToe'),
      hipR:byRole('rightUpperLeg'),kneeR:byRole('rightLowerLeg'),ankleR:byRole('rightFoot'),toeR:byRole('rightToe'),
      shoulderL:byRole('leftUpperArm'),elbowL:byRole('leftLowerArm'),wristL:byRole('leftHand'),
      shoulderR:byRole('rightUpperArm'),elbowR:byRole('rightLowerArm'),wristR:byRole('rightHand')};
    const clip=clips.find(c=>c.name===clipName);
    if(!clip){scene.remove(holder);return {file,error:'no clip '+clipName};}
    const mixer=new THREE.AnimationMixer(root);mixer.clipAction(clip).play();
    const V=()=>new THREE.Vector3();
    const local=b=>root.worldToLocal(b.getWorldPosition(V()));
    const rows=[];
    for(let i=0;i<20;i++){
      mixer.update(clip.duration/20);root.updateMatrixWorld(true);
      const p={};for(const [k,b]of Object.entries(bones))if(b)p[k]=local(b);
      if(p.toeL&&p.ankleL){
        p.forward=V().subVectors(p.toeL,p.ankleL);p.forward.y=0;if(p.forward.lengthSq()>1e-8)p.forward.normalize();else p.forward=null;
      }
      rows.push(p);
    }
    const out={file,bones:Object.fromEntries(Object.entries(bones).map(([k,b])=>[k,b?b.name:null]))};
    const measure=(hip,knee,ankle,forward,sign)=>{
      let maxPos=-Infinity,maxNeg=Infinity,flex=0;
      for(const r of rows){
        if(!r[hip]||!r[knee]||!r[ankle]||!r.forward)continue;
        const mid=V().addVectors(r[hip],r[ankle]).multiplyScalar(.5);
        const off=V().subVectors(r[knee],mid);
        const along=off.dot(r.forward);
        maxPos=Math.max(maxPos,along);maxNeg=Math.min(maxNeg,along);
        const t=V().subVectors(r[knee],r[hip]),s=V().subVectors(r[ankle],r[knee]);
        const angle=t.angleTo(s)*180/Math.PI;
        flex=Math.max(flex,angle);
      }
      return {maxForward:+maxPos.toFixed(3),maxBackward:+maxNeg.toFixed(3),maxFlexDeg:+flex.toFixed(1)};
    };
    out.leftKnee=measure('hipL','kneeL','ankleL',null,1);
    const excursion=(from,to,sign)=>{
      let maxP=-Infinity,maxN=Infinity;
      for(const r of rows){
        if(!r[from]||!r[to]||!r.forward)continue;
        const d=V().subVectors(r[to],r[from]).dot(r.forward);
        maxP=Math.max(maxP,d);maxN=Math.min(maxN,d);
      }
      return {max:+maxP.toFixed(3),min:+maxN.toFixed(3)};
    };
    out.thighSwingL=excursion('hipL','kneeL');
    out.series={};
    out.sides=(()=>{
      root.updateMatrixWorld(true);
      const hips=byRole('hips'),at=role=>{const b=byRole(role);if(!b||!hips)return null;const p=local(b),h=local(hips);return +(p.x-h.x).toFixed(3);};
      return {hipsX:hips?+local(hips).x.toFixed(3):null,
        leftThighX:at('leftUpperLeg'),rightThighX:at('rightUpperLeg'),
        leftArmX:at('leftUpperArm'),rightArmX:at('rightUpperArm'),
        leftFootX:at('leftFoot'),rightFootX:at('rightFoot')};
    })();
    for(const [tag,from,to]of [['thighL','hipL','kneeL'],['thighR','hipR','kneeR'],['shinL','kneeL','ankleL'],['shinR','kneeR','ankleR']]){
      out.series[tag]=rows.map(r=>{
        if(!r[from]||!r[to]||!r.forward)return 0;
        return +V().subVectors(r[to],r[from]).dot(r.forward).toFixed(4);
      });
    }
    out.shinFromKneeL=excursion('kneeL','ankleL');
    out.footFromAnkleL=excursion('ankleL','toeL');
    out.upperArmL=excursion('shoulderL','elbowL');
    out.foreArmL=excursion('elbowL','wristL');
    out.rightKnee=measure('hipR','kneeR','ankleR',null,1);
    out.leftElbow=(()=>{
      let maxPos=-Infinity,maxNeg=Infinity,flex=0;
      for(const r of rows){
        if(!r.shoulderL||!r.elbowL||!r.wristL||!r.forward)continue;
        const mid=V().addVectors(r.shoulderL,r.wristL).multiplyScalar(.5);
        const along=V().subVectors(r.elbowL,mid).dot(r.forward);
        maxPos=Math.max(maxPos,along);maxNeg=Math.min(maxNeg,along);
        const t=V().subVectors(r.elbowL,r.shoulderL),s=V().subVectors(r.wristL,r.elbowL);
        flex=Math.max(flex,t.angleTo(s)*180/Math.PI);
      }
      return {maxForward:+maxPos.toFixed(3),maxBackward:+maxNeg.toFixed(3),maxFlexDeg:+flex.toFixed(1)};
    })();
    mixer.stopAllAction();scene.remove(holder);
    return out;
  },
  get weaponPose(){return {x:+weapon.position.x.toFixed(3),y:+weapon.position.y.toFixed(3),z:+weapon.position.z.toFixed(3),rx:+weapon.rotation.x.toFixed(3),rz:+weapon.rotation.z.toFixed(3),visible:weapon.visible};},
  lookAt(x,y,z,distance=5,height=1.6){G.preview={position:new THREE.Vector3(x+distance*.6,y+height,z+distance*.8),target:new THREE.Vector3(x,y+.5,z)};return true;},
  clearPreview(){G.preview=null;return true;},
  get clinicRoom(){return G.clinicAccess?{...G.clinicAccess.room}:null;},get ready(){return G.ready;},get position(){return G.predicted;},get fps(){return G.fps;},get renderer(){return renderer;},get scene(){return scene;},get models(){return G.actors.size;},get trees(){return G.treeCounts;},get controls(){return {touch:G.touch,move:G.touchMove,fire:G.fire,aim:G.aim,yaw:G.yaw,pitch:G.pitch,locked:G.locked};},preview(position,target){G.preview={position:new THREE.Vector3(...position),target:new THREE.Vector3(...target)};G.treesAt=-10;},get treeInfo(){return G.treeBatches.map(t=>({lod:t.lod,source:t.source.elements,instances:t.batch.count,bounds:t.batch.geometry.boundingBox}));}};
connect();load();requestAnimationFrame(frame);
