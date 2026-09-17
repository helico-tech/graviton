import * as K from "./q1_core.mjs";

const hex = (x) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); 
  return [...new Uint8Array(b.buffer)].map(v=>v.toString(16).padStart(2,'0')).join(''); };

console.log("=".repeat(92));
console.log("Q2a  Kernel accuracy against Math.*, and exact bit patterns for cross-language checks");
console.log("=".repeat(92));
let worstS = 0, worstC = 0, worstA = 0, worstE = 0, worstL = 0;
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let i = 0; i < 200000; i++) {
  const x = (rnd() * 2 - 1) * 8.2e5;
  worstS = Math.max(worstS, Math.abs(K.dsin(x) - Math.sin(x)));
  worstC = Math.max(worstC, Math.abs(K.dcos(x) - Math.cos(x)));
  const y = (rnd() * 2 - 1) * 1e6, z = (rnd() * 2 - 1) * 1e6;
  worstA = Math.max(worstA, Math.abs(K.datan2(y, z) - Math.atan2(y, z)));
  const u = (rnd() * 2 - 1) * 8;
  worstE = Math.max(worstE, Math.abs(K.dexp(u) / Math.exp(u) - 1));
  const w = Math.exp((rnd() * 2 - 1) * 20);
  worstL = Math.max(worstL, Math.abs(K.dlog(w) - Math.log(w)) / Math.abs(Math.log(w) || 1));
}
console.log(`  max |dsin  - Math.sin|      : ${worstS.toExponential(3)}  (absolute)`);
console.log(`  max |dcos  - Math.cos|      : ${worstC.toExponential(3)}  (absolute)`);
console.log(`  max |datan2 - Math.atan2|   : ${worstA.toExponential(3)}  (absolute, radians)`);
console.log(`  max |dexp/Math.exp - 1|     : ${worstE.toExponential(3)}  (relative)`);
console.log(`  max dlog relative deviation : ${worstL.toExponential(3)}`);
console.log();
console.log("  Reference bit patterns (compare against the Python probe, must match exactly):");
for (const x of [0.1, 1.0, 3.0, 100.0, 1e4, 123456.789]) {
  K.dsincos(x);
  console.log(`    x=${String(x).padEnd(12)} dsin=${hex(K.dsinOut)} dcos=${hex(K.dcosOut)}`);
}
K.solveKepler(1.0, 0.6);
console.log(`    kepler(M=1.0, e=0.6): E=${hex(K.kepE)} sinE=${hex(K.kepSin)} cosE=${hex(K.kepCos)}`);
console.log(`                          E=${K.kepE.toPrecision(17)}  residual=${(K.kepE - 0.6*K.kepSin - 1.0).toExponential(3)}`);
console.log(`    dexp(2.5)=${hex(K.dexp(2.5))}   dlog(7.5)=${hex(K.dlog(7.5))}   datan2(3,-4)=${hex(K.datan2(3,-4))}`);

console.log();
console.log("=".repeat(92));
console.log("Q2b  Kepler solver: residual and consistency over the full parameter grid");
console.log("=".repeat(92));
let wres = 0, wid = 0;
for (const e of [0, 0.1, 0.3, 0.6, 0.8, 0.9]) {
  let mr = 0, mi = 0;
  for (let i = 0; i < 4096; i++) {
    const M = 6.283185307179586 * (i + 0.5) / 4096;
    K.solveKepler(M, e);
    mr = Math.max(mr, Math.abs(K.kepE - e * K.kepSin - M));
    mi = Math.max(mi, Math.abs(K.kepSin * K.kepSin + K.kepCos * K.kepCos - 1));
  }
  console.log(`  e=${e.toFixed(1)}  max|E - e sinE - M| = ${mr.toExponential(3)}   max|s^2+c^2-1| = ${mi.toExponential(3)}`);
}

console.log();
console.log("=".repeat(92));
console.log("Q2c  Hashing: -0 canonicalisation and sensitivity to a one-ulp change");
console.log("=".repeat(92));
const a = new Float64Array([1.0, -0.0, 3.5, 1e11]);
const b = new Float64Array([1.0,  0.0, 3.5, 1e11]);
const c = new Float64Array([1.0,  0.0, 3.5, 1e11 + 0.0000152587890625]);
console.log(`  hash([1, -0, 3.5, 1e11])         = ${K.hashF64(a, 4)}`);
console.log(`  hash([1, +0, 3.5, 1e11])         = ${K.hashF64(b, 4)}   ${K.hashF64(a,4)===K.hashF64(b,4) ? "equal, as required" : "DIFFERENT - bug"}`);
console.log(`  hash with last value +1 ulp      = ${K.hashF64(c, 4)}   ${K.hashF64(b,4)!==K.hashF64(c,4) ? "differs, as required" : "COLLISION"}`);
const big = new Float64Array(60000);
for (let i = 0; i < big.length; i++) big[i] = Math.sin(i) * 1e9;
let t0 = process.hrtime.bigint();
let hh; for (let r = 0; r < 200; r++) hh = K.hashF64(big, big.length);
let t1 = process.hrtime.bigint();
console.log(`  60 000-double state hashed 200x in ${(Number(t1-t0)/1e6).toFixed(1)} ms `
  + `-> ${(Number(t1-t0)/1e6/200).toFixed(3)} ms per hash  (${hh})`);

console.log();
console.log("=".repeat(92));
console.log("Q2d  Named RNG streams: independence and reproducibility");
console.log("=".repeat(92));
for (const nm of ["debris_ejection", "sensor_noise", "hazard_onset"]) {
  const st = K.makeStream(0xC0FFEE, nm);
  const first = [];
  for (let i = 0; i < 4; i++) first.push(K.sfc32(st).toString(16).padStart(8,'0'));
  const st2 = K.makeStream(0xC0FFEE, nm);
  const again = [];
  for (let i = 0; i < 4; i++) again.push(K.sfc32(st2).toString(16).padStart(8,'0'));
  console.log(`  ${nm.padEnd(17)} ${first.join(" ")}  reproducible: ${first.join()===again.join()}`);
}
// crude uniformity / period sanity
{
  const st = K.makeStream(1, "debris_ejection");
  const bins = new Int32Array(16);
  const N = 4_000_000;
  for (let i = 0; i < N; i++) bins[(K.sfc32(st) >>> 28)]++;
  let chi = 0; const exp = N / 16;
  for (let i = 0; i < 16; i++) chi += (bins[i]-exp)*(bins[i]-exp)/exp;
  console.log(`  chi-square over 16 top-nibble bins, N=4e6: ${chi.toFixed(2)} (expect ~15, df=15)`);
  const st3 = K.makeStream(1, "debris_ejection");
  let t2 = process.hrtime.bigint();
  let acc = 0; for (let i = 0; i < 20_000_000; i++) acc ^= K.sfc32(st3);
  let t3 = process.hrtime.bigint();
  console.log(`  sfc32 throughput: ${(20 / (Number(t3-t2)/1e9)).toFixed(0)} Mdraws/s (sink ${acc>>>0})`);
}
