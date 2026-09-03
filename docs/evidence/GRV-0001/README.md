# GRV-0001 evidence — toolchain

Commands run on 2026-09-03 from the working tree after `pnpm install` (2.2 s,
pnpm 11.25.0, Node 24.14):

```
$ pnpm check
tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sim.json --noEmit   ok
eslint . --max-warnings 0                                            ok
prettier --check .                                                   All matched files use Prettier code style!
vitest run                                                           Test Files 5 passed, Tests 12 passed, 822 ms
$ pnpm docs:validate
docs: ok
$ pnpm build
dist/index.html 0.74 kB, dist/assets/index-*.js 0.79 kB, built in 35 ms
```

- The lint-gate test proves the `src/sim` guard-rails fire: two
  `no-restricted-properties` hits (`Math.sin`, `Math.pow`), `no-restricted-syntax`
  for `**`, `no-restricted-globals` for `Date`, and two `no-restricted-imports`
  hits (a `../render` path and a package), while the same code lints clean
  under `src/render`.
- `git config core.hooksPath` prints `scripts/git-hooks`, installed by
  `prepare`.
- `node_modules` is 100 MB; no runtime dependency ships besides the two font
  packages.
