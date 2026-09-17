// Arms a burn node: maps "prograde + lateral m/s" to the frozen unit thrust
// direction and delta-v target the PEFRL kick (pefrl.ts) spends against,
// ported from research §3.6 (ADR-0005 "Burns"). No trig -- the prograde
// frame is built from the inertial velocity by rotation, not angle.

import type { PefrlObjects } from './pefrl.ts';

export interface StartBurnArgs {
  objects: PefrlObjects;
  index: number;
  /** m/s along the frozen inertial-velocity direction at activation. */
  prograde: number;
  /** m/s along the frozen +90 degree (left of velocity) direction. */
  lateral: number;
}

/** Freezes u = v/|v|, l = (-u.y, u.x), n = (dvp*u + dvl*l)/dv_target and
 *  arms the burn (research §3.6). Call at the tick boundary the node
 *  activates on: command times are quantised to ticks, so activation is
 *  always `tick * dt` and the kick never needs a mid-tick start clamp. */
export function startBurn({ objects, index, prograde, lateral }: StartBurnArgs): void {
  const vx = objects.vx[index]!;
  const vy = objects.vy[index]!;
  const speed = Math.sqrt(vx * vx + vy * vy);
  if (speed === 0) throw new Error(`startBurn: object ${index} has zero velocity`);
  const dv = Math.sqrt(prograde * prograde + lateral * lateral);
  if (dv === 0) throw new Error(`startBurn: object ${index} has a zero delta-v target`);

  const ux = vx / speed;
  const uy = vy / speed;
  const lx = -uy;
  const ly = ux;

  objects.burnNx[index] = (prograde * ux + lateral * lx) / dv;
  objects.burnNy[index] = (prograde * uy + lateral * ly) / dv;
  objects.burnTarget[index] = dv;
  objects.burnDelivered[index] = 0;
  objects.burning[index] = 1;
}
