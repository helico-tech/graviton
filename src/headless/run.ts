// Node CLI: runs a golden scenario headless and reports the result
// (docs/work/GRV-0008). Usage: `node src/headless/run.ts <golden.json>`.
// Outside src/sim, so console and node builtins are fine (ADR-0002).
import fs from 'node:fs';
import { advance, createSim, hashSim } from '../sim/sim.ts';
import type { Command, Scenario } from '../sim/sim.ts';
import { SIM_VERSION } from '../sim/version.ts';

interface GoldenFile {
  scenario: Scenario;
  seed: number;
  log: Command[];
  ticks: number;
  expectedHash: string;
  simVersion: number;
}

export interface ContactResult {
  cleared: number;
  impactTick: number;
  impactSpeed: number;
  impactEnergy: number;
}

export function runGolden(golden: GoldenFile): {
  hash: string;
  ticksPerSecond: number;
  contacts: ContactResult[];
} {
  if (golden.simVersion !== SIM_VERSION) {
    throw new Error(
      `golden was recorded for sim version ${golden.simVersion}, running ${SIM_VERSION}`,
    );
  }
  const sim = createSim({ scenario: golden.scenario, seed: golden.seed });
  const startNs = process.hrtime.bigint();
  advance({ sim, log: golden.log, ticks: golden.ticks });
  const elapsedS = Number(process.hrtime.bigint() - startNs) / 1e9;

  const cs = sim.contactState;
  const contacts: ContactResult[] = [];
  for (let i = 0; i < sim.contacts.count; i++) {
    contacts.push({
      cleared: cs.cleared[i]!,
      impactTick: cs.impactTick[i]!,
      impactSpeed: cs.impactSpeed[i]!,
      impactEnergy: cs.impactEnergy[i]!,
    });
  }

  return { hash: hashSim(sim), ticksPerSecond: golden.ticks / elapsedS, contacts };
}

function main(argv: string[]): number {
  const path = argv[2];
  if (!path) {
    console.error('usage: node src/headless/run.ts <golden.json>');
    return 2;
  }
  const golden = JSON.parse(fs.readFileSync(path, 'utf8')) as GoldenFile;
  const { hash, ticksPerSecond, contacts } = runGolden(golden);
  const matched = hash === golden.expectedHash;

  console.info(`tick ${golden.ticks}`);
  console.info(`hash ${hash}`);
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i]!;
    console.info(
      `contact ${i} cleared=${c.cleared} impactTick=${c.impactTick} ` +
        `impactSpeed=${c.impactSpeed.toFixed(3)} impactEnergy=${c.impactEnergy.toExponential(3)}`,
    );
  }
  console.info(matched ? 'MATCH' : 'MISMATCH');
  console.info(`${ticksPerSecond.toFixed(1)} ticks/s`);

  return matched ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main(process.argv));
}
