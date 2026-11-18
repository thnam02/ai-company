import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolExecutor } from './registry.ts';

/** Bad input from the model: reported back to it so it can fix the call. */
export class ToolInputError extends Error {}

const MAX_READ_BYTES = 100_000;
const MAX_WRITE_BYTES = 200_000;
const MAX_LISTING = 200;
const OUTBOX = 'outbox';

/**
 * A folder agents may read and write. Every path is resolved inside it and
 * checked again after symlinks are followed, so nothing outside is reachable.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }

  /**
   * The real absolute path (symlinks followed) for a workspace path, or
   * ToolInputError if it is, or leads, outside the workspace.
   */
  resolve(path: unknown): string {
    if (typeof path !== 'string' || path.trim() === '') throw new ToolInputError('"path" must be a relative path inside the workspace');
    if (path.includes('\u0000')) throw new ToolInputError('"path" contains a NUL character');
    if (isAbsolute(path)) throw new ToolInputError(`"${path}" is absolute; use a path relative to the workspace`);
    const full = resolve(this.root, path);
    if (!this.inside(full)) throw new ToolInputError(`"${path}" is outside the workspace`);
    // Follow symlinks on the longest existing prefix; the real path must stay inside.
    let existing = full;
    while (!exists(existing)) existing = dirname(existing);
    let real: string;
    try {
      real = join(realpathSync(existing), relative(existing, full));
    } catch {
      throw new ToolInputError(`"${path}" goes through a broken link`);
    }
    if (!this.inside(real)) throw new ToolInputError(`"${path}" leads outside the workspace`);
    return real;
  }

  /** Workspace-relative path with forward slashes. */
  relative(full: string): string {
    return relative(this.root, full).split(sep).join('/') || '.';
  }

  isOutbox(full: string): boolean {
    const first = this.relative(full).split('/')[0];
    return first.toLowerCase() === OUTBOX;
  }

  read(path: unknown): string {
    const full = this.resolve(path);
    if (!exists(full)) throw new ToolInputError(`"${String(path)}" does not exist`);
    if (statSync(full).isDirectory()) return this.list(full).join('\n') || '(empty folder)';
    const buf = readFileSync(full);
    const text = buf.subarray(0, MAX_READ_BYTES).toString('utf8');
    return buf.length > MAX_READ_BYTES ? `${text}\n… (truncated at ${MAX_READ_BYTES} bytes)` : text;
  }

  write(path: unknown, content: unknown): string {
    if (typeof content !== 'string') throw new ToolInputError('"content" must be a string');
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_WRITE_BYTES) throw new ToolInputError(`content is too large (${bytes} bytes, max ${MAX_WRITE_BYTES})`);
    const full = this.resolve(path);
    if (this.isOutbox(full)) throw new ToolInputError('the outbox is written only by approved email.send actions');
    if (exists(full) && statSync(full).isDirectory()) throw new ToolInputError(`"${String(path)}" is a folder`);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return `wrote ${bytes} bytes to ${this.relative(full)}`;
  }

  /** Files under a folder (recursive, workspace-relative), capped. */
  list(full: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= MAX_LISTING) return;
        if (entry.name.startsWith('.')) continue;
        const p = join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.isFile()) out.push(this.relative(p));
      }
    };
    walk(full);
    return out;
  }

  private inside(full: string): boolean {
    return full === this.root || full.startsWith(this.root + sep);
  }
}

/** The tools agents get in milestone 3. `email.send` is fake: it writes to `outbox/` and sends nothing. */
export function workspaceTools(ws: Workspace): ToolExecutor[] {
  return [
    {
      name: 'files.read',
      description: 'Read a text file in the workspace, or list the files in a folder ("." for everything).',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the workspace' } }, required: ['path'] },
      dedupesByKey: true,
      run: async (input) => ws.read(field(input, 'path')),
    },
    {
      name: 'files.write',
      description: 'Create or replace a text file in the workspace (not in outbox/).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the workspace' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      // Not safe to re-run after a crash: an old write could undo a newer one.
      dedupesByKey: false,
      run: async (input) => ws.write(field(input, 'path'), field(input, 'content')),
    },
    {
      name: 'email.send',
      description: 'Send an email. Tier 3: propose it as the final action of your task; it is sent only after review and CEO approval.',
      parameters: {
        type: 'object',
        properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
        required: ['to', 'subject', 'body'],
      },
      dedupesByKey: true,
      run: async (input, { idempotencyKey }) => sendToOutbox(ws, input, idempotencyKey),
    },
  ];
}

function sendToOutbox(ws: Workspace, input: unknown, key: string): string {
  const to = field(input, 'to');
  const subject = field(input, 'subject');
  const body = field(input, 'body');
  for (const [name, value] of [['to', to], ['subject', subject]] as const) {
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new ToolInputError(`"${name}" must be one non-empty line`);
  }
  if (typeof body !== 'string') throw new ToolInputError('"body" must be a string');
  const outbox = join(ws.root, OUTBOX);
  mkdirSync(outbox, { recursive: true });
  // Name from the key: readable part plus a hash, so different keys never collide.
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const name = `${key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)}-${hash}.eml`;
  const final = join(outbox, name);
  if (exists(final)) return `already in the outbox as outbox/${name}; not sent again`;

  // Write a temp file, flush it, then hard-link it into place: the link is
  // atomic and fails if the name exists, so a crash never leaves a half
  // email, and a re-run of the same key can never write a second one.
  const tmp = join(outbox, `.tmp-${hash}-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, 'wx');
  try {
    writeSync(fd, `To: ${String(to).trim()}\nSubject: ${String(subject).trim()}\nIdempotency-Key: ${key}\n\n${body}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, final);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return `already in the outbox as outbox/${name}; not sent again`;
    throw err;
  } finally {
    unlinkSync(tmp);
  }
  return `written to outbox/${name} (no real email is sent in this version)`;
}

function field(input: unknown, name: string): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ToolInputError('input must be an object');
  return (input as Record<string, unknown>)[name];
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
