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
// 4 (GRV-0029): the post and the light cone -- command application now depends on the post
// (Scenario.post) and solves an uplink arrival tick before taking effect; the hash domain gains
// the pending-arrivals queue and every live object's position/velocity history ring
// (docs/evidence/GRV-0029). A level whose post sits on its rail's own host (both goldens, level
// 01) sees no trajectory move -- see the evidence for the accuracy numbers and what did and did
// not change.
export const SIM_VERSION = 4;
