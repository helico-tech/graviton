# GRV-0004 evidence — state hash and named random streams

2026-09-17, branch `GRV-0004-hash-and-rng`.

## Golden derivation

The hash and rng goldens asserted in `src/sim/state/hash.test.ts` and
`src/sim/state/rng.test.ts` were not invented: they were produced by importing
the reference implementation,
`docs/research/2026-09-03-02-simulation-numerics-probes/q1_core.mjs`, into a
throwaway `node --input-type=module -e "…"` script and calling its
`hashF64`/`makeStream`/`sfc32` directly, e.g.:

```js
import * as K from './docs/research/2026-09-03-02-simulation-numerics-probes/q1_core.mjs';
K.hashF64(Float64Array.from([1, 2, 3, 4]), 4); // -> b1b97165225664b3
const st = K.makeStream(0xc0ffee, 'debris_ejection');
[K.sfc32(st), K.sfc32(st), K.sfc32(st), K.sfc32(st)]; // -> 094de769 08f34cb7 deffc941 1db7dd01
```

`K.hashF64([1, -0, 3.5, 1e11], 4)` and `K.hashF64([1, +0, 3.5, 1e11], 4)` both
reproduced the `10f55b836550e295` value already recorded in
`docs/research/2026-09-03-02-simulation-numerics.md` §8.1, confirming the
reference script matches its own documentation before anything was ported
from it.

Only then was the same computation re-implemented, independently, as the
`src/sim/state/hash.ts` / `rng.ts` port (see "Deviations" below), and a second
node script ran the port's own logic against the same inputs to confirm every
value above reproduces bit-for-bit. `pnpm vitest run src/sim/state` (part of
`pnpm check` below) pins these values as golden going forward.

## Deviations from the reference, and why

- **Raw bit access via `DataView`, not a runtime-endianness-detected
  `Float64Array`/`Uint32Array` alias.** The reference computes hi/lo words
  with a `LE = (f64[0]=1; u32[1]===0x3ff00000)` runtime check because typed
  arrays use platform-native endianness. `DataView.setFloat64`/`getUint32`
  fix the byte order explicitly (big-endian by default), so no runtime
  detection is needed. Verified bit-for-bit identical to the reference's
  method across `[1, -0, 0, 3.5, 1e11, NaN, -123.456, 1e-300, Infinity]`
  before porting (see golden-derivation script above).
- **NaN always throws**, not only in a dev build as ADR-0005 "Hash" says. Per
  the unit's design constraints: one comparison per double is cheap, and it
  turns a hash-mismatch mystery into an assertion at the point of failure
  rather than a silently-corrupt golden. Documented in the code comment.
- **Incremental `create`/`update*`/`digest` shape** over a plain
  `{ a, b }` state object, rather than the reference's one-shot
  `hashF64(arr, n)` function. Same twin-lane FNV-1a-style algorithm and same
  output format (two 8-hex-digit lanes concatenated); this only changes how
  callers feed it data, which lets a future unit interleave `updateFloat64Array`
  calls over several typed arrays with `updateWord` calls over the tick
  counter and rng stream words into a single hash of the whole sim state,
  matching the design brief ("also allow mixing in integer words").
  `updateWord` is new relative to the reference (which only hashes doubles in
  its state hasher); it reuses the same two lane primes, applying each once,
  which is the natural single-word specialisation of the two-word-per-lane
  double update immediately below it in the same file.
- **`updateFloat64Array` takes an optional `length`**, defaulting to the full
  array, mirroring the reference's explicit `n` parameter — needed later for
  hashing the live prefix of a capacity-sized dense array (rule 8 / §8.3:
  `count` vs `capacity`).

Everything else — the FNV-1a-style twin-lane constants and mixing order, the
`-0`→`+0` collapse, splitmix32, the sfc32 recurrence, the 12-draw stream
warm-up, and the exact-power-of-two unit conversion — is a direct, unchanged
port.

## `pnpm check` (tail)

```
$ pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit
$ eslint . --max-warnings 0
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ vitest run

 RUN  v4.1.11 /data/workspaces/graviton/.worktrees/GRV-0004-hash-and-rng


 Test Files  7 passed (7)
      Tests  24 passed (24)
   Start at  19:17:09
   Duration  2.56s (transform 254ms, setup 0ms, import 470ms, tests 2.99s, environment 0ms)
```

`pnpm docs:validate` → `docs: ok`.
