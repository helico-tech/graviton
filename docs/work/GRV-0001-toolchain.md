---
id: GRV-0001
epic: EPIC-01
status: done
---
# GRV-0001 Toolchain, quality gates and repo scripts

**Goal.** A clean clone installs, typechecks, lints, formats, tests and builds
with one command each, and the knowledge-base scripts exist so no ID or
frontmatter is ever hand-written.

**Files.** `package.json`, `tsconfig.json`, `tsconfig.sim.json`,
`vite.config.ts`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`,
`index.html`, `src/app/main.ts`, `scripts/lib/{repo,frontmatter}.ts`,
`scripts/{new-work-item,issues,validate-docs}.ts` with tests,
`scripts/git-hooks/pre-push`, `src/sim/lint-gate.test.ts`,
`.github/workflows/{ci,pages}.yml`.

**Acceptance.**
- `pnpm check` and `pnpm docs:validate` pass; `pnpm build` emits `dist/`.
- The ESLint guard-rails for `src/sim` fire on transcendental Math, `**`,
  clocks and outside imports, and stay silent elsewhere (tested).
- `node scripts/new-work-item.ts`, `node scripts/issues.ts` and
  `node scripts/validate-docs.ts` run with plain Node.
- The pre-push hook is installed by `pnpm install` (`prepare`).

**Verification.** `pnpm install && pnpm check && pnpm docs:validate && pnpm build`.

**Delivered.** Branch `GRV-0001-toolchain`; evidence in `docs/evidence/GRV-0001/`.
CI and Pages verification are GRV-0002.
