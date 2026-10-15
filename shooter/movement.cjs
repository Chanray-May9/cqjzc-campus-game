/* Single source of truth for movement speed.
 *
 * The client, the authoritative server and the bot AI all read these numbers, so a human and
 * a bot walking or sprinting over the same second cover exactly the same distance. Bots used to
 * have a private 3.7 m/s that matched nothing, and they never sprinted at all.
 */
const MOVEMENT = {
  WALK: 4.1,
  SPRINT: 6.8,
  CROUCH: 2.2,
  JUMP: 6.7,
  GRAVITY: 20,
  /* Firing must never take the gun away. Blocking the trigger while sprinting meant that holding
     shift - which is how everybody moves - silently disabled the weapon: no shot sound and no
     muzzle flash. Sprint is only suppressed by crouching. */
  BOT_SPRINT_DISTANCE: 28,
  ZOMBIE_WALK: 2.0,
  ZOMBIE_RAMP: 0.65,
  ZOMBIE_RAMP_SECONDS: 600,
};

/* Resolve the speed for one actor given what it is doing. Shared by the server tick and the
   client's own prediction, which is what keeps the two in lockstep. */
function speedFor({ kind = 'soldier', crouch = false, sprint = false, elapsed = 0 }) {
  if (kind === 'zombie') {
    return MOVEMENT.ZOMBIE_WALK + (elapsed / MOVEMENT.ZOMBIE_RAMP_SECONDS) * MOVEMENT.ZOMBIE_RAMP;
  }
  if (crouch) return MOVEMENT.CROUCH;
  if (sprint) return MOVEMENT.SPRINT;
  return MOVEMENT.WALK;
}

module.exports = { MOVEMENT, speedFor };
