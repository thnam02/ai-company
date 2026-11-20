import type { EngineEvent } from '@ai-company/core';

/**
 * A run report (M3b): how a team of agents did on its goals, computed from
 * the event log alone, so any log, live or replayed, gives the same numbers.
 */
export interface RunReport {
  summary: {
    goals: number;
    plansAcceptedFirstTry: number;
    replans: number;
    tasks: number;
    tasksDone: number;
    escalations: number;
    reviewedTasks: number;
    /** Tasks whose first check run and first review both passed. */
    firstTryReviewPasses: number;
    /** Automated check runs that sent work back before any reviewer saw it (gate 3). */
    failedCheckRuns: number;
    /** `failed`: allowed calls whose tool then failed (timeout, error, interrupted). */
    toolCalls: { allowed: number; denied: number; duplicate: number; failed: number };
    /** Every recorded model token: planning, work and review. */
    tokens: number;
  };
  goals: { id: string; text: string; status: string; planAttempts: number; planningTokens: number; reviewTokens: number }[];
  tasks: {
    id: string;
    goalId: string;
    title: string;
    ownerId: string;
    state: string;
    steps: number;
    tokens: number;
    /** In order; "checks failed" is a check run that sent the work back before review. */
    reviews: ('passed' | 'failed' | 'checks failed')[];
    /** Agent time: started until done, escalated, cancelled or handed to the CEO for approval. */
    seconds: number | null;
    escalationReason: string | null;
    action: { tool: string; ok: boolean; detail: string } | null;
  }[];
}

/** Measured outside the log by whoever ran the agents. */
export interface RunExtras {
  model?: string;
  wallSeconds?: number;
  peakServerRssMb?: number;
  peakModelMb?: number;
}

type TaskRow = RunReport['tasks'][number] & { startedAt: number | null; endedAt: number | null };

export function buildRunReport(events: readonly EngineEvent[]): RunReport {
  const kinds = new Map<string, string>();
  const goals = new Map<string, RunReport['goals'][number]>();
  const tasks = new Map<string, TaskRow>();
  const tools = { allowed: 0, denied: 0, duplicate: 0, failed: 0 };
  let tokens = 0;
  let escalations = 0;

  for (const e of events) {
    const d = e.data ?? {};
    const t = e.taskId ? tasks.get(e.taskId) : undefined;
    switch (e.type) {
      case 'agent.registered':
        kinds.set(d.agent.id, d.agent.kind);
        break;
      case 'goal.created':
        goals.set(d.goal.id, { id: d.goal.id, text: d.goal.text, status: 'open', planAttempts: 0, planningTokens: 0, reviewTokens: 0 });
        break;
      case 'goal.step': {
        const g = goals.get(e.goalId!);
        if (g) g[kinds.get(e.agentId!) === 'reviewer' ? 'reviewTokens' : 'planningTokens'] += d.tokens;
        tokens += d.tokens;
        break;
      }
      case 'plan.rejected':
        goals.get(e.goalId!)!.planAttempts += 1;
        break;
      case 'plan.accepted': {
        const g = goals.get(e.goalId!)!;
        g.planAttempts += 1;
        g.status = 'planned';
        for (const task of d.tasks) {
          tasks.set(task.id, {
            id: task.id, goalId: task.goalId, title: task.title, ownerId: task.ownerId, state: 'planned',
            steps: 0, tokens: 0, reviews: [], seconds: null, escalationReason: null, action: null, startedAt: null, endedAt: null,
          });
        }
        break;
      }
      case 'goal.escalated':
        goals.get(e.goalId!)!.status = 'escalated';
        break;
      case 'task.assigned':
        if (t) {
          t.state = 'assigned';
          t.ownerId = d.ownerId;
        }
        break;
      case 'task.started':
        t!.state = 'working';
        t!.startedAt ??= e.at;
        break;
      case 'task.step':
        t!.steps += 1;
        t!.tokens += d.tokens;
        tokens += d.tokens;
        break;
      case 'task.usage':
        t!.tokens += d.tokens;
        tokens += d.tokens;
        break;
      case 'tool.allowed':
        tools.allowed += 1;
        break;
      case 'tool.denied':
        tools.denied += 1;
        break;
      case 'tool.duplicate':
        tools.duplicate += 1;
        break;
      case 'tool.failed':
        tools.failed += 1;
        break;
      case 'task.submitted':
        t!.state = 'review';
        break;
      case 'checks.failed':
        t!.reviews.push('checks failed');
        t!.state = 'working';
        break;
      case 'review.passed':
      case 'review.failed':
        t!.reviews.push(e.type === 'review.passed' ? 'passed' : 'failed');
        t!.state = e.type === 'review.passed' ? 'review' : 'working';
        break;
      case 'approval.requested':
        t!.state = 'awaiting_approval';
        t!.endedAt = e.at;
        break;
      case 'approval.rejected':
        t!.state = 'working';
        t!.endedAt = null;
        break;
      case 'task.done':
        t!.state = 'done';
        if (t!.endedAt === null) t!.endedAt = e.at;
        break;
      case 'task.escalated':
        t!.state = 'escalated';
        t!.escalationReason = d.reason;
        t!.endedAt = e.at;
        escalations += 1;
        break;
      case 'task.cancelled':
        t!.state = 'cancelled';
        t!.endedAt = e.at;
        break;
      case 'action.executed':
      case 'action.failed':
        t!.action = { tool: d.tool, ok: e.type === 'action.executed', detail: d.detail };
        break;
    }
  }

  const taskRows = [...tasks.values()].map(({ startedAt, endedAt, ...row }) => ({
    ...row,
    seconds: startedAt !== null && endedAt !== null ? Math.round((endedAt - startedAt) / 1000) : null,
  }));
  const reviewed = taskRows.filter((t) => t.reviews.length > 0);
  const goalRows = [...goals.values()];
  return {
    summary: {
      goals: goalRows.length,
      plansAcceptedFirstTry: goalRows.filter((g) => g.status !== 'open' && g.planAttempts === 1 && hasPlan(taskRows, g.id)).length,
      replans: goalRows.reduce((n, g) => n + Math.max(0, g.planAttempts - (hasPlan(taskRows, g.id) ? 1 : 0)), 0),
      tasks: taskRows.length,
      tasksDone: taskRows.filter((t) => t.state === 'done').length,
      escalations,
      reviewedTasks: reviewed.length,
      firstTryReviewPasses: reviewed.filter((t) => t.reviews[0] === 'passed').length,
      failedCheckRuns: taskRows.reduce((n, t) => n + t.reviews.filter((r) => r === 'checks failed').length, 0),
      toolCalls: tools,
      tokens,
    },
    goals: goalRows,
    tasks: taskRows,
  };
}

const hasPlan = (tasks: RunReport['tasks'], goalId: string) => tasks.some((t) => t.goalId === goalId);

const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}% (${n} of ${of})` : 'n/a');
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function formatRunReport(report: RunReport, extras: RunExtras = {}): string {
  const s = report.summary;
  const lines = [
    `# Run report${extras.model ? `: ${extras.model}` : ''}`,
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Plans accepted first try | ${s.plansAcceptedFirstTry} of ${s.goals} |`,
    `| Re-plans | ${s.replans} |`,
    `| First-try review pass rate | ${pct(s.firstTryReviewPasses, s.reviewedTasks)} |`,
    `| Check runs failed (before review) | ${s.failedCheckRuns} |`,
    `| Tasks done | ${s.tasksDone} of ${s.tasks} |`,
    `| Escalations | ${s.escalations} |`,
    `| Tool calls (allowed / denied / duplicate / failed) | ${s.toolCalls.allowed} / ${s.toolCalls.denied} / ${s.toolCalls.duplicate} / ${s.toolCalls.failed} |`,
    `| Tokens (all agents) | ${s.tokens} |`,
  ];
  if (extras.wallSeconds !== undefined) lines.push(`| Wall time | ${Math.round(extras.wallSeconds)} s |`);
  if (extras.peakModelMb !== undefined) lines.push(`| Peak model memory (Ollama) | ${Math.round(extras.peakModelMb)} MB |`);
  if (extras.peakServerRssMb !== undefined) lines.push(`| Peak server memory (RSS) | ${Math.round(extras.peakServerRssMb)} MB |`);

  lines.push('', '## Goals', '', '| Goal | Status | Plan attempts | Planning tokens | Review tokens |', '| --- | --- | --- | --- | --- |');
  for (const g of report.goals) lines.push(`| ${cell(g.text)} | ${g.status} | ${g.planAttempts} | ${g.planningTokens} | ${g.reviewTokens} |`);

  lines.push('', '## Tasks', '', '| Task | Owner | State | Turns | Tokens | Reviews | Agent time | Notes |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const t of report.tasks) {
    const notes = [
      t.escalationReason ? `escalated: ${t.escalationReason}` : '',
      t.action ? `${t.action.tool} ${t.action.ok ? 'executed' : 'failed'}: ${t.action.detail}` : '',
    ].filter(Boolean);
    lines.push(
      `| ${cell(t.title)} | ${t.ownerId} | ${t.state} | ${t.steps} | ${t.tokens} | ${t.reviews.join(', ') || '-'} | ${t.seconds === null ? '-' : `${t.seconds} s`} | ${cell(notes.join('; ')) || '-'} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}
