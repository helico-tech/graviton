// Collects every data-readout element's text (ADR-0004 §2): verifiers assert the displayed
// string itself, so a green simulation with a broken panel still fails. `readAllReadouts` is the
// thin, DOM-touching edge; `collectReadoutEntries` is the pure part the unit tests cover.
export interface ReadoutEntry {
  key: string;
  text: string;
}

export function collectReadoutEntries(entries: readonly ReadoutEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) out[entry.key] = entry.text;
  return out;
}

export function readAllReadouts(root: ParentNode): Record<string, string> {
  const entries: ReadoutEntry[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-readout]')) {
    const key = el.dataset.readout;
    if (key) entries.push({ key, text: el.textContent ?? '' });
  }
  return collectReadoutEntries(entries);
}
