import type { Goal, PlanTask, RubricItem, Task } from '@ai-company/core';
import type { CheckpointStore } from './checkpoints.ts';
import { PLAN_SCHEMA, VERDICT_SCHEMA, feedbackMessage, newFenceTag, plannerPrompt, reviewerPrompt, roleMemory, workerSystem, workerTask } from './context.ts';
import { totalTokens, type ChatMessage, type ChatResult, type ModelOptions, type ModelProvider, type ToolCall, type ToolDefinition } from './model.ts';
import type { AgentPort, AgentView, CompanyView, ToolInfo } from './port.ts';

/** The model an agent runs on, resolved from its "<provider>:<model>" ref. */
export interface AgentModel {
  provider: ModelProvider;
  model: string;
  options?: ModelOptions;
}

/** Reads a workspace file (or lists a folder) for the reviewer; throws if it cannot. */
export interface FileReader {
  read(path: string): string;
}

export interface RoleContext {
  port: AgentPort;
  agent: AgentView;
  model: AgentModel;
  workspace: FileReader;
  checkpoints: CheckpointStore;
  newKey: () => string;
  /** The CEO's notes for this agent's role. */
  roleNotes?: string;
  signal?: AbortSignal;
  log: (message: string) => void;
}

/** True when the unit changed company state (so the runtime should look again right away). */
export type Progress = boolean;

const MAX_REVIEW_FILE = 20_000;
const SUBMIT = 'submit_work';
const BLOCKED = 'report_blocked';

// ───────────────────────── orchestrator ─────────────────────────

/**
 * Plans an open goal. Each rejected plan goes back to the model with the
 * engine's reasons; the engine decides when to stop (maxReplans, budget).
 */
export async function runPlanner(ctx: RoleContext, goal: Goal, view: CompanyView): Promise<Progress> {
  const { system, user } = plannerPrompt(ctx.agent, goal, view, ctx.roleNotes);
  const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let progress = false;
  for (;;) {
    if (!(await mayWork(ctx))) return progress;
    const result = await chat(ctx, messages, undefined, PLAN_SCHEMA);
    const recorded = await ctx.port.recordGoalStep(goal.id, ctx.agent.id, totalTokens(result.usage));
    if (!recorded.ok) {
      ctx.log(`${ctx.agent.name} could not record a planning turn: ${recorded.error}`);
      return progress;
    }
    progress = true;
    messages.push(answer(result));

    const parsed = parseJson(result.text);
    const plan = Array.isArray(parsed?.tasks) ? (parsed.tasks as PlanTask[]) : [];
    // Even an unreadable answer is submitted (as an empty plan), so the engine counts it.
    const submitted = await ctx.port.submitPlan(goal.id, ctx.agent.id, plan);
    if (submitted.ok) {
      ctx.log(`${ctx.agent.name} planned ${submitted.value.length} tasks for "${goal.text}"`);
      return progress;
    }
    const now = (await ctx.port.view()).goals.find((g) => g.id === goal.id);
    if (!now || now.status !== 'open') {
      ctx.log(`${ctx.agent.name} stopped planning "${goal.text}": goal is ${now?.status ?? 'gone'}`);
      return progress;
    }
    const reason = parsed ? submitted.error : `Your answer was not valid JSON matching the schema. ${submitted.error}`;
    ctx.log(`${ctx.agent.name}'s plan for "${goal.text}" was rejected: ${reason}`);
    messages.push({ role: 'user', content: `The plan was rejected:\n${reason}\nFix every problem and answer with the complete corrected plan.` });
  }
}

// ───────────────────────── worker ─────────────────────────

/**
 * Works on one task until it is submitted, escalated or stopped: model turn
 * → recordStep → each tool call through requestToolCall → execute only on
 * `allow` → feed the result back. Checkpoints after every completed turn.
 */
export async function runWorker(ctx: RoleContext, task: Task, view: CompanyView): Promise<Progress> {
  const { port, agent } = ctx;
  let progress = false;
  if (task.state === 'assigned') {
    const started = await port.start(task.id, agent.id);
    if (!started.ok) return false;
    progress = true;
    view = await port.view();
    task = view.tasks.find((t) => t.id === task.id)!;
  }
  if (task.state !== 'working') return progress;

  const run = task.startedAt ?? 0;
  // Only tools the gateway on this server can run (they come with an input schema).
  const runnable = new Map(view.tools.flatMap((t) => (t.runnable ? [[t.name, t.runnable] as const] : [])));
  const callable = agent.tools.filter((t) => agent.toolAccess[t] === 'call' && runnable.has(t));
  // Final actions only for tools the plan gave this task: the engine refuses any other.
  const finalTools = agent.tools.filter((t) => agent.toolAccess[t] === 'final' && runnable.has(t) && task.requiredTools.includes(t));
  const { definitions, toolName } = workerTools(runnable, callable, finalTools);

  // Resume from the checkpoint of this run, adding feedback that arrived since.
  const saved = ctx.checkpoints.load(task.id, agent.id);
  let messages: ChatMessage[];
  if (saved && saved.run === run) {
    messages = saved.messages;
    if (task.reviewAttempts > saved.attempt) messages.push({ role: 'user', content: feedbackMessage(task.lastFeedback) });
  } else {
    const goal = view.goals.find((g) => g.id === task.goalId);
    const tag = newFenceTag();
    messages = [
      { role: 'system', content: workerSystem(agent, tag) },
      { role: 'user', content: workerTask(task, goal, view, finalTools, tag, roleMemory(agent, view, task.id, ctx.roleNotes, tag)) },
    ];
  }
  const checkpoint = () => ctx.checkpoints.save({ taskId: task.id, agentId: agent.id, run, attempt: task.reviewAttempts, messages });

  for (;;) {
    // Between turns: the kill switch, a pause or an escalation stops the work.
    const now = await port.view();
    const current = now.tasks.find((t) => t.id === task.id);
    const me = now.agents.find((a) => a.id === agent.id);
    if (now.companyPaused || !me || me.paused || me.benched || current?.state !== 'working') {
      checkpoint();
      return progress;
    }
    task = current;

    const result = await chat(ctx, messages, definitions);
    const stepped = await port.recordStep(task.id, agent.id, totalTokens(result.usage));
    if (!stepped.ok) {
      ctx.log(`${agent.name} could not record a step: ${stepped.error}`);
      return progress;
    }
    progress = true;
    if (stepped.value !== 'working') {
      ctx.log(`${agent.name}'s task "${task.title}" is now ${stepped.value}`);
      return progress;
    }
    messages.push(answer(result));

    if (result.toolCalls.length === 0) {
      messages.push({ role: 'user', content: `Use a tool, call ${SUBMIT} when every criterion is met, or ${BLOCKED} if you cannot continue.` });
      checkpoint();
      continue;
    }

    let finished = false;
    for (const call of result.toolCalls) {
      if (finished) {
        messages.push(toolResult(call, 'not run: the task was already submitted'));
        continue;
      }
      const name = toolName.get(call.name) ?? call.name;
      if (name === SUBMIT) {
        const submitted = await port.submitForReview(task.id, agent.id, submission(call, ctx.newKey));
        messages.push(toolResult(call, submitted.ok ? 'submitted for review' : `error: ${submitted.error}`));
        finished = submitted.ok;
      } else if (name === BLOCKED) {
        const reason = String(call.arguments.reason ?? '').trim() || 'blocked (no reason given)';
        const escalated = await port.escalate(task.id, agent.id, reason);
        messages.push(toolResult(call, escalated.ok ? 'escalated to the CEO' : `error: ${escalated.error}`));
        finished = escalated.ok;
      } else {
        messages.push(toolResult(call, await useTool(ctx, task, name, call.arguments)));
      }
    }
    checkpoint();
    if (finished) return progress;
  }
}

/** One tool call, handed to the gateway: it asks the engine, runs the tool only on `allow` and records the result. */
async function useTool(ctx: RoleContext, task: Task, tool: string, input: Record<string, unknown>): Promise<string> {
  if ('_invalidArguments' in input) return 'error: the tool arguments were not valid JSON; call the tool again with a JSON object';
  const result = await ctx.port.callTool(task.id, ctx.agent.id, tool, input);
  return result.ok ? result.value : `error: ${result.error}`;
}

function workerTools(runnable: Map<string, NonNullable<ToolInfo['runnable']>>, callable: string[], finalTools: string[]) {
  // Model-facing names avoid dots, which some vendors reject.
  const toolName = new Map<string, string>();
  const modelName = (name: string) => {
    const safe = name.replace(/[^A-Za-z0-9_-]/g, '_');
    toolName.set(safe, name);
    return safe;
  };
  const definitions: ToolDefinition[] = callable.map((name) => {
    const t = runnable.get(name)!;
    return { name: modelName(name), description: t.description, parameters: t.parameters };
  });
  const finalAction = finalTools.length
    ? {
        finalAction: {
          type: 'object',
          description: `Optional. Something to send or publish after review and CEO approval. Tools: ${finalTools
            .map((t) => `${t} (input: ${JSON.stringify(runnable.get(t)!.parameters)})`)
            .join('; ')}`,
          properties: { tool: { type: 'string', enum: finalTools }, input: { type: 'object' } },
          required: ['tool', 'input'],
        },
      }
    : {};
  definitions.push(
    {
      name: modelName(SUBMIT),
      description: 'Submit your finished work for review.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What you did and where the result is' },
          selfCheck: {
            type: 'array',
            description: 'One entry per acceptance criterion, with the criterion text copied exactly',
            items: { type: 'object', properties: { criterion: { type: 'string' }, met: { type: 'boolean' }, note: { type: 'string' } }, required: ['criterion', 'met'] },
          },
          artifacts: { type: 'array', items: { type: 'string' }, description: 'Workspace paths of the files you produced' },
          ...finalAction,
        },
        required: ['summary', 'selfCheck'],
      },
    },
    {
      name: modelName(BLOCKED),
      description: 'Stop and hand the task to the CEO because it cannot be done.',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
  );
  return { definitions, toolName };
}

/** Turns the model's submit_work call into a Submission; the engine checks it (self-check, final-action policy). */
function submission(call: ToolCall, newKey: () => string) {
  const a = call.arguments;
  const selfCheck = Array.isArray(a.selfCheck)
    ? a.selfCheck
        .filter((s: any) => s && typeof s === 'object')
        .map((s: any) => ({ criterion: String(s.criterion ?? ''), met: s.met === true, ...(typeof s.note === 'string' ? { note: s.note } : {}) }))
    : [];
  const artifacts = Array.isArray(a.artifacts) ? a.artifacts.filter((p): p is string => typeof p === 'string') : [];
  const fa = a.finalAction as { tool?: unknown; input?: unknown } | undefined;
  // The key is ours, never the model's, so it is unique per real-world effect.
  const finalAction =
    fa && typeof fa === 'object' && typeof fa.tool === 'string'
      ? { tool: fa.tool, input: fa.input ?? {}, idempotencyKey: newKey() }
      : undefined;
  return { summary: typeof a.summary === 'string' ? a.summary : '', selfCheck, artifacts, ...(finalAction ? { finalAction } : {}) };
}

const toolResult = (call: ToolCall, content: string): ChatMessage => ({ role: 'tool', content, toolCallId: call.id, name: call.name });

// ───────────────────────── reviewer ─────────────────────────

/** Reviews one submitted task against its criteria, the files it produced and its proposed final action. */
export async function runReviewer(ctx: RoleContext, task: Task): Promise<Progress> {
  const files = task.artifacts.map((path) => {
    let content: string;
    try {
      content = ctx.workspace.read(path);
    } catch (err) {
      content = `(could not read: ${err instanceof Error ? err.message : String(err)})`;
    }
    return { path, content: content.length > MAX_REVIEW_FILE ? `${content.slice(0, MAX_REVIEW_FILE)}\n… (truncated)` : content };
  });
  const { system, user } = reviewerPrompt(ctx.agent, task, files, newFenceTag(), ctx.roleNotes);
  const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await mayWork(ctx))) return false;
    const result = await chat(ctx, messages, undefined, VERDICT_SCHEMA);
    const recorded = await ctx.port.recordGoalStep(task.goalId, ctx.agent.id, totalTokens(result.usage));
    if (!recorded.ok) return false;
    const v = parseJson(result.text);
    const rubric = v ? toRubric(task.acceptanceCriteria, v.criteria) : 'Answer only with JSON matching the schema.';
    if (typeof rubric !== 'string') {
      const verdict = fromRubric(rubric, typeof v.feedback === 'string' ? v.feedback : '');
      const reviewed = await ctx.port.recordReview(task.id, ctx.agent.id, verdict);
      if (reviewed.ok) {
        ctx.log(`${ctx.agent.name} ${verdict.passed ? 'passed' : 'sent back'} "${task.title}" (${rubric.filter((r) => r.met).length} of ${rubric.length} criteria met)`);
        return true;
      }
      const now = (await ctx.port.view()).tasks.find((t) => t.id === task.id);
      // Its files changed and were checked again: that is progress; the next review starts from what is there now.
      if (now && JSON.stringify(now.checkedFiles) !== JSON.stringify(task.checkedFiles)) return true;
      // The task moved on (paused company, budget, CEO): stop instead of retrying.
      if (now?.state !== 'review') return false;
      messages.push(answer(result), { role: 'user', content: `That verdict was refused: ${reviewed.error}. Answer again.` });
    } else {
      messages.push(answer(result), { role: 'user', content: `${rubric} Answer with JSON: {"criteria": [{"criterion", "met", "evidence"}, …], "feedback": string}.` });
    }
  }
  // Not progress: the runtime moves on to other work and backs off, and the
  // goal budget (which also covers tasks in review) bounds the retries.
  ctx.log(`${ctx.agent.name} gave no usable verdict for "${task.title}"; will try again later`);
  return false;
}

/**
 * Matches the model's items to the acceptance criteria, each item to at
 * most one criterion: by its text or its number ("2", "2. …"). Only when no
 * item names any criterion are they taken in order. A rubric that does not
 * fit gives what to fix, so the reviewer is asked again: a guess here could
 * turn a "not met" into a pass.
 */
export function toRubric(criteria: string[], raw: unknown): RubricItem[] | string {
  if (!Array.isArray(raw)) return 'Your answer had no "criteria" list.';
  const items = raw.filter((x): x is { criterion?: unknown; met: boolean; evidence?: unknown } => !!x && typeof x === 'object' && typeof x.met === 'boolean');
  // Dropping a malformed item could drop the one that said "not met".
  if (items.length !== raw.length) return 'Every item needs "criterion" (text), "met" (true or false) and "evidence" (text).';
  if (items.length !== criteria.length) return `Give exactly ${criteria.length} criteria items, one per acceptance criterion, in order (you gave ${items.length}).`;
  const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const target = (item: { criterion?: unknown }): number => {
    const text = norm(item.criterion);
    const byText = criteria.findIndex((c) => norm(c) === text || norm(c) === text.replace(/^\d+[.)]\s*/, ''));
    if (byText >= 0) return byText;
    const n = /^(\d+)[.)]?$/.exec(text);
    return n && Number(n[1]) >= 1 && Number(n[1]) <= criteria.length ? Number(n[1]) - 1 : -1;
  };
  const targets = items.map(target);
  const order = targets.every((t) => t === -1) ? items.map((_, i) => i) : targets;
  const missing = criteria.filter((_, i) => order.filter((t) => t === i).length !== 1);
  if (missing.length) {
    return `Give one item for each acceptance criterion, with its text copied exactly. Not judged exactly once: ${missing.map((c) => `"${c}"`).join(', ')}.`;
  }
  return criteria.map((criterion, i) => {
    const item = items[order.indexOf(i)];
    const evidence = typeof item.evidence === 'string' ? item.evidence.trim().slice(0, 1_500) : '';
    // The engine needs a note on an unmet criterion; say so when the model gave none.
    const note = evidence || (item.met ? '' : 'not met (the reviewer gave no detail)');
    return { criterion, met: item.met, ...(note ? { note } : {}) };
  });
}

/** Code decides: the work passes only if every criterion is met; the score is the share met. */
export function fromRubric(rubric: RubricItem[], feedback: string) {
  const unmet = rubric.filter((r) => !r.met);
  const passed = unmet.length === 0;
  const score = rubric.length ? Math.round((100 * (rubric.length - unmet.length)) / rubric.length) / 100 : 1;
  const text = passed
    ? feedback.trim()
    : ['Not met:', ...unmet.map((r) => `- ${r.criterion}: ${r.note}`), ...(feedback.trim() ? ['', feedback.trim()] : [])].join('\n');
  return { passed, score, feedback: text, rubric };
}

// ───────────────────────── shared ─────────────────────────

/** The model's answer as it goes back into the conversation, with the provider's raw record. */
function answer(result: ChatResult): ChatMessage {
  return {
    role: 'assistant',
    content: result.text,
    ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
    ...(result.raw ? { raw: result.raw } : {}),
  };
}

/** Before every model turn: the kill switch, a pause or the bench stops the agent. */
async function mayWork(ctx: RoleContext): Promise<boolean> {
  const view = await ctx.port.view();
  const me = view.agents.find((a) => a.id === ctx.agent.id);
  return !view.companyPaused && !!me && !me.paused && !me.benched;
}

function chat(ctx: RoleContext, messages: ChatMessage[], tools?: ToolDefinition[], format?: Record<string, unknown>) {
  return ctx.model.provider.chat(
    { model: ctx.model.model, messages, ...(tools ? { tools } : {}), ...(format ? { format } : {}), ...(ctx.model.options ? { options: ctx.model.options } : {}) },
    ctx.signal,
  );
}

function parseJson(text: string): any {
  // Some models wrap JSON in a code fence or add thinking before it.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
