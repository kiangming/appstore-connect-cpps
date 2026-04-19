import { describe, expect, it } from 'vitest';

import { matchSender } from './sender-matcher';
import type { RulesSnapshot, Sender } from './types';

const PLATFORM_ID = '11111111-1111-4111-8111-111111111111';

function rules(senders: Sender[]): RulesSnapshot {
  return {
    platform_id: PLATFORM_ID,
    platform_key: 'apple',
    senders,
    subject_patterns: [],
    types: [],
    submission_id_patterns: [],
    apps_with_aliases: [],
  };
}

const active = (email: string, is_primary = false): Sender => ({
  id: 's-' + email,
  email,
  is_primary,
  active: true,
});

describe('matchSender', () => {
  it('matches exact lowercase', () => {
    const r = matchSender(
      { sender: 'no-reply@apple.com', subject: '', body: '' },
      rules([active('no-reply@apple.com', true)]),
    );
    expect(r).toEqual({
      platform_id: PLATFORM_ID,
      platform_key: 'apple',
      sender_email: 'no-reply@apple.com',
    });
  });

  it('matches case-insensitively on both sides', () => {
    const r = matchSender(
      { sender: 'No-Reply@APPLE.COM', subject: '', body: '' },
      rules([active('NO-reply@apple.COM')]),
    );
    expect(r?.sender_email).toBe('NO-reply@apple.COM');
  });

  it('extracts email from "Display Name <email@host>" wrapper', () => {
    const r = matchSender(
      { sender: 'Apple Support <no-reply@apple.com>', subject: '', body: '' },
      rules([active('no-reply@apple.com')]),
    );
    expect(r).not.toBeNull();
  });

  it('trims whitespace around sender', () => {
    const r = matchSender(
      { sender: '   no-reply@apple.com   ', subject: '', body: '' },
      rules([active('no-reply@apple.com')]),
    );
    expect(r).not.toBeNull();
  });

  it('returns null when no sender configured', () => {
    expect(
      matchSender({ sender: 'x@y.com', subject: '', body: '' }, rules([])),
    ).toBeNull();
  });

  it('returns null on empty sender string', () => {
    expect(
      matchSender({ sender: '', subject: '', body: '' }, rules([active('x@y.com')])),
    ).toBeNull();
  });

  it('returns null on whitespace-only sender', () => {
    expect(
      matchSender(
        { sender: '   ', subject: '', body: '' },
        rules([active('x@y.com')]),
      ),
    ).toBeNull();
  });

  it('skips inactive senders even when email matches', () => {
    const inactive: Sender = {
      id: 'x',
      email: 'no-reply@apple.com',
      is_primary: true,
      active: false,
    };
    const r = matchSender(
      { sender: 'no-reply@apple.com', subject: '', body: '' },
      rules([inactive]),
    );
    expect(r).toBeNull();
  });

  it('returns first active hit when multiple senders share email (defensive — DB UNIQUE prevents this, but the matcher cannot assume)', () => {
    const a1 = { ...active('dup@apple.com'), id: 'first' };
    const a2 = { ...active('dup@apple.com'), id: 'second' };
    const r = matchSender(
      { sender: 'dup@apple.com', subject: '', body: '' },
      rules([a1, a2]),
    );
    expect(r).not.toBeNull();
  });
});
