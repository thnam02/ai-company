import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowEngine } from '@ai-company/core';
import { bootstrapAgents, buildPolicy, loadCompanyConfig, parseCompanyConfig } from '../src/company.ts';
import { DEFAULT_COMPANY_CONFIG, configFromEnv } from '../src/boot.ts';
import { MemoryDurableEventStore } from '../src/durable-store.ts';
import { TEST_CONFIG, must } from './helpers.ts';

const base = () => structuredClone(TEST_CONFIG) as any;

describe('company config', () => {
  test('the shipped config is valid and every tool has a tier', () => {
    const config = loadCompanyConfig(DEFAULT_COMPANY_CONFIG);
    assert.ok(config.agents.some((a) => a.kind === 'orchestrator'));
    assert.ok(config.agents.some((a) => a.kind === 'reviewer'));
    assert.ok(config.tools.find((t) => t.name === 'email.send')!.tier === 3);
  });

  test('rejects unsafe or malformed config', () => {
    const cases: [string, (c: any) => void, RegExp][] = [
      ['tools on a reviewer', (c) => (c.agents[3].tools = ['repo.read']), /only workers get tools/],
      ['bad tier', (c) => (c.tools[0].tier = 4), /tier of 0, 1, 2 or 3/],
      ['unknown limit', (c) => (c.limits = { maxFun: 1 }), /unknown limit/],
      ['non-positive limit', (c) => (c.limits = { maxSteps: 0 }), /positive number/],
      ['auto-approving a tier-3 tool', (c) => (c.autoApproveTier2 = ['email.send']), /known tier-2 tool/],
      ['duplicate agent', (c) => c.agents.push(c.agents[0]), /duplicate agent/],
      ['unknown kind', (c) => (c.agents[0].kind = 'ceo'), /unknown kind/],
      ['agent with an unknown tool', (c) => c.agents[1].tools.push('laser'), /unknown tools: laser/],
    ];
    for (const [name, mutate, error] of cases) {
      const c = base();
      mutate(c);
      assert.throws(() => parseCompanyConfig(c), error, name);
    }
  });

  test('bootstrap registers new agents and applies config changes through the engine', () => {
    const store = new MemoryDurableEventStore();
    const engine = new WorkflowEngine({ policy: buildPolicy(TEST_CONFIG), store });
    assert.deepEqual(must(bootstrapAgents(engine, TEST_CONFIG)).registered, ['ava', 'kai', 'omar', 'rex']);
    assert.equal(store.all().filter((e) => e.type === 'agent.registered').length, 4);
    assert.deepEqual(must(bootstrapAgents(engine, TEST_CONFIG)), { registered: [], updated: [], retired: [] }, 'unchanged config emits nothing');

    // The CEO revokes staging.deploy from Kai in the config file.
    const changed = base();
    changed.agents[1].tools = ['repo.read', 'github.create_branch'];
    assert.deepEqual(must(bootstrapAgents(engine, parseCompanyConfig(changed))), { registered: [], updated: ['kai'], retired: [] });
    assert.deepEqual(engine.getAgent('kai')!.tools, ['repo.read', 'github.create_branch']);
    assert.equal(store.all().at(-1)!.type, 'agent.updated');
  });

  test('an agent removed from the config loses its tools and is paused', () => {
    const store = new MemoryDurableEventStore();
    const engine = new WorkflowEngine({ policy: buildPolicy(TEST_CONFIG), store });
    must(bootstrapAgents(engine, TEST_CONFIG));
    const without = base();
    without.agents = without.agents.filter((a: any) => a.id !== 'kai');
    const config = parseCompanyConfig(without);
    assert.deepEqual(must(bootstrapAgents(engine, config)), { registered: [], updated: [], retired: ['kai'] });
    const kai = engine.getAgent('kai')!;
    assert.deepEqual(kai.tools, []);
    assert.equal(kai.paused, true);
    // Idempotent: the next boot with the same config changes nothing.
    const size = store.size;
    assert.deepEqual(must(bootstrapAgents(engine, config)), { registered: [], updated: [], retired: [] });
    assert.equal(store.size, size);
  });

  test('bootstrap fails closed when config changes an agent kind', () => {
    const engine = new WorkflowEngine({ policy: buildPolicy(TEST_CONFIG), store: new MemoryDurableEventStore() });
    must(bootstrapAgents(engine, TEST_CONFIG));
    const changed = base();
    changed.agents[3] = { ...changed.agents[3], kind: 'worker', tools: ['repo.read'] };
    const r = bootstrapAgents(engine, parseCompanyConfig(changed));
    assert.equal(r.ok, false);
    assert.match((r as any).error, /Kinds cannot change/);
  });

  test('env config needs a long CEO token, binds to localhost, defaults to a local SQLite file', () => {
    const CEO_TOKEN = 'x'.repeat(16);
    assert.throws(() => configFromEnv({}), /CEO_TOKEN is required/);
    assert.throws(() => configFromEnv({ CEO_TOKEN: 'short' }), /at least 16/);
    const local = configFromEnv({ CEO_TOKEN });
    // Anchored to the repo, not the working directory, so every way of starting the server finds the same log.
    assert.deepEqual(local.store, { kind: 'sqlite', path: fileURLToPath(new URL('../../../data/company.db', import.meta.url)) });
    assert.deepEqual(configFromEnv({ CEO_TOKEN, DATA_DIR: 'elsewhere' }).store, { kind: 'sqlite', path: resolve('elsewhere', 'company.db') });
    assert.equal(local.host, '127.0.0.1');
    assert.equal(local.port, 4100);
    assert.deepEqual(configFromEnv({ CEO_TOKEN, DATA_DIR: '/srv/acme' }).store, { kind: 'sqlite', path: '/srv/acme/company.db' });
    // DATABASE_URL switches to Postgres.
    assert.deepEqual(configFromEnv({ CEO_TOKEN, DATABASE_URL: 'postgres://x', DB_SCHEMA: 'acme' }).store, { kind: 'postgres', databaseUrl: 'postgres://x', schema: 'acme' });
    assert.deepEqual(configFromEnv({ CEO_TOKEN, DATABASE_URL: 'postgres://x' }).store, { kind: 'postgres', databaseUrl: 'postgres://x', schema: 'public' });
  });
});
