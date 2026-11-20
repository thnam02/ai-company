import { readFileSync, statSync } from 'node:fs';
import { inspect } from 'node:util';

/**
 * A credential that cannot be printed by accident: logging, JSON or inspect
 * show "[secret]". Only the code that needs it calls `reveal()` (invariant 6).
 */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[secret]';
  }
  toJSON(): string {
    return '[secret]';
  }
  [inspect.custom](): string {
    return '[secret]';
  }
}

/** Shortest value the gateway removes from text; shorter ones would mangle ordinary words. */
const MIN_REDACT = 6;

/**
 * Tool credentials, held by the gateway only. A tool gets the ones it
 * declared, while it runs; agents, prompts, events and logs never see them,
 * and every text that leaves the gateway has their values removed.
 */
export class CredentialStore {
  readonly #secrets: Map<string, Secret>;

  constructor(secrets: Record<string, Secret> = {}) {
    this.#secrets = new Map(Object.entries(secrets));
    for (const [name, secret] of this.#secrets) {
      if (secret.reveal().length < MIN_REDACT) throw new Error(`credential "${name}" is too short to be real (under ${MIN_REDACT} characters)`);
    }
  }

  has(name: string): boolean {
    return this.#secrets.has(name);
  }

  names(): string[] {
    return [...this.#secrets.keys()];
  }

  reveal(name: string): string | undefined {
    return this.#secrets.get(name)?.reveal();
  }

  /**
   * Replaces every credential value in `text` with "[secret]": as written,
   * URL-encoded, JSON-escaped and base64 on its own (connectors echo request
   * URLs and JSON bodies in errors). Longest first, so a value that contains
   * another is removed whole. A value base64-encoded together with other text
   * (Basic auth's `user:password`) is not reliably caught: connectors must
   * keep auth headers out of what they return.
   */
  redact(text: string): string {
    let out = text;
    for (const form of this.#forms()) out = out.split(form).join('[secret]');
    return out;
  }

  #forms(): string[] {
    const forms = new Set<string>();
    for (const secret of this.#secrets.values()) {
      const v = secret.reveal();
      for (const f of [v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1), Buffer.from(v).toString('base64')]) {
        if (f.length >= MIN_REDACT) forms.add(f);
      }
    }
    return [...forms].sort((a, b) => b.length - a.length);
  }

  toJSON(): string {
    return `[credentials: ${this.names().join(', ')}]`;
  }

  [inspect.custom](): string {
    return this.toJSON();
  }
}

/**
 * Loads `{ "name": "value", … }` from a file only its owner can read (mode
 * 0600 or stricter); a looser file is refused, since anyone on the machine
 * could take the logins. A missing file means no credentials.
 */
export function loadCredentials(path: string): CredentialStore {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new CredentialStore();
    throw err;
  }
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new Error(`${path} can be read by other users; run: chmod 600 ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Never echo the file: a parse error message can quote a value.
    throw new Error(`${path} is not valid JSON`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} must be a JSON object of name → value`);
  const secrets: Record<string, Secret> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !value) throw new Error(`credential "${name}" in ${path} must be a non-empty string`);
    secrets[name] = new Secret(value);
  }
  return new CredentialStore(secrets);
}
