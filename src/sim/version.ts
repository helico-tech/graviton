// Bumped whenever a change alters simulation results; golden logs carry it so stale goldens fail loudly.
// 2 (GRV-0014): launches now come from a rail (spin + rotation velocity +
// muzzle vector) instead of a radial placeholder -- every existing result
// that includes a launch moves.
// 3 (GRV-0015): fixed contacts add hitContact to the per-object hash/
// serialisation record and a contact-state record (cleared, impactTick,
// impactSpeed, impactEnergy) even for scenarios with zero contacts -- the
// hash *domain* grows, so a golden recorded under version 2 would compute a
// different hash under 3 even though no trajectory moved (verified for
// flyby-burn: the probe's final x/y/vx/vy bits are unchanged -- see
// docs/evidence/GRV-0015). Bumped so a stale golden fails loudly rather
// than silently comparing against the wrong hash domain.
export const SIM_VERSION = 3;
