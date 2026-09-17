// sfc32 named random streams, seeded from splitmix32(seed ^ fnv(name))
// (ADR-0005 "Randomness"; rule 6 of docs/domain/simulation-determinism.md). A
// stream's state is exactly four uint32 words so it serialises with the rest
// of the sim state, and drawing mutates it explicitly in place.

const NAME_HASH_OFFSET = 0x811c9dc5 | 0;
const NAME_HASH_PRIME = 0x01000193;

// Classic single-lane FNV-1a over char codes, not the twin-lane state hash in
// ./hash.ts: this only needs to fold a name into one seed word. No
// TextEncoder (banned platform global in src/sim), so char codes directly.
function hashStreamName(name: string): number {
  let hash = NAME_HASH_OFFSET;
  for (let i = 0; i < name.length; i++) {
    hash = Math.imul(hash ^ name.charCodeAt(i), NAME_HASH_PRIME);
  }
  return hash;
}

function createSplitMix32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

// splitmix32's own first outputs are weakly mixed; discarding sfc32's first
// dozen draws before returning the stream lets its state decorrelate first.
const WARMUP_DRAWS = 12;

export function createStream({ seed, name }: { seed: number; name: string }): Uint32Array {
  const next = createSplitMix32((seed ^ hashStreamName(name)) | 0);
  const state = new Uint32Array([next(), next(), next(), next()]);
  for (let i = 0; i < WARMUP_DRAWS; i++) drawU32(state);
  return state;
}

/** sfc32 (Doty-Humphrey, PractRand). Mutates the four words in place. */
export function drawU32(state: Uint32Array): number {
  const a = state[0]!;
  const b = state[1]!;
  const c = state[2]!;
  const d = state[3]!;
  const t = (((a + b) | 0) + d) | 0;
  state[3] = (d + 1) | 0;
  state[0] = b ^ (b >>> 9);
  state[1] = (c + (c << 3)) | 0;
  state[2] = (((c << 21) | (c >>> 11)) + t) | 0;
  return t >>> 0;
}

/** Uniform float in [0, 1). Division by 2^32 is exact: no rounding. */
export function drawUnit(state: Uint32Array): number {
  return drawU32(state) / 4294967296;
}
