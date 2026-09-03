// Issue queue tooling so frontmatter is never hand-written. Usage:
//   node scripts/issues.ts new <slug> --priority P2 --title "..." [--by agent|human]
//   node scripts/issues.ts list [--status open]
//   node scripts/issues.ts triage <file> --work GRV-NNNN
//   node scripts/issues.ts resolve <file> --work GRV-NNNN --commit <sha> [--note "..."]
//   node scripts/issues.ts wontfix <file> --note "..."
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, serializeFrontmatter } from './lib/frontmatter.ts';
import { parseFlags, repoRoot, slugify, today } from './lib/repo.ts';
import { WORK_ID } from './new-work-item.ts';

export const ISSUE_DIR = path.join(repoRoot, 'docs', 'issues');
export const STATUSES = ['open', 'triaged', 'resolved', 'wontfix'] as const;
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;

export interface IssueOptions {
  dir: string;
  slug: string;
  title: string;
  priority: string;
  filedBy?: string;
  date?: string;
}

export function createIssue({
  dir,
  slug,
  title,
  priority,
  filedBy = 'agent',
  date = today(),
}: IssueOptions): string {
  if (!(PRIORITIES as readonly string[]).includes(priority))
    throw new Error(`priority must be one of ${PRIORITIES.join(', ')}`);
  const file = path.join(dir, `${date}-${slugify(slug)}.md`);
  if (fs.existsSync(file)) throw new Error(`${file} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  const text = serializeFrontmatter({
    data: { status: 'open', priority, filed: date, 'filed-by': filedBy },
    body: `# ${title}\n\n## Observation\n\n\n## Resolution\n`,
  });
  fs.writeFileSync(file, text);
  return file;
}

export interface IssueRow {
  file: string;
  status: string;
  priority: string;
  filed: string;
  work: string;
  title: string;
}

export function listIssues(dir: string, status?: string): IssueRow[] {
  const rows: IssueRow[] = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    if (!name.endsWith('.md')) continue;
    const doc = parseFrontmatter(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (!doc) continue;
    if (status && doc.data.status !== status) continue;
    rows.push({
      file: name,
      status: doc.data.status ?? '',
      priority: doc.data.priority ?? '',
      filed: doc.data.filed ?? '',
      work: doc.data.work ?? '',
      title: /^#\s+(.*)$/m.exec(doc.body)?.[1] ?? '',
    });
  }
  return rows.sort(
    (a, b) => a.priority.localeCompare(b.priority) || a.filed.localeCompare(b.filed),
  );
}

function update(file: string, patch: Record<string, string>, appendBody = ''): void {
  const doc = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  if (!doc) throw new Error(`${file}: malformed frontmatter`);
  Object.assign(doc.data, patch);
  doc.body = doc.body.replace(/\n*$/, '\n') + appendBody;
  fs.writeFileSync(file, serializeFrontmatter(doc));
}

function requireWorkId(work: string): void {
  if (!WORK_ID.test(work)) throw new Error('--work must look like GRV-0004');
}

export function triageIssue(file: string, work: string): void {
  requireWorkId(work);
  update(file, { status: 'triaged', work });
}

export function resolveIssue(
  file: string,
  {
    work,
    commit,
    note = '',
    date = today(),
  }: { work: string; commit: string; note?: string; date?: string },
): void {
  requireWorkId(work);
  update(
    file,
    { status: 'resolved', work },
    `\n**Resolved ${date}** in ${work}, commit ${commit}. ${note}\n`,
  );
}

export function wontfixIssue(
  file: string,
  { note, date = today() }: { note: string; date?: string },
): void {
  update(file, { status: 'wontfix' }, `\n**Won't fix ${date}.** ${note}\n`);
}

function resolveFile(arg: string): string {
  return path.isAbsolute(arg)
    ? arg
    : fs.existsSync(arg)
      ? path.resolve(arg)
      : path.join(ISSUE_DIR, arg);
}

if (import.meta.main) {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const [cmd, arg] = positional;
  try {
    switch (cmd) {
      case 'new': {
        if (!arg) throw new Error('missing slug');
        const file = createIssue({
          dir: ISSUE_DIR,
          slug: arg,
          title: flags.title ?? arg,
          priority: flags.priority ?? 'P2',
          filedBy: flags.by ?? 'agent',
        });
        console.log(path.relative(repoRoot, file));
        break;
      }
      case 'list': {
        const rows = listIssues(ISSUE_DIR, flags.status);
        if (rows.length === 0) console.log('no issues');
        for (const r of rows)
          console.log(
            `${r.priority}  ${r.status.padEnd(8)}  ${r.filed}  ${r.work.padEnd(8)}  ${r.file}  ${r.title}`,
          );
        break;
      }
      case 'triage':
        if (!arg || !flags.work) throw new Error('usage: triage <file> --work GRV-NNNN');
        triageIssue(resolveFile(arg), flags.work);
        break;
      case 'resolve':
        if (!arg || !flags.work || !flags.commit)
          throw new Error('usage: resolve <file> --work GRV-NNNN --commit <sha> [--note "..."]');
        resolveIssue(resolveFile(arg), {
          work: flags.work,
          commit: flags.commit,
          note: flags.note,
        });
        break;
      case 'wontfix':
        if (!arg || !flags.note) throw new Error('usage: wontfix <file> --note "..."');
        wontfixIssue(resolveFile(arg), { note: flags.note });
        break;
      default:
        console.error('commands: new, list, triage, resolve, wontfix');
        process.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
