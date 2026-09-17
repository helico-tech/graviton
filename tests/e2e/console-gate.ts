// The gate's implementation lives in scripts/lib/console-gate.ts so it can be
// shared with scripts/screenshot.ts without tests/e2e depending on scripts
// depending back on tests/e2e (docs/work/GRV-0012).
export * from '../../scripts/lib/console-gate.ts';
