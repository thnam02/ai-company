import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { CheckResult } from '@ai-company/core';
import type { Workspace } from './workspace.ts';

/** Check rules, set by the CEO in the company config (`checks`). */
export interface CheckSettings {
  content: {
    /** Fewest words a content file may have. */
    minWords: number;
    maxWords: number;
  };
  email: {
    /** Addresses ("ceo@example.com") or domains ("@example.com") an email may go to. Empty: any. */
    allowedRecipients: string[];
    maxBodyWords: number;
  };
}

export const DEFAULT_CHECK_SETTINGS: CheckSettings = {
  content: { minWords: 1, maxWords: 5_000 },
  email: { allowedRecipients: [], maxBodyWords: 1_000 },
};

/** What a submission put forward: the files it produced and the action it proposes. */
export interface Submitted {
  artifacts: string[];
  finalAction: { tool: string; input: unknown } | null;
}

/** Files checked as content (documents). Code gets its own checks later (tests, lint, build). */
const CONTENT_EXTENSIONS = new Set(['', '.md', '.markdown', '.txt', '.html', '.htm', '.rst']);
const MAX_CHECKED_BYTES = 200_000;
/** All files of one submission together; past this the rest are not read. */
const MAX_SUBMISSION_BYTES = 1_000_000;
/** Links checked per text; the rest are ignored. */
const MAX_LINKS = 200;
const MAX_EMAIL_LENGTH = 254;
// Agent-written text runs through these on the server's thread: every
// repeated part is bounded and cannot contain its own opening character,
// so the time stays linear in the size of the text.
/** Text a finished document or email should never contain. */
const PLACEHOLDERS = /\b(TODO|TBD|FIXME|XXX)\b|lorem ipsum|\[(insert|your|add)[^[\]\n]{0,200}\]|\{\{[^{}\n]{0,200}\}\}|<(insert|your)[^<>\n]{0,200}>/i;
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const LINK = /\[[^[\]\n]{0,500}\]\(\s*<?([^)\s<>]{1,2000})>?(?:\s+"[^"\n]{0,500}")?\s*\)|<(https?:\/\/[^<>\s]{1,2000})>/g;

/**
 * Gate 3 (M5): deterministic checks of a submission by output type, run by
 * the gateway after submit and before any reviewer turn. Content files:
 * they exist, their length, no placeholders, links that resolve. Emails:
 * schema, recipients on the CEO's allowlist, body length, placeholders,
 * links a recipient can open. Nothing here calls a model or the network.
 */
export function runChecks(submitted: Submitted, workspace: Workspace | null, settings: CheckSettings = DEFAULT_CHECK_SETTINGS): CheckResult[] {
  return checkSubmission(submitted, workspace, settings).results;
}

/**
 * The checks and the sha256 of every file they read, from one read of each
 * file, so the hashes are exactly of the content that was checked.
 */
export function checkSubmission(
  submitted: Submitted,
  workspace: Workspace | null,
  settings: CheckSettings = DEFAULT_CHECK_SETTINGS,
): { results: CheckResult[]; files: Record<string, string> } {
  const results: CheckResult[] = [];
  const files = readArtifacts([...new Set(submitted.artifacts)], workspace);
  const hashes: Record<string, string> = {};
  for (const f of files) if (f.sha256) hashes[f.path] = f.sha256;
  if (submitted.artifacts.length) {
    const problems = files.filter((f) => f.problem).map((f) => `${f.path}: ${f.problem}`);
    results.push(result('files.exist', problems, `${files.length} file(s) found`));
  }
  const content = files.filter((f) => f.text !== undefined && CONTENT_EXTENSIONS.has(extname(f.path).toLowerCase()));
  if (content.length) {
    const { minWords, maxWords } = settings.content;
    results.push(
      result(
        'content.length',
        content.flatMap((f) => {
          const n = words(f.text!);
          return n < minWords ? [`${f.path} has ${n} words (at least ${minWords})`] : n > maxWords ? [`${f.path} has ${n} words (at most ${maxWords})`] : [];
        }),
        `within ${minWords}–${maxWords} words`,
      ),
      result('content.placeholders', content.flatMap((f) => placeholder(f.path, f.text!)), 'no placeholders'),
      result('content.links', content.flatMap((f) => links(f.text!, (target) => checkLink(target, f.path, workspace)).map((p) => `${f.path}: ${p}`)), 'every link resolves'),
    );
  }
  if (submitted.finalAction?.tool === 'email.send') results.push(...emailChecks(submitted.finalAction.input, settings.email));
  return { results, files: hashes };
}

function emailChecks(input: unknown, rules: CheckSettings['email']): CheckResult[] {
  const e = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const schema: string[] = [];
  for (const field of ['to', 'subject'] as const) {
    if (typeof e[field] !== 'string' || !(e[field] as string).trim() || /[\r\n]/.test(e[field] as string)) schema.push(`"${field}" must be one non-empty line`);
  }
  if (typeof e.body !== 'string' || !e.body.trim()) schema.push('"body" must be non-empty text');
  const results = [result('email.schema', schema, 'to, subject and body are present')];
  if (schema.length) return results;

  const to = (e.to as string).split(/[,;]/).map((a) => a.trim()).filter(Boolean);
  const recipients = to.flatMap((address) => {
    if (!isEmail(address)) return [`"${address}" is not an email address`];
    return allowed(address, rules.allowedRecipients) ? [] : [`${address} is not on the allowed recipients list (${rules.allowedRecipients.join(', ')})`];
  });
  results.push(result('email.recipients', recipients, rules.allowedRecipients.length ? `all on the allowed list` : `${to.length} valid address(es)`));

  const body = e.body as string;
  const n = words(body);
  const bodyProblems = n > rules.maxBodyWords ? [`the body has ${n} words (at most ${rules.maxBodyWords})`] : [];
  bodyProblems.push(...placeholder('the body', body), ...placeholder('the subject', e.subject as string));
  // A recipient cannot open a workspace path: links must be web or mail links.
  bodyProblems.push(...links(body, (target) => (/^(https?:|mailto:)/i.test(target) ? checkLink(target, '', null) : `"${target}" is not a web link a recipient can open`)));
  results.push(result('email.body', bodyProblems, `${n} words, no placeholders, links are web links`));
  return results;
}

function allowed(address: string, list: string[]): boolean {
  if (!list.length) return true;
  const a = address.toLowerCase();
  return list.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('@') ? a.endsWith(e) : a === e;
  });
}

interface Artifact {
  path: string;
  text?: string;
  sha256?: string;
  problem?: string;
}

function readArtifacts(paths: string[], workspace: Workspace | null): Artifact[] {
  let total = 0;
  return paths.map((path) => {
    if (!workspace) return { path, problem: 'cannot be checked: this server has no workspace' };
    let full: string;
    try {
      full = workspace.resolve(path);
    } catch (err) {
      return { path, problem: err instanceof Error ? err.message : String(err) };
    }
    // A file system error would carry the absolute path; report the workspace path only.
    try {
      if (!existsSync(full)) return { path, problem: 'does not exist' };
      const stat = statSync(full);
      if (!stat.isFile()) return { path, problem: 'is not a file' };
      if (stat.size === 0) return { path, problem: 'is empty' };
      if (stat.size > MAX_CHECKED_BYTES) return { path, problem: `is too large to check (${stat.size} bytes, at most ${MAX_CHECKED_BYTES})` };
      total += stat.size;
      if (total > MAX_SUBMISSION_BYTES) return { path, problem: `is past the ${MAX_SUBMISSION_BYTES} bytes checked per submission` };
      const bytes = readFileSync(full);
      return { path, text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') };
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? ` (${String(err.code)})` : '';
      return { path, problem: `cannot be read${code}` };
    }
  });
}

/**
 * sha256 of each artifact as the checks read it. The reviewer must judge
 * exactly these files: if one changes before the review, it is checked again.
 */
export function fingerprint(artifacts: string[], workspace: Workspace | null): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of readArtifacts([...new Set(artifacts)], workspace)) if (f.sha256) files[f.path] = f.sha256;
  return files;
}

/** Problems with each link in `text`, as `check` reports them. */
function links(text: string, check: (target: string) => string | null): string[] {
  const problems: string[] = [];
  let n = 0;
  for (const m of text.matchAll(LINK)) {
    if (++n > MAX_LINKS) break;
    const problem = check(m[1] ?? m[2]);
    if (problem) problems.push(problem);
  }
  return problems;
}

/** A web link must parse; a relative link must lead to a file in the workspace. */
function checkLink(target: string, fromFile: string, workspace: Workspace | null): string | null {
  if (target.startsWith('#')) return null;
  if (/^mailto:/i.test(target)) return isEmail(target.slice(7).split('?')[0]) ? null : `"${target}" is not a valid mail link`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    if (!/^https?:/i.test(target)) return `"${target}" uses a scheme that is not allowed`;
    try {
      const url = new URL(target);
      return url.hostname.includes('.') || url.hostname === 'localhost' ? null : `"${target}" has no valid host`;
    } catch {
      return `"${target}" is not a valid URL`;
    }
  }
  if (!workspace) return `"${target}" is not a web link`;
  const path = decodeSafe(target.split('#')[0].split('?')[0]);
  try {
    const full = workspace.resolve(join(dirname(fromFile), path));
    return existsSync(full) ? null : `"${target}" does not exist in the workspace`;
  } catch {
    return `"${target}" leads outside the workspace`;
  }
}

function isEmail(s: string): boolean {
  return s.length <= MAX_EMAIL_LENGTH && EMAIL.test(s);
}

function placeholder(where: string, text: string): string[] {
  const m = PLACEHOLDERS.exec(text);
  return m ? [`${where} still has a placeholder: "${m[0]}"`] : [];
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function result(name: string, problems: string[], okDetail: string): CheckResult {
  return problems.length ? { name, ok: false, detail: problems.join('; ') } : { name, ok: true, detail: okDetail };
}
