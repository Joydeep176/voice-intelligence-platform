import { decideRunSweep } from './sweeper';

describe('decideRunSweep', () => {
  it('requeues while retries remain, fails once the bound is reached', () => {
    expect(decideRunSweep(0, 3)).toBe('requeue');
    expect(decideRunSweep(2, 3)).toBe('requeue');
    expect(decideRunSweep(3, 3)).toBe('fail');
    expect(decideRunSweep(0, 0)).toBe('fail');
  });
});
