// Phase 2B WS9a real-stack end-to-end run. `pnpm test:phase2b:e2e` (needs Docker, infra:up, pnpm build).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as S from './lib/stack.mjs';
import { makeFixtures } from './lib/fixtures.mjs';
import { scenarios } from './scenarios.mjs';

S.prepareDirs();
const ctx = {
  notes: [],
  note(m) {
    this.cur.push(m);
  },
};
const results = [];
let db;
try {
  console.log(`test database: ${S.testDbName()} | storage: ${S.STORAGE} | redis db 14`);
  ctx.f = makeFixtures();
  db = await S.resetDatabase();
  ctx.db = db;
  await S.flushRedis();
  S.startAudio();
  S.startApi();
  S.startOrchestrator();
  await S.waitReady();
  for (const s of scenarios) {
    ctx.cur = [];
    const t0 = Date.now();
    try {
      await s.fn(ctx);
      results.push({ name: s.name, pass: true, ms: Date.now() - t0, notes: ctx.cur });
    } catch (e) {
      results.push({
        name: s.name,
        pass: false,
        ms: Date.now() - t0,
        notes: ctx.cur,
        error: S.redact(e.stack ?? e.message)
          .split('\n')
          .slice(0, 6)
          .join('\n'),
      });
    }
    const r = results.at(-1);
    console.log(
      `${r.pass ? 'PASS' : 'FAIL'} ${r.name} (${r.ms} ms)${r.notes.length ? '\n     ' + r.notes.join('\n     ') : ''}${r.error ? '\n' + r.error : ''}`,
    );
  }
} catch (e) {
  console.error('HARNESS ERROR', S.redact(e.stack ?? e.message));
  results.push({ name: 'harness', pass: false, error: S.redact(e.message) });
} finally {
  await S.teardown();
  await db?.handle.close();
}
writeFileSync(join(S.SCRATCH, 'last-e2e-results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
process.exit(failed ? 1 : 0);
