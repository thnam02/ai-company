import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fail, ok, type Outcome, type PlanTask, type ProposedAction, type Resolution, type Result, type ReviewVerdict, type Submission, type TaskState, type WorkflowEngine } from '@ai-company/core';
import type { AgentPort, AgentView, CompanyView, ToolAccess, ToolRegistry } from '@ai-company/agents';
import type { DurableEventStore } from './durable-store.ts';
import { attachEventStream, type EventStream } from './stream.ts';

export interface ServerOptions {
  engine: WorkflowEngine;
  /** Must be the engine's own store. */
  store: DurableEventStore;
  /** Bearer token for the CEO. Never logged, never put in events. */
  ceoToken: string;
  /**
   * Executors for released final actions (ADR 0003). A released action is
   * executed only after its release is durable, and its result is recorded
   * through the engine (`action.executed` / `action.failed`). Never sent to
   * the HTTP caller.
   */
  tools?: ToolRegistry;
  /**
   * Test hook used instead of `tools`: receives released final actions after
   * the release is durable. Nothing is recorded for them.
   */
  onExecute?: (action: ProposedAction, context: { taskId: string }) => void | Promise<void>;
  /** Called once if the event store fails. The process should exit and rebuild from the log. */
  onFatal?: (err: Error) => void;
  log?: (message: string) => void;
  maxBodyBytes?: number;
  /** WebSocket ping interval used to drop dead clients. Default 30 s. */
  heartbeatMs?: number;
}

export interface CompanyServer {
  http: Server;
  stream: EventStream;
  /**
   * The command queue. Runs `fn` (synchronous engine work), then waits until
   * every event it emitted is durable. Anything that leaves the process —
   * responses, stream messages, gateway actions, an agent acting on an
   * `allow` — must come from `fn`'s return value, and only after this
   * resolves. Reading engine state after the await may include other
   * commands' events that are not durable yet.
   */
  run<T>(fn: () => T): Promise<T>;
  /** The only way agents reach the company: allowlisted engine commands through `run` (ADR 0003). */
  readonly agentPort: AgentPort;
  /**
   * The outbox after a crash: executes (or gives up on) every released final
   * action with no recorded result. Call once on boot, before agents start.
   */
  recoverActions(): Promise<void>;
  /** True once the store has failed; the server then refuses all work. */
  readonly failed: boolean;
  close(): Promise<void>;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Handler = (ctx: { params: string[]; body: any; url: URL }) => Promise<{ status?: number; body: unknown }>;

export function createCompanyServer(options: ServerOptions): CompanyServer {
  const { engine, store } = options;
  if (engine.store !== store) throw new Error('store must be the engine\'s own store');
  if (!options.ceoToken) throw new Error('a CEO token is required');
  const log = options.log ?? ((m: string) => console.error(m));
  const maxBody = options.maxBodyBytes ?? 64 * 1024;
  const tokenDigest = digest(options.ceoToken);
  let failure: Error | null = null;

  /** Header only, except for the stream upgrade: browsers cannot set headers on a WebSocket. */
  const authorized = (req: IncomingMessage, url: URL, allowQueryToken = false): boolean => {
    const header = req.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : allowQueryToken ? url.searchParams.get('token') : null;
    return typeof presented === 'string' && timingSafeEqual(digest(presented), tokenDigest);
  };

  const goFatal = (err: unknown) => {
    if (failure) return;
    failure = err instanceof Error ? err : new Error(String(err));
    // Drop pending events and cancel queued flushes: nothing more reaches the log.
    store.abort(failure);
    log(`fatal: ${failure.message}; refusing all work until restart`);
    options.onFatal?.(failure);
  };
  store.onFailure(goFatal);

  const run = async <T>(fn: () => T): Promise<T> => {
    if (failure) throw new HttpError(503, 'server is restarting');
    let value: T;
    try {
      value = fn();
    } catch (err) {
      // A throwing command may have appended events that were never applied.
      // Flushing them would make the log disagree with memory (and could make
      // it unbootable), so the process stops without writing them.
      goFatal(err);
      throw err;
    }
    try {
      await store.flush();
    } catch (err) {
      goFatal(err);
      throw err;
    }
    return value;
  };

  /** Engine refusals become 404 (unknown id) or 409 (not allowed now). */
  const command = async <T>(fn: () => Result<T>): Promise<T> => {
    const r = await run(fn);
    if (!r.ok) throw new HttpError(r.error.startsWith('unknown ') ? 404 : 409, r.error);
    return r.value;
  };

  /** Final actions running now, by idempotency key; `close()` waits for them. */
  const executing = new Map<string, Promise<void>>();

  /**
   * Executes a released final action and records its result through the
   * engine. Called only after the release is durable. A key already being
   * executed in this process is skipped; across a crash, recoverActions decides.
   */
  const execute = (action: ProposedAction, taskId: string, tools: ToolRegistry): Promise<void> => {
    const key = action.idempotencyKey;
    const running = executing.get(key);
    if (running) return running;
    const done = executeOnce(action, taskId, tools).finally(() => executing.delete(key));
    executing.set(key, done);
    return done;
  };

  const executeOnce = async (action: ProposedAction, taskId: string, tools: ToolRegistry): Promise<void> => {
    const key = action.idempotencyKey;
    try {
      const result = await tools.executeAction(action);
      const recorded = await run(() => engine.recordActionResult(taskId, key, result));
      if (!recorded.ok) log(`could not record the result of ${action.tool} for task ${taskId}: ${recorded.error}`);
      else log(`final action ${action.tool} for task ${taskId} ${result.ok ? 'done' : 'failed'}: ${result.detail}`);
    } catch (err) {
      // `run` failing means the server has gone fatal; the action stays pending for the next boot.
      log(`final action ${action.tool} for task ${taskId} was not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Hands a released action to the executor without making the caller wait for it. */
  const release = (outcome: Outcome, taskId: string): void => {
    const action = outcome.execute;
    if (!action) return;
    if (options.tools) {
      void execute(action, taskId, options.tools);
      return;
    }
    if (!options.onExecute) {
      log(`final action ${action.tool} (${action.idempotencyKey}) for task ${taskId} is released, but no executors are configured; it was not executed`);
      return;
    }
    const failed = (err: unknown) => log(`gateway hook failed for ${action.idempotencyKey}: ${err instanceof Error ? err.message : String(err)}`);
    try {
      Promise.resolve(options.onExecute(action, { taskId })).catch(failed);
    } catch (err) {
      failed(err);
    }
  };

  const recoverActions = async (): Promise<void> => {
    const tools = options.tools;
    if (!tools) return;
    const pending = await run(() => engine.pendingActions());
    for (const { taskId, action } of pending) {
      const executor = tools.get(action.tool);
      if (executor && !executor.dedupesByKey) {
        // It may already have run: running it again could do it twice.
        const detail = `interrupted before its result was recorded; not retried because "${action.tool}" cannot detect a repeat. Check it by hand.`;
        const recorded = await run(() => engine.recordActionResult(taskId, action.idempotencyKey, { ok: false, detail }));
        log(recorded.ok ? `final action ${action.tool} for task ${taskId}: ${detail}` : `could not record ${action.tool} for task ${taskId}: ${recorded.error}`);
      } else {
        await execute(action, taskId, tools);
      }
    }
  };

  // Allowlisted agent commands (ADR 0003). Each runs through the command
  // queue, so an agent sees a result (e.g. a tool `allow`) only once it is durable.
  const agentPort: AgentPort = Object.freeze({
    view: () => run(() => agentView(engine)),
    submitPlan: (goalId: string, orchestratorId: string, plan: PlanTask[]) => run(() => engine.submitPlan(goalId, orchestratorId, plan)),
    start: (taskId: string, agentId: string) => run(() => engine.start(taskId, agentId)),
    recordStep: (taskId: string, agentId: string, tokens: number) => run(() => engine.recordStep(taskId, agentId, tokens)),
    recordGoalStep: (goalId: string, agentId: string, tokens: number) => run(() => engine.recordGoalStep(goalId, agentId, tokens)),
    requestToolCall: (taskId: string, agentId: string, call: ProposedAction) => run(() => engine.requestToolCall(taskId, agentId, call)),
    submitForReview: (taskId: string, agentId: string, submission: Submission) => run(() => engine.submitForReview(taskId, agentId, submission)),
    recordReview: async (taskId: string, reviewerId: string, verdict: ReviewVerdict): Promise<Result<TaskState>> => {
      const r = await run(() => engine.recordReview(taskId, reviewerId, verdict));
      if (!r.ok) return r;
      release(r.value, taskId);
      return ok(r.value.state);
    },
    escalate: (taskId: string, agentId: string, reason: string) =>
      run((): Result<TaskState> => {
        const t = engine.getTask(taskId);
        if (!t) return fail(`unknown task "${taskId}"`);
        if (t.ownerId !== agentId) return fail('only the task owner can escalate it');
        const name = engine.getAgent(agentId)?.name ?? agentId;
        return engine.escalate(taskId, `${name}: ${String(reason).slice(0, 500)}`);
      }),
  });

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/state$/, async () => ({ body: await run(() => snapshot(engine)) })],
    [
      'GET',
      /^\/events$/,
      async ({ url }) => {
        const since = parseSeq(url.searchParams.get('since'));
        await run(() => undefined);
        return { body: store.since(since).filter((e) => e.seq <= store.durableSeq).slice(0, 1000) };
      },
    ],
    [
      'POST',
      /^\/goals$/,
      async ({ body }) => {
        if (typeof body.text !== 'string' || typeof body.budgetTokens !== 'number') {
          throw new HttpError(400, 'expected { text: string, budgetTokens: number }');
        }
        return { status: 201, body: await command(() => engine.createGoal(body.text, body.budgetTokens)) };
      },
    ],
    [
      'POST',
      /^\/tasks\/([^/]+)\/approval$/,
      async ({ params: [taskId], body }) => {
        if (typeof body.approved !== 'boolean' || (body.note !== undefined && typeof body.note !== 'string')) {
          throw new HttpError(400, 'expected { approved: boolean, note?: string }');
        }
        const outcome = await command(() => engine.decideApproval(taskId, { approved: body.approved, note: body.note }));
        release(outcome, taskId);
        return { body: { state: outcome.state } };
      },
    ],
    [
      'POST',
      /^\/tasks\/([^/]+)\/resolve$/,
      async ({ params: [taskId], body }) => {
        const resolution = parseResolution(body);
        return { body: { state: await command(() => engine.resolveEscalation(taskId, resolution)) } };
      },
    ],
    [
      'POST',
      /^\/agents\/([^/]+)\/(pause|resume|unbench)$/,
      async ({ params: [agentId, action] }) => {
        // The response is read inside the command, so it shows this command's result, durable once `command` resolves.
        const agent = await command(() => {
          const r = action === 'pause' ? engine.pauseAgent(agentId) : action === 'resume' ? engine.resumeAgent(agentId) : engine.unbenchAgent(agentId);
          return r.ok ? ok(engine.getAgent(agentId)) : r;
        });
        return { body: { agent } };
      },
    ],
    [
      'POST',
      /^\/company\/(pause|resume)$/,
      async ({ params: [action], body }) => {
        if (body.reason !== undefined && typeof body.reason !== 'string') throw new HttpError(400, 'reason must be a string');
        const companyPaused = await command(() => {
          const r = action === 'pause' ? engine.pauseCompany(body.reason || undefined) : engine.resumeCompany();
          return r.ok ? ok(engine.isCompanyPaused()) : r;
        });
        return { body: { companyPaused } };
      },
    ],
  ];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      return send(res, failure ? 503 : 200, { ok: !failure });
    }
    if (!authorized(req, url)) return send(res, 401, { error: 'unauthorized' });
    if (failure) return send(res, 503, { error: 'server is restarting' });

    const matchingPath = routes.filter(([, pattern]) => pattern.test(url.pathname));
    const route = matchingPath.find(([method]) => method === req.method);
    if (!route) return send(res, matchingPath.length ? 405 : 404, { error: matchingPath.length ? 'method not allowed' : 'not found' });

    try {
      const body = req.method === 'POST' ? await readJson(req, maxBody) : {};
      const params = route[1].exec(url.pathname)!.slice(1).map(decodeParam);
      const result = await route[2]({ params, body, url });
      send(res, result.status ?? 200, result.body);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      log(`request failed: ${req.method} ${url.pathname}: ${err instanceof Error ? err.message : String(err)}`);
      send(res, 500, { error: 'internal error' });
    }
  };

  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
  });

  const stream = attachEventStream(http, {
    store,
    authorize: (req, url) => authorized(req, url, true),
    isFailed: () => failure !== null,
    heartbeatMs: options.heartbeatMs,
  });

  return {
    http,
    stream,
    run,
    agentPort,
    recoverActions,
    get failed() {
      return failure !== null;
    },
    async close() {
      // A released action that is running finishes and records its result
      // before the server (and then the store) closes.
      await Promise.allSettled([...executing.values()]);
      await stream.close();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    },
  };
}

/** Everything the 3D office needs to draw the company, plus the seq to resume the stream from. */
export function snapshot(engine: WorkflowEngine) {
  return {
    seq: engine.store.size,
    companyPaused: engine.isCompanyPaused(),
    agents: engine.listAgents(),
    goals: engine.listGoals(),
    tasks: engine.listTasks(),
  };
}

/** What agents may see: the snapshot plus, per agent, what policy lets it do with each tool. */
function agentView(engine: WorkflowEngine): CompanyView {
  const agents: AgentView[] = engine.listAgents().map((a) => {
    const toolAccess: Record<string, ToolAccess> = {};
    for (const tool of a.tools) {
      const d = engine.policy.check(a, tool);
      if (d.kind === 'allow') toolAccess[tool] = 'call';
      else if (d.kind === 'needs_approval') toolAccess[tool] = 'final';
    }
    return { ...a, toolAccess };
  });
  return { ...snapshot(engine), agents, tools: engine.policy.listTools() };
}

function parseResolution(body: any): Resolution {
  if (body.kind === 'retry' || body.kind === 'cancel') return { kind: body.kind };
  if (body.kind === 'reassign' && typeof body.ownerId === 'string') return { kind: 'reassign', ownerId: body.ownerId };
  throw new HttpError(400, 'expected { kind: "retry" | "cancel" } or { kind: "reassign", ownerId: string }');
}

export function parseSeq(raw: string | null): number {
  if (raw === null || raw === '') return 0;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'since must be a non-negative integer');
  return Number(raw);
}

function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'malformed path');
  }
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

async function readJson(req: IncomingMessage, limit: number): Promise<any> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'body must be a JSON object');
  return parsed;
}
