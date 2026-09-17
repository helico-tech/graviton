---
status: triaged
priority: P2
filed: 2026-09-17
filed-by: agent
work: GRV-0010
---
# Scenario probe parameters and body radius are not validated at load

## Observation

EPIC-02 review, demonstrated by script. `createSim` validates nothing in `scenario.probe`, unlike
`createBodyTable`. `thrust: 0` arms a burn that never ends (`burning` stays 1, later nodes stall);
`exhaustVelocity: 0` makes `mdot` infinite, dumps the whole tank in one kick and reports the burn
done with 0 m/s delivered. `createBodyTable` also accepts `radius: 0`; an object at such a body's
centre gets NaN from `kick`, and NaN never trips the collision test, so it is only caught at the
next `hashSim`. Validate at load: dryMass > 0, propellantMass >= 0, thrust > 0,
exhaustVelocity > 0, radius > 0, dt > 0, integer capacities.

## Resolution
