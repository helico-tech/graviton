// The flown-trail ring buffer (GRV-0022 design: sampled positions, bounded, owned by the app).
import { describe, expect, test } from 'vitest';
import {
  createTrailBuffer,
  createTrailSet,
  pushTrailSample,
  sampleTrailSet,
  trailPoints,
} from './trails.ts';

describe('createTrailBuffer / pushTrailSample / trailPoints', () => {
  test('returns samples oldest-to-newest before the buffer fills', () => {
    const buffer = createTrailBuffer(5);
    pushTrailSample(buffer, 1, 10);
    pushTrailSample(buffer, 2, 20);
    pushTrailSample(buffer, 3, 30);

    expect(trailPoints(buffer)).toEqual([
      { x: 1, y: 10 },
      { x: 2, y: 20 },
      { x: 3, y: 30 },
    ]);
  });

  test('drops the oldest sample once the buffer is full (a true ring)', () => {
    const buffer = createTrailBuffer(3);
    pushTrailSample(buffer, 1, 1);
    pushTrailSample(buffer, 2, 2);
    pushTrailSample(buffer, 3, 3);
    pushTrailSample(buffer, 4, 4); // evicts (1,1)

    expect(trailPoints(buffer)).toEqual([
      { x: 2, y: 2 },
      { x: 3, y: 3 },
      { x: 4, y: 4 },
    ]);
  });

  test('an empty buffer has no points', () => {
    expect(trailPoints(createTrailBuffer(4))).toEqual([]);
  });
});

describe('sampleTrailSet', () => {
  test('creates one buffer per object index, lazily', () => {
    const trailSet = createTrailSet(4);
    sampleTrailSet(trailSet, [{ x: 1, y: 1 }]);
    sampleTrailSet(trailSet, [
      { x: 2, y: 2 },
      { x: 100, y: 100 }, // a second object (probe) launched after the first sample
    ]);

    expect(trailPoints(trailSet.buffers[0]!)).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
    expect(trailPoints(trailSet.buffers[1]!)).toEqual([{ x: 100, y: 100 }]);
  });
});
