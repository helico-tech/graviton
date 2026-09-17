// Bumped whenever a change alters simulation results; golden logs carry it so stale goldens fail loudly.
// 2 (GRV-0014): launches now come from a rail (spin + rotation velocity +
// muzzle vector) instead of a radial placeholder -- every existing result
// that includes a launch moves.
export const SIM_VERSION = 2;
