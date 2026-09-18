// The DOM query half (readAllReadouts) needs a browser and is covered by tests/e2e/shell.spec.ts
// instead (no jsdom in this repo's Node-environment Vitest, ADR-0002); this only covers the pure
// collector, isolated over a plain array of { key, text } as docs/work/GRV-0021 asks for.
import { describe, expect, test } from 'vitest';
import { collectReadoutEntries } from './readouts.ts';

describe('collectReadoutEntries', () => {
  test('collects every entry under its key', () => {
    expect(
      collectReadoutEntries([
        { key: 'status.time', text: 'T+00:00:00:00' },
        { key: 'status.warp', text: '0x' },
      ]),
    ).toEqual({ 'status.time': 'T+00:00:00:00', 'status.warp': '0x' });
  });

  test('an empty list collects to an empty map', () => {
    expect(collectReadoutEntries([])).toEqual({});
  });

  test('a later duplicate key wins, matching Map/object assignment semantics', () => {
    expect(
      collectReadoutEntries([
        { key: 'status.warp', text: 'stale' },
        { key: 'status.warp', text: 'fresh' },
      ]),
    ).toEqual({ 'status.warp': 'fresh' });
  });
});
