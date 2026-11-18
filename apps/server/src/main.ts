import { boot, configFromEnv } from './boot.ts';

const running = await boot(configFromEnv());
// Tests and process managers wait for this line.
console.log(`listening on ${running.url}`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    running.stop().then(
      () => process.exit(0),
      (err) => {
        console.error(`[server] shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      },
    );
  });
}
