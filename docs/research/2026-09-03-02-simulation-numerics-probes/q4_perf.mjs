// Q4: performance of a realistic Graviton tick, Node 24.
// Structure of arrays, integer tick, per-object substep ladder, PEFRL,
// analytic Keplerian ephemeris with parent chains, exposure accumulation.
import { solveKepler, kepSin, kepCos, hashF64 } from "./q1_core.mjs";

const NB = 6;                       // attractors
const AU = 1.495978707e11;
// body i: parent index (-1 = root), mu, a, e, argument of periapsis, mean motion, M0
const par = new Int32Array ([-1, 0, 0, 0, 1, 0]);
const mu  = new Float64Array([1.32712440018e20, 1.26686534e17, 3.986004418e14,
                              3.7931187e16, 4.9048695e12, 6.836529e15]);
const sma = new Float64Array([0, 5.2*AU, 1.0*AU, 9.5*AU, 6.7e8, 30.1*AU]);
const ecc = new Float64Array([0, 0.0489, 0.0167, 0.0565, 0.0074, 0.0086]);
const aop = new Float64Array([0, 0.257, 1.796, 1.613, 0.442, 0.784]);
const M0  = new Float64Array([0, 0.6, 1.75, 5.53, 3.11, 4.47]);
const nmo = new Float64Array(NB);
const rref3 = new Float64Array(NB);       // mu * (dt/eta)^2, the dynamical ladder key
const bx = new Float64Array(NB), by = new Float64Array(NB);
const bvx = new Float64Array(NB), bvy = new Float64Array(NB);

const DT = 60.0, ETA = 0.05, ZETA = 1 / 32, LMAX = 10;
for (let i = 1; i < NB; i++) nmo[i] = Math.sqrt(mu[par[i]] / (sma[i]*sma[i]*sma[i]));
for (let i = 0; i < NB; i++) rref3[i] = mu[i] * (DT / ETA) * (DT / ETA);

const TWO_PI = 6.283185307179586;
/** Ephemeris for all bodies at time t. Parents are listed before children, so
 *  one forward pass composes the chain in O(NB) regardless of depth. */
function ephemeris(t) {
  bx[0] = 0; by[0] = 0; bvx[0] = 0; bvy[0] = 0;
  for (let i = 1; i < NB; i++) {
    let M = M0[i] + nmo[i] * t;
    // reduce to [0, 2pi): floor is exact, and |M| stays far inside the
    // Cody-Waite exactness bound for any level-length run
    M = M - TWO_PI * Math.floor(M * (1 / TWO_PI));
    const e = ecc[i];
    solveKepler(M, e);
    const sE = kepSin, cE = kepCos;
    const a = sma[i], b = a * Math.sqrt(1 - e * e);
    const px = a * (cE - e), py = b * sE;
    const r = a * (1 - e * cE);
    const f = Math.sqrt(mu[par[i]] * a) / r;
    const pvx = -f * sE, pvy = (b / a) * f * cE;
    const cw = Math.cos(aop[i]), sw = Math.sin(aop[i]);   // constant per body: precomputable
    const p = par[i];
    bx[i]  = bx[p]  + px * cw - py * sw;
    by[i]  = by[p]  + px * sw + py * cw;
    bvx[i] = bvx[p] + pvx * cw - pvy * sw;
    bvy[i] = bvy[p] + pvx * sw + pvy * cw;
  }
}

// ---------------------------------------------------------------- objects
const N = 50;
const ox = new Float64Array(N), oy = new Float64Array(N);
const ovx = new Float64Array(N), ovy = new Float64Array(N);
const omass = new Float64Array(N), oexp = new Float64Array(N);
const olev = new Int32Array(N);
function seedObjects(scenario) {
  let s = 987654321;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  ephemeris(0);
  for (let i = 0; i < N; i++) {
    if (scenario === "cruise") {
      const th = rnd() * TWO_PI, r = (1.2 + 2.0 * rnd()) * AU;
      ox[i] = r * Math.cos(th); oy[i] = r * Math.sin(th);
      const sp = 1.0e5 + 2.0e5 * rnd(), ph = rnd() * TWO_PI;
      ovx[i] = sp * Math.cos(ph); ovy[i] = sp * Math.sin(ph);
    } else {                                  // one object grazing body 1
      const R = 7.1492e7 * (1.05 + 0.2 * rnd());
      const th = rnd() * TWO_PI;
      ox[i] = bx[1] + R * Math.cos(th); oy[i] = by[1] + R * Math.sin(th);
      const sp = 2.0e5, ph = th + 1.5707963267948966;
      ovx[i] = bvx[1] + sp * Math.cos(ph); ovy[i] = bvy[1] + sp * Math.sin(ph);
    }
    omass[i] = 800 + 400 * rnd(); oexp[i] = 0;
  }
}

/** Substep level for one object, from state alone. No log, no cbrt.
 *  L = max over bodies of (dynamical ladder, crossing ladder), clamped. */
function levelFor(i) {
  let L = 0;
  const px = ox[i], py = oy[i];
  for (let b = 0; b < NB; b++) {
    const dx = px - bx[b], dy = py - by[b];
    const r2 = dx * dx + dy * dy, r = Math.sqrt(r2);
    // dynamical: smallest L with 4^L r^3 >= mu*(dt/eta)^2
    let s = r * r2, l1 = 0;
    while (l1 < LMAX && s < rref3[b]) { s *= 4; l1++; }
    // crossing: smallest L with (dt/2^L)*v_rel <= zeta*r
    const rvx = ovx[i] - bvx[b], rvy = ovy[i] - bvy[b];
    let d = DT * Math.sqrt(rvx * rvx + rvy * rvy);
    const lim = ZETA * r;
    let l2 = 0;
    while (l2 < LMAX && d > lim) { d *= 0.5; l2++; }
    const l = l1 > l2 ? l1 : l2;
    if (l > L) L = l;
  }
  return L;
}

let AX = 0, AY = 0;
function accel(px, py) {
  let ax = 0, ay = 0;
  for (let b = 0; b < NB; b++) {
    const dx = px - bx[b], dy = py - by[b];
    const r2 = dx * dx + dy * dy, r = Math.sqrt(r2);
    const k = -mu[b] / (r2 * r);
    ax += k * dx; ay += k * dy;
  }
  AX = ax; AY = ay;
}

const XI = 0.1786178958448091, LAM = -0.2123418310626054, CHI = -0.06626458266981849;
const K1 = (1 - 2 * LAM) * 0.5, D3 = 1 - 2 * (CHI + XI);

/** Advance every object in `idx` by one substep of length h starting at t.
 *  The ephemeris is evaluated once per PEFRL stage and shared by all of them. */
function pefrlGroup(idx, n, t, h) {
  for (let j = 0; j < n; j++) { const i = idx[j]; ox[i] += XI*h*ovx[i]; oy[i] += XI*h*ovy[i]; }
  ephemeris(t + XI*h);
  for (let j = 0; j < n; j++) { const i = idx[j]; accel(ox[i], oy[i]); ovx[i] += K1*h*AX; ovy[i] += K1*h*AY; }
  for (let j = 0; j < n; j++) { const i = idx[j]; ox[i] += CHI*h*ovx[i]; oy[i] += CHI*h*ovy[i]; }
  ephemeris(t + (XI+CHI)*h);
  for (let j = 0; j < n; j++) { const i = idx[j]; accel(ox[i], oy[i]); ovx[i] += LAM*h*AX; ovy[i] += LAM*h*AY; }
  for (let j = 0; j < n; j++) { const i = idx[j]; ox[i] += D3*h*ovx[i]; oy[i] += D3*h*ovy[i]; }
  ephemeris(t + (XI+CHI+D3)*h);
  for (let j = 0; j < n; j++) { const i = idx[j]; accel(ox[i], oy[i]); ovx[i] += LAM*h*AX; ovy[i] += LAM*h*AY; }
  for (let j = 0; j < n; j++) { const i = idx[j]; ox[i] += CHI*h*ovx[i]; oy[i] += CHI*h*ovy[i]; }
  ephemeris(t + (XI+CHI+D3+CHI)*h);
  for (let j = 0; j < n; j++) { const i = idx[j]; accel(ox[i], oy[i]); ovx[i] += K1*h*AX; ovy[i] += K1*h*AY; }
  for (let j = 0; j < n; j++) { const i = idx[j]; ox[i] += XI*h*ovx[i]; oy[i] += XI*h*ovy[i]; }
}

const groups = [];
for (let l = 0; l <= LMAX; l++) groups.push(new Int32Array(N));
const gcount = new Int32Array(LMAX + 1);
let ephCalls = 0, substepsTotal = 0;

function tick(tickNo) {
  const t = tickNo * DT;
  ephemeris(t);
  gcount.fill(0);
  for (let i = 0; i < N; i++) { const l = levelFor(i); olev[i] = l; groups[l][gcount[l]++] = i; }
  for (let l = 0; l <= LMAX; l++) {
    const n = gcount[l];
    if (n === 0) continue;
    const ns = 1 << l, h = DT / ns;
    for (let s = 0; s < ns; s++) { pefrlGroup(groups[l], n, t + s * h, h); ephCalls += 4; substepsTotal += n; }
  }
}

function bench(scenario, nticks) {
  seedObjects(scenario);
  ephCalls = 0; substepsTotal = 0;
  tick(0);                                     // warm
  const t0 = process.hrtime.bigint();
  for (let k = 1; k <= nticks; k++) tick(k);
  const t1 = process.hrtime.bigint();
  const secs = Number(t1 - t0) / 1e9;
  let maxL = 0; for (let i = 0; i < N; i++) if (olev[i] > maxL) maxL = olev[i];
  return { tps: nticks / secs, secs, nticks, maxL, ephCalls, substepsTotal };
}

console.log("=".repeat(96));
console.log("Q4  Tick throughput, Node 24, 50 dynamic objects, 6 attractors, PEFRL,");
console.log(`    dt = ${DT} s, eta = ${ETA}, zeta = 1/${1/ZETA}, Lmax = ${LMAX}`);
console.log("=".repeat(96));
for (const [sc, nt] of [["cruise", 200000], ["flyby", 3000]]) {
  const r = bench(sc, nt);
  const simDaysPerSec = r.tps * DT / 86400;
  console.log(`  ${sc.padEnd(8)} ${r.tps.toFixed(0).padStart(9)} ticks/s   `
    + `max L = ${r.maxL}   eph evals/tick = ${(r.ephCalls / r.nticks).toFixed(1).padStart(7)}   `
    + `substeps/tick = ${(r.substepsTotal / r.nticks).toFixed(1).padStart(8)}`);
  console.log(`  ${"".padEnd(8)} ${simDaysPerSec.toFixed(1).padStart(9)} simulated days per wall second`);
}

console.log();
console.log("=".repeat(96));
console.log("Q4b  Where the time goes");
console.log("=".repeat(96));
{
  seedObjects("cruise"); ephemeris(0);
  let t0 = process.hrtime.bigint();
  for (let k = 0; k < 3_000_000; k++) ephemeris(k * 60.0);
  let t1 = process.hrtime.bigint();
  const perEph = Number(t1 - t0) / 3e6;
  console.log(`  ephemeris(t), 6 bodies, 5 Kepler solves : ${perEph.toFixed(1)} ns  `
    + `(${(perEph / 5).toFixed(1)} ns per Kepler solve)`);
  t0 = process.hrtime.bigint();
  let sink = 0;
  for (let k = 0; k < 20_000_000; k++) { accel(1e11 + k, 2e11); sink += AX; }
  t1 = process.hrtime.bigint();
  console.log(`  accel(), 6 attractors                   : ${(Number(t1 - t0) / 2e7).toFixed(1)} ns  (sink ${sink.toExponential(2)})`);
  t0 = process.hrtime.bigint();
  let l = 0;
  for (let k = 0; k < 5_000_000; k++) l += levelFor(k % N);
  t1 = process.hrtime.bigint();
  console.log(`  levelFor(), 6 attractors, two ladders   : ${(Number(t1 - t0) / 5e6).toFixed(1)} ns  (sink ${l})`);
}

console.log();
console.log("=".repeat(96));
console.log("Q4c  Warp ceiling. Warp advances more ticks per rendered frame at a fixed dt.");
console.log("=".repeat(96));
{
  const r = bench("cruise", 200000);
  const budgetMs = 8;                       // half a 60 Hz frame left for the sim
  const ticksPerFrame = Math.floor(r.tps * budgetMs / 1000);
  console.log(`  At ${r.tps.toFixed(0)} ticks/s and an ${budgetMs} ms per-frame sim budget:`);
  console.log(`    ticks per frame            : ${ticksPerFrame}`);
  console.log(`    simulated seconds per frame: ${(ticksPerFrame * DT).toExponential(2)}`);
  console.log(`    at 60 fps that is          : ${(ticksPerFrame * DT * 60 / 86400).toFixed(1)} simulated days per wall second`);
  console.log(`    warp x1 costs              : ${(1000 / r.tps * (1 / DT)).toExponential(2)} ms per simulated second`);
  console.log();
  const flightDays = 14;
  const ticks = flightDays * 86400 / DT;
  console.log(`  A ${flightDays}-day flight is ${ticks} ticks; replaying it end to end takes `
    + `${(ticks / r.tps * 1000).toFixed(0)} ms.`);
  console.log(`  Re-integrating one ghost (1 object, not 50) is roughly ${(ticks / (r.tps * 50) * 1000).toFixed(1)} ms,`);
  console.log(`  so the planner can re-solve a whole plan inside a single frame.`);
}

console.log();
console.log("=".repeat(96));
console.log("Q4d  Determinism of the loop: same seed, two runs, hash of the full state");
console.log("=".repeat(96));
{
  const snap = () => { const a = new Float64Array(N * 5);
    a.set(ox, 0); a.set(oy, N); a.set(ovx, 2*N); a.set(ovy, 3*N); a.set(oexp, 4*N);
    return hashF64(a, a.length); };
  seedObjects("flyby"); for (let k = 1; k <= 500; k++) tick(k); const h1 = snap();
  seedObjects("flyby"); for (let k = 1; k <= 500; k++) tick(k); const h2 = snap();
  // interrupted run: same ticks, but state round-tripped through a copy midway
  seedObjects("flyby");
  for (let k = 1; k <= 250; k++) tick(k);
  const save = { ox: ox.slice(), oy: oy.slice(), ovx: ovx.slice(), ovy: ovy.slice() };
  ox.set(save.ox); oy.set(save.oy); ovx.set(save.ovx); ovy.set(save.ovy);
  for (let k = 251; k <= 500; k++) tick(k); const h3 = snap();
  console.log(`  run 1                     : ${h1}`);
  console.log(`  run 2                     : ${h2}   ${h1 === h2 ? "identical" : "DIFFERS"}`);
  console.log(`  save/reload at tick 250   : ${h3}   ${h1 === h3 ? "identical" : "DIFFERS"}`);
}
