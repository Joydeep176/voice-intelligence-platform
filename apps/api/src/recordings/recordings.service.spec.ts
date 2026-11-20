import { expectedPartSize } from './recordings.service';

describe('expectedPartSize', () => {
  it('uses the part size for all but the last part', () => {
    expect(expectedPartSize(25, 10, 3, 1)).toBe(10);
    expect(expectedPartSize(25, 10, 3, 2)).toBe(10);
    expect(expectedPartSize(25, 10, 3, 3)).toBe(5);
  });

  it('handles an exact multiple and a single part', () => {
    expect(expectedPartSize(20, 10, 2, 2)).toBe(10);
    expect(expectedPartSize(7, 10, 1, 1)).toBe(7);
  });
});
