import { describe, expect, it } from 'vitest';
import { matchRoute } from './router';

const ID = '22222222-2222-4222-8222-222222222222';

describe('matchRoute', () => {
  it.each([
    ['/', { name: 'dashboard' }],
    ['/recordings', { name: 'recordings' }],
    ['/reports', { name: 'reports' }],
    ['/pipeline', { name: 'pipeline' }],
    ['/recordings/new', { name: 'upload' }],
    [`/recordings/${ID}`, { name: 'recording', id: ID }],
    [`/recordings/${ID}/report`, { name: 'report', id: ID }],
    [`/recordings/${ID}/evidence`, { name: 'evidence', id: ID }],
  ])('%s', (path, route) => {
    expect(matchRoute(path)).toEqual(route);
  });

  it('ignores trailing slashes', () => {
    expect(matchRoute('/reports/')).toEqual({ name: 'reports' });
    expect(matchRoute(`/recordings/${ID}/report/`)).toEqual({ name: 'report', id: ID });
  });

  it('accepts upper-case uuids', () => {
    const up = ID.toUpperCase();
    expect(matchRoute(`/recordings/${up}/evidence`)).toEqual({ name: 'evidence', id: up });
  });

  it.each([
    '/nope',
    '/recordings/not-a-uuid',
    '/recordings/not-a-uuid/report',
    '/recordings/not-a-uuid/evidence',
    '/recordings/new/report',
    `/recordings/${ID}/other`,
    `/recordings/${ID}/report/extra`,
    `/recordings/${ID.slice(0, -1)}/report`,
    '/reports/extra',
    '/Pipeline',
  ])('%s is not found', (path) => {
    expect(matchRoute(path)).toEqual({ name: 'not-found' });
  });
});
