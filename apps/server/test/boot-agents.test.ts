import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScriptedProvider } from '@ai-company/agents';
import { boot, configFromEnv } from '../src/boot.ts';
import { SqliteCheckpointStore } from '../src/sqlite-checkpoint-store.ts';

const TEST_TEAM = fileURLToPath(new URL('../config/test-team.json', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TOKEN = 'boot-agents-token-0123456789';

describe('booting with agents', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-company-boot-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('env config: agents are off unless AGENTS=on; workspace and Ollama have local defaults', () => {
    const base = { CEO_TOKEN: TOKEN };
    const off = configFromEnv(base);
    assert.deepEqual(off.agents, { enabled: false, workspaceDir: join(REPO, 'workspace'), ollamaUrl: 'http://127.0.0.1:11434' });
    assert.equal(off.dataDir, join(REPO, 'data'));
    const on = configFromEnv({ ...base, AGENTS: 'on', WORKSPACE_DIR: 'ws', OLLAMA_URL: 'http://127.0.0.1:9999', DATA_DIR: '/srv/x' });
    assert.deepEqual(on.agents, { enabled: true, workspaceDir: resolve('ws'), ollamaUrl: 'http://127.0.0.1:9999' });
    assert.deepEqual(on.store, { kind: 'sqlite', path: '/srv/x/company.db' });
    assert.throws(() => configFromEnv({ ...base, AGENTS: 'yes' }), /AGENTS must be "on" or "off"/);  });

  test('the workspace may not hold the event log, the checkpoints or the CEO config', () => {
    const base = { CEO_TOKEN: TOKEN, DATA_DIR: '/srv/co/data', COMPANY_CONFIG: '/srv/co/config/company.json' };
    assert.throws(() => configFromEnv({ ...base, WORKSPACE_DIR: '/srv/co' }), /must not contain each other/);
    assert.throws(() => configFromEnv({ ...base, WORKSPACE_DIR: '/srv/co/data' }), /must not contain each other/);
    assert.throws(() => configFromEnv({ ...base, WORKSPACE_DIR: '/srv/co/data/ws' }), /must not contain each other/);
    assert.throws(() => configFromEnv({ ...base, WORKSPACE_DIR: '/srv/co/config' }), /company config/);
    assert.equal(configFromEnv({ ...base, WORKSPACE_DIR: '/srv/co/workspace' }).agents.workspaceDir, '/srv/co/workspace');
    assert.equal(configFromEnv({ ...base, WORKSPACE_DIR: '/srv/co/database' }).agents.workspaceDir, '/srv/co/database', 'a sibling with a shared prefix is fine');
    // The repo defaults never overlap.
    assert.doesNotThrow(() => configFromEnv({ CEO_TOKEN: TOKEN }));
  });

  test('checkpoints survive a restart, and only one server may hold the file', () => {
    const path = join(dir, 'data', 'agents.db');
    const first = SqliteCheckpointStore.open({ path });
    first.save({ taskId: 't1', agentId: 'kai', run: 5, attempt: 0, messages: [{ role: 'user', content: 'hi \u0000 there' }] });
    first.save({ taskId: 't1', agentId: 'kai', run: 5, attempt: 1, messages: [{ role: 'user', content: 'again' }] });
    assert.throws(() => SqliteCheckpointStore.open({ path, lockTimeoutMs: 100 }), /another server/);
    first.close();
    const second = SqliteCheckpointStore.open({ path });
    assert.deepEqual(second.load('t1', 'kai'), { taskId: 't1', agentId: 'kai', run: 5, attempt: 1, messages: [{ role: 'user', content: 'again' }] });
    assert.equal(second.load('t1', 'zara'), undefined);
    second.close();
  });

  test('AGENTS=on starts the runtime after boot; a CEO goal gets planned; stop shuts it down', async () => {
    const config = {
      ...configFromEnv({ CEO_TOKEN: TOKEN, AGENTS: 'on', DATA_DIR: join(dir, 'data'), WORKSPACE_DIR: join(dir, 'workspace'), COMPANY_CONFIG: TEST_TEAM, PORT: '0' }),
    };
    const ava = new ScriptedProvider([
      {
        text: JSON.stringify({
          tasks: [{ key: 'brief', title: 'Write the brief', acceptanceCriteria: ['It exists'], ownerId: 'kai', requiredTools: ['files.write'], dependsOn: [], costEstimateTokens: 1_000 }],
        }),
      },
    ]);
    const running = await boot(config, { onFatal: () => {}, modelFor: (agent) => (agent.id === 'ava' ? { provider: ava, model: 'scripted' } : undefined) });
    try {
      assert.ok(existsSync(join(dir, 'data', 'agents.db')));
      assert.ok(existsSync(join(dir, 'workspace')));
      const res = await fetch(`${running.url}/goals`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Write a brief', budgetTokens: 50_000 }),
      });
      const goal = (await res.json()) as { id: string };
      const deadline = Date.now() + 5_000;
      let state: any;
      do {
        await new Promise((r) => setTimeout(r, 20));
        state = await (await fetch(`${running.url}/state`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
      } while (state.goals.find((g: any) => g.id === goal.id).status !== 'planned' && Date.now() < deadline);
      assert.equal(state.goals.find((g: any) => g.id === goal.id).status, 'planned');
      assert.deepEqual(state.tasks.map((t: any) => [t.title, t.ownerId, t.state]), [['Write the brief', 'kai', 'assigned']]);
    } finally {
      await running.stop();
    }
    // Stopped cleanly: the files can be opened again.
    SqliteCheckpointStore.open({ path: join(dir, 'data', 'agents.db') }).close();
  });
});
