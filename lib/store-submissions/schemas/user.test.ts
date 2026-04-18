import { describe, expect, it } from 'vitest';
import {
  createUserSchema,
  disableUserSchema,
  editUserFormSchema,
  normalizeDisplayName,
  storeRoleSchema,
  storeUserStatusSchema,
  updateUserSchema,
} from './user';

describe('storeRoleSchema', () => {
  it.each(['MANAGER', 'DEV', 'VIEWER'])('accepts role %s', (role) => {
    expect(storeRoleSchema.parse(role)).toBe(role);
  });

  it('rejects unknown roles', () => {
    expect(() => storeRoleSchema.parse('ADMIN')).toThrow();
    expect(() => storeRoleSchema.parse('manager')).toThrow();
  });
});

describe('storeUserStatusSchema', () => {
  it.each(['active', 'disabled'])('accepts status %s', (status) => {
    expect(storeUserStatusSchema.parse(status)).toBe(status);
  });

  it('rejects unknown status', () => {
    expect(() => storeUserStatusSchema.parse('ACTIVE')).toThrow();
  });
});

describe('createUserSchema', () => {
  it('normalizes email (trim + lowercase)', () => {
    const result = createUserSchema.parse({
      email: '  User@Company.COM  ',
      role: 'DEV',
    });
    expect(result.email).toBe('user@company.com');
  });

  it('trims but does not auto-null empty display_name (caller normalizes)', () => {
    const result = createUserSchema.parse({
      email: 'user@company.com',
      role: 'DEV',
      display_name: '   ',
    });
    expect(result.display_name).toBe('');
  });

  it('preserves non-empty display_name', () => {
    const result = createUserSchema.parse({
      email: 'user@company.com',
      role: 'DEV',
      display_name: '  Alice  ',
    });
    expect(result.display_name).toBe('Alice');
  });

  it('rejects missing email', () => {
    expect(() =>
      createUserSchema.parse({ role: 'DEV' } as never)
    ).toThrow();
  });

  it('rejects invalid email format', () => {
    expect(() =>
      createUserSchema.parse({ email: 'not-an-email', role: 'DEV' })
    ).toThrow();
  });

  it('rejects missing role', () => {
    expect(() =>
      createUserSchema.parse({ email: 'user@company.com' } as never)
    ).toThrow();
  });

  it('rejects invalid role', () => {
    expect(() =>
      createUserSchema.parse({ email: 'user@company.com', role: 'OWNER' })
    ).toThrow();
  });
});

describe('updateUserSchema', () => {
  it('accepts partial updates', () => {
    const result = updateUserSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      role: 'DEV',
    });
    expect(result.role).toBe('DEV');
    expect(result.status).toBeUndefined();
  });

  it('accepts status update', () => {
    const result = updateUserSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'disabled',
    });
    expect(result.status).toBe('disabled');
  });

  it('rejects non-UUID id', () => {
    expect(() =>
      updateUserSchema.parse({ id: 'not-a-uuid', role: 'DEV' })
    ).toThrow();
  });
});

describe('disableUserSchema', () => {
  it('accepts valid UUID', () => {
    const result = disableUserSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
    });
    expect(result.id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('rejects missing id', () => {
    expect(() => disableUserSchema.parse({})).toThrow();
  });
});

describe('editUserFormSchema', () => {
  const baseInput = {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'DEV' as const,
    status: 'active' as const,
  };

  it('requires role and status (form selects always have a value)', () => {
    const result = editUserFormSchema.parse(baseInput);
    expect(result.role).toBe('DEV');
    expect(result.status).toBe('active');
  });

  it('rejects missing role', () => {
    expect(() =>
      editUserFormSchema.parse({ ...baseInput, role: undefined } as never)
    ).toThrow();
  });

  it('rejects missing status', () => {
    expect(() =>
      editUserFormSchema.parse({ ...baseInput, status: undefined } as never)
    ).toThrow();
  });
});

describe('normalizeDisplayName', () => {
  it('returns null for undefined', () => {
    expect(normalizeDisplayName(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeDisplayName('')).toBeNull();
  });

  it('returns null for whitespace-only', () => {
    expect(normalizeDisplayName('   ')).toBeNull();
  });

  it('trims and returns non-empty', () => {
    expect(normalizeDisplayName('  Alice  ')).toBe('Alice');
  });
});
