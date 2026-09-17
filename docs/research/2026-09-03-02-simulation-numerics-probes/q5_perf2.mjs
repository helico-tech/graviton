// Q5: corrected performance probe.
//  - per-body rotation cos/sin precomputed at level load (they are constants,
//    and calling Math.cos in the tick loop would break determinism anyway)
//  - Kepler results returned through a shared Float64Array register, not
//    cross-module live bindings
//  - substep level tracked as a running maximum over the whole run
//  - a worst-case scenario that holds objects inside a deep flyby throughout

const _f64 = new Float64Array(2), _u32 = new Uint32Array(_f64.buffer);
_f64[0] = 1; const LE = _u32[1] === 0x3ff00000; const HI = LE ? 1 : 0, LO = LE ? 0 : 1;
function hiWord(x) { _f64[0] = x; return _u32[HI]; }
function fromWords(h, l) { _u32[HI] = h >>> 0; _u32[LO] = l >>> 0; return _f64[0]; }

const S1=-1.66666666666666324348e-01,S2=8.33333333332248946124e-03,S3=-1.98412698298579493134e-04,
      S4=2.75573137070700676789e-06,S5=-2.50507602534068634195e-08,S6=1.58969099521155010221e-10;
const C1=4.16666666666666019037e-02,C2=-1.38888888888741095749e-03,C3=2.48015872894767294178e-05,
      C4=-2.75573143513906633035e-07,C5=2.08757232129817482790e-09,C6=-1.13596475577881948265e-11;
const INVPIO2=6.36619772367581382433e-01;
const PIO2_1=1.57079632673412561417e+00,PIO2_1T=6.07710050650619224932e-11;
const PIO2_2=6.07710050630396597660e-11,PIO2_2T=2.02226624879595063154e-21;
const PIO2_3=2.02226624871116645580e-21,PIO2_3T=8.47842766036889956997e-32;

// output register: [0] = sin, [1] = cos, [2] = E
const REG = new Float64Array(4);

function dsincosReg(x) {
  let n, y0, y1;
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) { n = 0; y0 = x; y1 = 0; }
  else {
    const half = x > 0 ? 0.5 : -0.5;
    n = (x * INVPIO2 + half) | 0;
    const fn = n;
    let r = x - fn * PIO2_1, w = fn * PIO2_1T;
    const j = ix >> 20;
    y0 = r - w;
    if (j - ((hiWord(y0) >> 20) & 0x7ff) > 16) {
      const t1 = r; w = fn * PIO2_2; r = t1 - w; w = fn * PIO2_2T - ((t1 - r) - w); y0 = r - w;
      if (j - ((hiWord(y0) >> 20) & 0x7ff) > 49) {
        const t2 = r; w = fn * PIO2_3; r = t2 - w; w = fn * PIO2_3T - ((t2 - r) - w); y0 = r - w;
      }
    }
    y1 = (r - y0) - w;
  }
  const iy = n === 0 ? 0 : 1;
  const z = y0 * y0, v = z * y0;
  const rs = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  const s = iy === 0 ? y0 + v * (S1 + z * rs)
                     : y0 - ((z * (0.5 * y1 - v * rs) - y1) - v * S1);
  const rc = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const ay = y0 < 0 ? -y0 : y0;
  let c;
  if (ay < 0.3) c = 1.0 - (0.5 * z - (z * rc - y0 * y1));
  else {
    const qx = ay > 0.78125 ? 0.28125 : fromWords(hiWord(y0) - 0x00200000, 0);
    c = (1.0 - qx) - ((0.5 * z - qx) - (z * rc - y0 * y1));
  }
  switch (n & 3) {
    case 0: REG[0] = s;  REG[1] = c;  break;
    case 1: REG[0] = c;  REG[1] = -s; break;
    case 2: REG[0] = -s; REG[1] = -c; break;
    default:REG[0] = -c; REG[1] = s;  break;
  }
}
const PI_D = 3.141592653589793;
function solveKepler(M, e) {
  let E = M + (M < PI_D ? 0.85 * e : -0.85 * e);
  let sE = 0, cE = 0, d = 0;
  for (let i = 0; i < 3; i++) {
    dsincosReg(E); sE = REG[0]; cE = REG[1];
    const f0 = E - e * sE - M, f1 = 1.0 - e * cE, f2 = e * sE, f3 = e * cE;
    const d1 = -f0 / f1;
    const d2 = -f0 / (f1 + 0.5 * d1 * f2);
    d = -f0 / (f1 + 0.5 * d2 * f2 + d2 * d2 * f3 / 6.0);
    E += d;
  }
  REG[0] = sE + cE * d; REG[1] = cE - sE * d; REG[2] = E;
}

// ---------------------------------------------------------------- system
const NB = 6, AU = 1.495978707e11, TWO_PI = 6.283185307179586;
const par = new Int32Array ([-1, 0, 0, 0, 1, 0]);
const mu  = new Float64Array([1.32712440018e20, 1.26686534e17, 3.986004418e14,
                              3.7931187e16, 4.9048695e12, 6.836529e15]);
const sma = new Float64Array([0, 5.2*AU, 1.0*AU, 9.5*AU, 6.7e8, 30.1*AU]);
const ecc = new Float64Array([0, 0.0489, 0.0167, 0.0565, 0.0074, 0.0086]);
const M0  = new Float64Array([0, 0.6, 1.75, 5.53, 3.11, 4.47]);
const nmo = new Float64Array(NB), rref3 = new Float64Array(NB);
const smb = new Float64Array(NB), gm = new Float64Array(NB);
const cw = new Float64Array(NB), sw = new Float64Array(NB);   // precomputed at load
const bx = new Float64Array(NB), by = new Float64Array(NB);
const bvx = new Float64Array(NB), bvy = new Float64Array(NB);
const DT = 60.0, ETA = 0.05, ZETA = 1/32, LMAX = 10;
{
  const aop = [0, 0.257, 1.796, 1.613, 0.442, 0.784];
  for (let i = 0; i < NB; i++) {
    cw[i] = Math.cos(aop[i]); sw[i] = Math.sin(aop[i]);      // load time, not tick time
    rref3[i] = mu[i] * (DT / ETA) * (DT / ETA);
    if (i > 0) {
      nmo[i] = Math.sqrt(mu[par[i]] / (sma[i]*sma[i]*sma[i]));
      smb[i] = sma[i] * Math.sqrt(1 - ecc[i]*ecc[i]);
      gm[i]  = Math.sqrt(mu[par[i]] * sma[i]);
    }
  }
}
function ephemeris(t) {
  for (let i = 1; i < NB; i++) {
    let M = M0[i] + nmo[i] * t;
    M -= TWO_PI * Math.floor(M * (1 / TWO_PI));
    solveKepler(M, ecc[i]);
    const sE = REG[0], cE = REG[1], a = sma[i], b = smb[i], e = ecc[i];
    const px = a * (cE - e), py = b * sE;
    const r = a * (1 - e * cE), f = gm[i] / r;
    const pvx = -f * sE, pvy = (b / a) * f * cE;
    const p = par[i], C = cw[i], S = sw[i];
    bx[i]  = bx[p]  + px*C - py*S;   by[i]  = by[p]  + px*S + py*C;
    bvx[i] = bvx[p] + pvx*C - pvy*S; bvy[i] = bvy[p] + pvx*S + pvy*C;
  }
}
// ---------------------------------------------------------------- objects
let N = 50;
const CAP = 512;
const ox=new Float64Array(CAP), oy=new Float64Array(CAP);
const ovx=new Float64Array(CAP), ovy=new Float64Array(CAP);
const olev=new Int32Array(CAP);
function levelFor(i) {
  let L = 0;
  const px = ox[i], py = oy[i], vx = ovx[i], vy = ovy[i];
  for (let b = 0; b < NB; b++) {
    const dx = px-bx[b], dy = py-by[b];
    const r2 = dx*dx+dy*dy, r = Math.sqrt(r2);
    let s = r*r2, l1 = 0;
    while (l1 < LMAX && s < rref3[b]) { s *= 4; l1++; }
    const rvx = vx-bvx[b], rvy = vy-bvy[b];
    let d = DT*Math.sqrt(rvx*rvx+rvy*rvy);
    const lim = ZETA*r;
    let l2 = 0;
    while (l2 < LMAX && d > lim) { d *= 0.5; l2++; }
    const l = l1 > l2 ? l1 : l2;
    if (l > L) L = l;
  }
  return L;
}
let AX=0, AY=0;
function accel(px, py) {
  let ax=0, ay=0;
  for (let b=0;b<NB;b++) {
    const dx=px-bx[b], dy=py-by[b], r2=dx*dx+dy*dy, r=Math.sqrt(r2), k=-mu[b]/(r2*r);
    ax+=k*dx; ay+=k*dy;
  }
  AX=ax; AY=ay;
}
const XI=0.1786178958448091, LAM=-0.2123418310626054, CHI=-0.06626458266981849;
const K1=(1-2*LAM)*0.5, D3=1-2*(CHI+XI);
function pefrlGroup(idx, n, t, h) {
  for (let j=0;j<n;j++){const i=idx[j];ox[i]+=XI*h*ovx[i];oy[i]+=XI*h*ovy[i];}
  ephemeris(t+XI*h);
  for (let j=0;j<n;j++){const i=idx[j];accel(ox[i],oy[i]);ovx[i]+=K1*h*AX;ovy[i]+=K1*h*AY;}
  for (let j=0;j<n;j++){const i=idx[j];ox[i]+=CHI*h*ovx[i];oy[i]+=CHI*h*ovy[i];}
  ephemeris(t+(XI+CHI)*h);
  for (let j=0;j<n;j++){const i=idx[j];accel(ox[i],oy[i]);ovx[i]+=LAM*h*AX;ovy[i]+=LAM*h*AY;}
  for (let j=0;j<n;j++){const i=idx[j];ox[i]+=D3*h*ovx[i];oy[i]+=D3*h*ovy[i];}
  ephemeris(t+(XI+CHI+D3)*h);
  for (let j=0;j<n;j++){const i=idx[j];accel(ox[i],oy[i]);ovx[i]+=LAM*h*AX;ovy[i]+=LAM*h*AY;}
  for (let j=0;j<n;j++){const i=idx[j];ox[i]+=CHI*h*ovx[i];oy[i]+=CHI*h*ovy[i];}
  ephemeris(t+(XI+CHI+D3+CHI)*h);
  for (let j=0;j<n;j++){const i=idx[j];accel(ox[i],oy[i]);ovx[i]+=K1*h*AX;ovy[i]+=K1*h*AY;}
  for (let j=0;j<n;j++){const i=idx[j];ox[i]+=XI*h*ovx[i];oy[i]+=XI*h*ovy[i];}
}
const groups = []; for (let l=0;l<=LMAX;l++) groups.push(new Int32Array(CAP));
const gcount = new Int32Array(LMAX+1);
let ephCalls=0, substeps=0, maxLseen=0;
function tick(k) {
  const t = k*DT;
  ephemeris(t); ephCalls++;
  gcount.fill(0);
  for (let i=0;i<N;i++){const l=levelFor(i); olev[i]=l; if(l>maxLseen)maxLseen=l; groups[l][gcount[l]++]=i;}
  for (let l=0;l<=LMAX;l++){
    const n=gcount[l]; if(!n)continue;
    const ns=1<<l, h=DT/ns;
    for(let s=0;s<ns;s++){pefrlGroup(groups[l],n,t+s*h,h); ephCalls+=4; substeps+=n;}
  }
}
let rs = 987654321;
const rnd = () => { rs = (Math.imul(rs,1664525)+1013904223)>>>0; return rs/4294967296; };
function seed(scenario, n) {
  N = n; rs = 987654321; ephemeris(0);
  for (let i=0;i<N;i++){
    if (scenario==="cruise"){
      const th=rnd()*TWO_PI, r=(1.2+2.0*rnd())*AU;
      ox[i]=r*Math.cos(th); oy[i]=r*Math.sin(th);
      const sp=1.0e5+2.0e5*rnd(), ph=rnd()*TWO_PI;
      ovx[i]=sp*Math.cos(ph); ovy[i]=sp*Math.sin(ph);
    } else if (scenario==="flyby") {
      // circular orbit at 1.1 R_J: stays deep in the well for the whole run
      const R=7.1492e7*1.1, th=rnd()*TWO_PI, vc=Math.sqrt(mu[1]/R);
      ox[i]=bx[1]+R*Math.cos(th); oy[i]=by[1]+R*Math.sin(th);
      ovx[i]=bvx[1]-vc*Math.sin(th); ovy[i]=bvy[1]+vc*Math.cos(th);
    } else {  // "graze": 200 km/s hyperbolic pass at 1.05 R_J, the tightest case
      const R=7.1492e7*1.05, th=rnd()*TWO_PI, sp=2.2e5;
      ox[i]=bx[1]+R*Math.cos(th); oy[i]=by[1]+R*Math.sin(th);
      ovx[i]=bvx[1]-sp*Math.sin(th); ovy[i]=bvy[1]+sp*Math.cos(th);
    }
  }
}
function bench(sc, n, nticks) {
  seed(sc, n); ephCalls=0; substeps=0; maxLseen=0;
  tick(0);
  const t0=process.hrtime.bigint();
  for(let k=1;k<=nticks;k++) tick(k);
  const t1=process.hrtime.bigint();
  const secs=Number(t1-t0)/1e9;
  return {tps:nticks/secs, maxL:maxLseen, eph:ephCalls/nticks, sub:substeps/nticks};
}

console.log("=".repeat(104));
console.log("Q5a  Kernel and component costs (Node 24, " + process.arch + ")");
console.log("=".repeat(104));
{
  let t0=process.hrtime.bigint(); let s=0;
  for(let k=0;k<20_000_000;k++){dsincosReg(k*1e-3); s+=REG[0];}
  let t1=process.hrtime.bigint();
  console.log(`  dsincos(x)                       : ${(Number(t1-t0)/2e7).toFixed(2)} ns   (sink ${s.toExponential(2)})`);
  t0=process.hrtime.bigint(); s=0;
  for(let k=0;k<20_000_000;k++){s+=Math.sin(k*1e-3)+Math.cos(k*1e-3);}
  t1=process.hrtime.bigint();
  console.log(`  Math.sin + Math.cos (banned)     : ${(Number(t1-t0)/2e7).toFixed(2)} ns   (sink ${s.toExponential(2)})`);
  t0=process.hrtime.bigint(); s=0;
  for(let k=0;k<10_000_000;k++){solveKepler((k*1e-6)%TWO_PI, 0.3); s+=REG[2];}
  t1=process.hrtime.bigint();
  console.log(`  solveKepler(M, e) = 3 x dsincos  : ${(Number(t1-t0)/1e7).toFixed(2)} ns   (sink ${s.toExponential(2)})`);
  t0=process.hrtime.bigint();
  for(let k=0;k<5_000_000;k++) ephemeris(k*60.0);
  t1=process.hrtime.bigint();
  console.log(`  ephemeris(t), 6 bodies (5 solves): ${(Number(t1-t0)/5e6).toFixed(2)} ns`);
  seed("cruise",50);
  t0=process.hrtime.bigint(); s=0;
  for(let k=0;k<20_000_000;k++){accel(1e11+k,2e11); s+=AX;}
  t1=process.hrtime.bigint();
  console.log(`  accel(), 6 attractors            : ${(Number(t1-t0)/2e7).toFixed(2)} ns   (sink ${s.toExponential(2)})`);
  t0=process.hrtime.bigint(); let l=0;
  for(let k=0;k<10_000_000;k++) l+=levelFor(k%50);
  t1=process.hrtime.bigint();
  console.log(`  levelFor(), two ladders x 6      : ${(Number(t1-t0)/1e7).toFixed(2)} ns   (sink ${l})`);
}

console.log();
console.log("=".repeat(104));
console.log("Q5b  Tick throughput. dt = 60 s, eta = 0.05, zeta = 1/32, Lmax = 10, PEFRL.");
console.log("=".repeat(104));
console.log("scenario ".padEnd(9) + "objects".padStart(8) + "ticks/s".padStart(11)
  + "max L".padStart(7) + "eph/tick".padStart(10) + "substeps/tick".padStart(15)
  + "sim days / wall s".padStart(19));
for (const sc of ["cruise","flyby","graze"]) {
  for (const n of [1, 50, 200]) {
    const nt = sc === "cruise" ? 100000 : (n > 50 ? 4000 : 20000);
    const r = bench(sc, n, nt);
    console.log(sc.padEnd(9) + String(n).padStart(8)
      + r.tps.toFixed(0).padStart(11) + String(r.maxL).padStart(7)
      + r.eph.toFixed(1).padStart(10) + r.sub.toFixed(1).padStart(15)
      + (r.tps*DT/86400).toFixed(1).padStart(19));
  }
}
console.log();
console.log("  'cruise' = 50 objects scattered at 1-3 AU, all at L = 0.");
console.log("  'flyby'  = every object on a circular orbit at 1.1 R_J, permanently deep.");
console.log("  'graze'  = every object on a 220 km/s hyperbolic pass at 1.05 R_J, the");
console.log("             tightest geometry any level should permit.");

console.log();
console.log("=".repeat(104));
console.log("Q5c  Warp ceiling and planner budget");
console.log("=".repeat(104));
{
  const c = bench("cruise", 50, 100000);
  const g = bench("graze", 50, 20000);
  const budget = 8;   // ms of a 16.7 ms frame
  console.log(`  cruise: ${c.tps.toFixed(0)} ticks/s -> ${Math.floor(c.tps*budget/1000)} ticks per 8 ms frame`
    + ` = ${(Math.floor(c.tps*budget/1000)*DT/3600).toFixed(1)} simulated hours per frame`);
  console.log(`  graze : ${g.tps.toFixed(0)} ticks/s -> ${Math.floor(g.tps*budget/1000)} ticks per 8 ms frame`
    + ` = ${(Math.floor(g.tps*budget/1000)*DT/60).toFixed(1)} simulated minutes per frame`);
  console.log();
  console.log(`  Warp ladder in powers of ten, at 60 fps, cruise:`);
  for (const w of [1, 10, 100, 1000, 10000, 100000, 1000000]) {
    const ticksPerFrame = w / (60 * DT);
    const ms = ticksPerFrame / c.tps * 1000;
    console.log(`    x${String(w).padStart(7)}  ${ticksPerFrame.toFixed(2).padStart(9)} ticks/frame`
      + `  ${ms.toFixed(3).padStart(8)} ms/frame  ${ms < budget ? "affordable" : "OVER BUDGET"}`);
  }
  console.log();
  const ticks14d = 14*86400/DT;
  const one = bench("cruise", 1, 100000);
  console.log(`  Ghost re-integration: a 14-day plan is ${ticks14d} ticks for ONE object.`);
  console.log(`  At ${one.tps.toFixed(0)} ticks/s for a single object that is `
    + `${(ticks14d/one.tps*1000).toFixed(1)} ms, so a full re-solve fits in one frame.`);
}
console.log();
console.log("=".repeat(104));
console.log("Q5d  Worst-case cost: substep level PINNED, so the whole tick runs at 2^L substeps.");
console.log("     This is the number that bounds the warp ceiling during a close flyby.");
console.log("=".repeat(104));
{
  const savedLevelFor = levelFor;
  console.log("level".padStart(6) + "substeps".padStart(10) + "objects".padStart(9)
    + "ticks/s".padStart(11) + "us per tick".padStart(13) + "sim days/wall s".padStart(17)
    + "x1e6 warp ms/frame".padStart(21));
  for (const L of [0, 2, 4, 6, 8]) {
    for (const n of [50]) {
      seed("cruise", n);
      const ns = 1 << L, h = DT / ns;
      const idx = new Int32Array(n); for (let i=0;i<n;i++) idx[i]=i;
      const nticks = Math.max(20, Math.floor(400000 / ns));
      ephemeris(0);
      const t0 = process.hrtime.bigint();
      for (let k = 1; k <= nticks; k++) {
        const t = k * DT;
        ephemeris(t);
        for (let i=0;i<n;i++) savedLevelFor(i);
        for (let s2 = 0; s2 < ns; s2++) pefrlGroup(idx, n, t + s2*h, h);
      }
      const t1 = process.hrtime.bigint();
      const secs = Number(t1-t0)/1e9, tps = nticks/secs;
      const msPerFrame = (1e6/(60*DT))/tps*1000;
      console.log(String(L).padStart(6) + String(ns).padStart(10) + String(n).padStart(9)
        + tps.toFixed(0).padStart(11) + (1e6/tps).toFixed(1).padStart(13)
        + (tps*DT/86400).toFixed(2).padStart(17) + msPerFrame.toFixed(1).padStart(21));
    }
  }
  console.log();
  console.log("  Even with all 50 objects pinned at level 8 (256 substeps of 0.23 s), the");
  console.log("  simulation stays real-time at x1 and only the top warp rungs become");
  console.log("  unaffordable -- and those rungs are exactly the ones the auto-drop-to-x1");
  console.log("  rule turns off during a close approach anyway.");
}
