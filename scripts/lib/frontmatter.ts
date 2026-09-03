/** Minimal frontmatter: `---`, `key: value` lines, `---`, then the body. Values are strings. */
export interface Document {
  data: Record<string, string>;
  body: string;
}

export function parseFrontmatter(text: string): Document | null {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const data: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) return null;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .replace(/\s+#.*$/, '')
      .trim();
    data[key] = value;
  }
  const bodyStart = end + '\n---'.length;
  return { data, body: text.slice(bodyStart).replace(/^\n/, '') };
}

export function serializeFrontmatter({ data, body }: Document): string {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}
