/* Weapon table. `range` is a hard stop - the hitscan ray is clamped to it, so nothing beyond that
 * distance can ever be hit. `falloffStart`..`falloffEnd` is where damage slides from full to
 * `minDamage`. These used to be so gentle over the distances people actually fight at (a rifle
 * still did 86% of its damage at 60 m) that the falloff was invisible, which is what made it feel
 * like damage was flat and range unlimited. The curve is now steep enough to change how you play:
 * the rifle is a close-to-mid weapon, the pistol reaches further than the shotgun but hits softer,
 * and the shotgun is a room-clearer that is nearly useless past 20 m.
 */
const WEAPONS={
 rifle:{name:'突击步枪',magazine:30,reserve:240,interval:.115,reload:2.0,damage:25,head:2.08,
   falloffStart:12,falloffEnd:95,minDamage:.28,pellets:1,spread:0,range:120,model:'assaultRifle.glb'},
 shotgun:{name:'泵动霰弹枪',magazine:8,reserve:64,interval:.85,reload:2.6,damage:15,head:1.4,
   falloffStart:4,falloffEnd:20,minDamage:.10,pellets:8,spread:.075,range:38,model:'shotgun.glb'},
 pistol:{name:'制式手枪',magazine:12,reserve:96,interval:.24,reload:1.45,damage:32,head:1.8,
   falloffStart:8,falloffEnd:45,minDamage:.22,pellets:1,spread:0,range:70,model:'pistol.glb'}
};
/* `beyondRange` returns 0 rather than the floor value: the ray never reaches that far. */
function damageAt(weapon,distance,head=false){
 const w=typeof weapon==='string'?WEAPONS[weapon]:weapon;
 if(distance>w.range)return 0;
 const t=Math.max(0,Math.min(1,(distance-w.falloffStart)/(w.falloffEnd-w.falloffStart)));
 return w.damage*(1-t*(1-w.minDamage))*(head?w.head:1);
}
module.exports={WEAPONS,damageAt};
