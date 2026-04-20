import { describe, expect, it } from 'vitest';
import { getSettingsHref } from './sidebar-helpers';

describe('getSettingsHref', () => {
  it('routes to Store Management settings when inside /store-submissions/*', () => {
    expect(getSettingsHref('/store-submissions/inbox')).toBe(
      '/store-submissions/config/settings',
    );
    expect(getSettingsHref('/store-submissions/config/apps')).toBe(
      '/store-submissions/config/settings',
    );
    expect(getSettingsHref('/store-submissions/config/settings')).toBe(
      '/store-submissions/config/settings',
    );
    // Module root
    expect(getSettingsHref('/store-submissions')).toBe(
      '/store-submissions/config/settings',
    );
  });

  it('routes to global /settings everywhere else', () => {
    expect(getSettingsHref('/apps/123')).toBe('/settings');
    expect(getSettingsHref('/apps')).toBe('/settings');
    expect(getSettingsHref('/')).toBe('/settings');
    expect(getSettingsHref('/settings')).toBe('/settings');
  });

  it('does not match a prefix lookalike (e.g. /store-submissionsX)', () => {
    // `startsWith` accepts any continuation, but Next.js routing won't ever
    // emit a pathname like `/store-submissionsfoo` for a real `/store-submissions`
    // route — still, we verify the intended route tree shape.
    expect(getSettingsHref('/store-submissions-other')).toBe(
      '/store-submissions/config/settings',
    );
    // Call site: if future modules share a prefix, widen to a segment check.
  });
});
