import { parseRange } from './range';

describe('parseRange', () => {
  const size = 1000;

  it.each([
    [undefined, { kind: 'full' }],
    ['bytes=0-99', { kind: 'partial', start: 0, end: 99 }],
    ['bytes=900-', { kind: 'partial', start: 900, end: 999 }],
    ['bytes=-100', { kind: 'partial', start: 900, end: 999 }],
    ['bytes=-5000', { kind: 'partial', start: 0, end: 999 }],
    ['bytes=500-5000', { kind: 'partial', start: 500, end: 999 }],
    ['bytes=999-999', { kind: 'partial', start: 999, end: 999 }],
    ['bytes=1000-', { kind: 'unsatisfiable' }],
    ['bytes=2000-3000', { kind: 'unsatisfiable' }],
    ['bytes=50-10', { kind: 'unsatisfiable' }],
    ['bytes=-0', { kind: 'unsatisfiable' }],
    ['bytes=0-99,200-299', { kind: 'full' }],
    ['items=0-99', { kind: 'full' }],
    ['bytes=', { kind: 'full' }],
    ['bytes=-', { kind: 'full' }],
    ['bytes=a-b', { kind: 'full' }],
    ['bytes=0-99-', { kind: 'full' }],
    ['garbage', { kind: 'full' }],
    ['bytes=99999999999999999999-', { kind: 'full' }],
  ])('%s', (header, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });

  it('serves an empty object in full', () => {
    expect(parseRange('bytes=0-10', 0)).toEqual({ kind: 'full' });
  });
});
