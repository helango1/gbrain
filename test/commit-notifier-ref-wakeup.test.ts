/**
 * The commit notifier's ref wakeup (src/core/commit-notifier.ts): a new non-.lock file under refs/heads is the last
 * step of a commit, so the watch event runs the next step at once instead of after the 250 ms nudge. Driven through
 * the notifier's seams with a recorded timer queue: no timer fires on its own, each test fires the armed timer and
 * asserts its delay, the start and the recorded decisions. What it protects:
 *   - a branch ref renamed into place under refs/heads arms a 0 ms step and starts the sync at the new HEAD;
 *   - a `.lock` file under refs/heads and any event outside refs/heads keep the 250 ms nudge;
 *   - a ref event while git still holds index.lock defers (`defer_git_busy`), and the index.lock removal event that
 *     follows re-arms the 250 ms nudge, which starts the sync at the new HEAD: the commit is not lost.
 */
import { describe, expect, test } from 'bun:test';
import { startCommitNotifier, type JobStatus } from '../src/core/commit-notifier.ts';
import { memoryNotifierStore } from './helpers/notifier-memory-store.ts';

const sha = (c: string) => c.repeat(40);
const A = sha('a'), B = sha('b');
const GIT_DIR = '/brains/acme-example/.git';
const HEADS = `${GIT_DIR}/refs/heads`;

interface Timer { fn: () => void; ms: number }

function harness() {
  const s = { t: 1_000_000, head: A, dbCommit: A as string | null, quiet: true, starts: [] as Array<{ id: string; head: string }>,
    jobs: new Map<string, JobStatus>(), timers: [] as Timer[], onChange: null as null | ((dir?: string, file?: string | null) => void) };
  const w = startCommitNotifier({
    resident: 'serve', log: () => {}, hostId: 'host-example', pollMs: 3000, quietMs: 400, env: {},
    store: memoryNotifierStore({ lastCommit: () => s.dbCommit }),
    now: () => s.t,
    setInterval: () => 'interval', clearInterval: () => {},
    setTimeout: (fn, ms) => { const timer = { fn, ms }; s.timers.push(timer); return timer; },
    clearTimeout: (h) => { s.timers = s.timers.filter(t => t !== h); },
    readFlag: async () => true,
    listSources: async () => [{ sourceId: 'acme-example', root: '/brains/acme-example', gitDir: GIT_DIR, lastCommit: s.dbCommit }],
    lastCommit: async () => s.dbCommit,
    revParse: async () => s.head,
    quiet: () => s.quiet,
    startSync: async (id) => { const jobId = `job-${s.starts.length + 1}`; s.starts.push({ id, head: s.head }); s.jobs.set(jobId, { state: 'running' }); return { jobId }; },
    jobStatus: (jobId) => s.jobs.get(jobId) ?? null,
    watch: (_source, onChange) => { s.onChange = onChange; return () => {}; },
  });
  /** Lets the step a fired timer started run to the end (every seam resolves at once). */
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  const armed = () => s.timers.map(t => t.ms);
  const fire = async (ms: number) => {
    const timer = s.timers.find(t => t.ms === ms);
    if (!timer) throw new Error(`no ${ms} ms timer armed (armed: ${armed().join(', ') || 'none'})`);
    s.timers = s.timers.filter(t => t !== timer);
    timer.fn();
    await settle();
  };
  const decisions = (kind: string) => w.decisions.filter(d => d.decision === kind);
  return { w, s, armed, fire, decisions, event: (dir: string, file: string | null) => s.onChange!(dir, file) };
}

describe('commit notifier ref wakeup', () => {
  test('a new branch ref under refs/heads runs the next step at once and starts the sync at the new HEAD', async () => {
    const h = harness();
    await h.w.tick();
    expect(h.s.onChange).not.toBeNull();
    expect(h.s.starts).toEqual([]);
    h.s.head = B;
    h.event(HEADS, 'main');
    expect(h.armed()).toEqual([0]);
    await h.fire(0);
    expect(h.s.starts).toEqual([{ id: 'acme-example', head: B }]);
    expect(h.decisions('head_moved').map(d => d.detail)).toEqual([A.slice(0, 8), B.slice(0, 8)]);
    await h.w.stop();
  });

  test('a ref event replaces a pending nudge; a .lock file under refs/heads and other events keep the 250 ms nudge', async () => {
    const h = harness();
    await h.w.tick();
    h.event(GIT_DIR, 'index.lock');
    expect(h.armed()).toEqual([250]);
    h.event(HEADS, 'main.lock');
    h.event(GIT_DIR, 'HEAD');
    h.event(HEADS, null);
    expect(h.armed()).toEqual([250]);
    h.s.head = B;
    h.event(HEADS, 'main');
    expect(h.armed()).toEqual([0]);
    await h.fire(0);
    expect(h.s.starts).toEqual([{ id: 'acme-example', head: B }]);
    await h.w.stop();
  });

  test('git still busy at the ref event: the step defers, the index.lock removal re-arms the 250 ms nudge and the commit starts', async () => {
    const h = harness();
    await h.w.tick();
    h.s.head = B;
    h.s.quiet = false;
    h.event(HEADS, 'main');
    await h.fire(0);
    expect(h.s.starts).toEqual([]);
    expect(h.decisions('defer_git_busy')).toHaveLength(1);
    expect(h.armed()).toEqual([3020]);
    h.s.quiet = true;
    h.event(GIT_DIR, 'index.lock');
    expect(h.armed()).toEqual([3020, 250]);
    await h.fire(250);
    expect(h.s.starts).toEqual([{ id: 'acme-example', head: B }]);
    await h.w.stop();
  });
});
