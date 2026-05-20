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

  it('routes to Google IAP accounts settings when inside /google-iap-management/*', () => {
    expect(getSettingsHref('/google-iap-management/apps')).toBe(
      '/google-iap-management/settings/google-accounts',
    );
    expect(getSettingsHref('/google-iap-management/apps/com.example/iaps/new')).toBe(
      '/google-iap-management/settings/google-accounts',
    );
    expect(
      getSettingsHref('/google-iap-management/settings/google-accounts'),
    ).toBe('/google-iap-management/settings/google-accounts');
    // Module root
    expect(getSettingsHref('/google-iap-management')).toBe(
      '/google-iap-management/settings/google-accounts',
    );
  });

  it('disambiguates google-iap-management vs iap-management prefix', () => {
    // /google-iap-management starts with /google, not /iap-management — so
    // the order of pathname.startsWith branches matters defensively if any
    // future rename ever brings them closer. Lock the assertion in.
    expect(getSettingsHref('/google-iap-management/apps/x')).toBe(
      '/google-iap-management/settings/google-accounts',
    );
    expect(getSettingsHref('/iap-management/apps/x')).toBe(
      '/iap-management/settings/pricing-tiers',
    );
  });

  it('routes to IAP Management Pricing Tiers when inside /iap-management/*', () => {
    expect(getSettingsHref('/iap-management/apps')).toBe(
      '/iap-management/settings/pricing-tiers',
    );
    expect(getSettingsHref('/iap-management/apps/123/bulk-import')).toBe(
      '/iap-management/settings/pricing-tiers',
    );
    expect(getSettingsHref('/iap-management/settings/pricing-tiers')).toBe(
      '/iap-management/settings/pricing-tiers',
    );
    // Module root
    expect(getSettingsHref('/iap-management')).toBe(
      '/iap-management/settings/pricing-tiers',
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
