import { decideSweep } from './sweeper';

describe('decideSweep', () => {
  it('requeues while attempts remain and fails once they are spent', () => {
    expect(decideSweep(0, 3)).toBe('requeue');
    expect(decideSweep(2, 3)).toBe('requeue');
    expect(decideSweep(3, 3)).toBe('fail');
    expect(decideSweep(7, 3)).toBe('fail');
  });
});
