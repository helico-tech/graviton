// Selection-panel units, chosen to read well rather than to preserve every digit the sim carries
// (GRV-0023 acceptance): km with thousands separated by a thin space, km/s to 2 decimals,
// hours/days for durations, degrees to 1 decimal. `docs/app/time.ts`'s `formatSimTime` stays the
// one place that formats a tick as `T+dd:hh:mm:ss`; this module never duplicates it.
const THIN_SPACE = ' ';
const TWO_PI = Math.PI * 2;

/** Groups a rounded integer's digits in threes from the right, thin-space separated -- shared by
 *  every large-magnitude readout (km, kg) rather than reimplemented per unit. */
function groupThousands(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = Math.abs(rounded).toString();
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3)
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return sign + groups.join(THIN_SPACE);
}

export function formatKilometres(metres: number): string {
  return `${groupThousands(metres / 1000)} km`;
}

export function formatKilometresPerSecond(metresPerSecond: number): string {
  return `${(metresPerSecond / 1000).toFixed(2)} km/s`;
}

/** Normalises into [0, 2pi) before converting, so a raw phase or angle outside that range (a
 *  rail's surface angle rotates past 2pi over a long flight) still reads as a plain bearing. */
export function formatDegrees(radians: number): string {
  const normalised = ((radians % TWO_PI) + TWO_PI) % TWO_PI;
  return `${((normalised * 180) / Math.PI).toFixed(1)}°`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Coarsest unit that still reads at a glance: seconds under a minute, whole minutes under an
 *  hour, hours and minutes under a day, then days and hours -- a reload timer and an orbital
 *  period both live comfortably in this range. */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const totalMinutes = Math.floor(total / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours}h ${pad2(minutes)}m`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d ${pad2(hours)}h`;
}

export function formatKilograms(kg: number): string {
  return `${groupThousands(kg)} kg`;
}

/** 1/2/5-free "fewest digits" rule (mirrors src/render/camera.ts's formatMetres): 3 significant
 *  figures, whichever of J/kJ/MJ/GJ/TJ needs the fewest of them. Contact energies in this campaign
 *  sit in the TJ band (L01-intercept's minimum is 5 TJ). */
const JOULE_UNITS: readonly { threshold: number; divisor: number; suffix: string }[] = [
  { threshold: 1e12, divisor: 1e12, suffix: 'TJ' },
  { threshold: 1e9, divisor: 1e9, suffix: 'GJ' },
  { threshold: 1e6, divisor: 1e6, suffix: 'MJ' },
  { threshold: 1e3, divisor: 1e3, suffix: 'kJ' },
];

function trimNumber(value: number): string {
  return String(Number(value.toPrecision(3)));
}

export function formatJoules(joules: number): string {
  for (const { threshold, divisor, suffix } of JOULE_UNITS) {
    if (joules >= threshold) return `${trimNumber(joules / divisor)} ${suffix}`;
  }
  return `${trimNumber(joules)} J`;
}
