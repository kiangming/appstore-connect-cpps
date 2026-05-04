// @vitest-environment jsdom

/**
 * Renderer tests for ReportsFilters (PR-22).
 *
 * The router + searchParams hooks are mocked so tests can assert that
 * a selection produces the right `router.push` URL without a real
 * Next.js navigation context.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { TypeRow } from '@/lib/store-submissions/queries/types';

const pushMock = vi.fn();
let currentSearch = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

import { ReportsFilters } from './ReportsFilters';

function makeType(over: Partial<TypeRow> = {}): TypeRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    platform_id: 'apple-platform-id',
    name: 'app',
    slug: 'app',
    sort_order: 1,
    ...over,
  };
}

beforeEach(() => {
  pushMock.mockReset();
  currentSearch = '';
});

describe('ReportsFilters', () => {
  it('renders "All types" as the default value when no type is selected', () => {
    render(<ReportsFilters types={[makeType()]} />);
    // "All types" renders twice — once in the pill's visible label and
    // once as the reset option inside the wrapped <select>. Both are
    // expected; the combobox value is the canonical state assertion.
    expect(screen.getAllByText('All types').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('renders the selected type name when selectedTypeId is provided', () => {
    const t1 = makeType({ id: 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'in-app purchase' });
    const t2 = makeType({ id: 'bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'custom product page' });
    render(<ReportsFilters types={[t1, t2]} selectedTypeId={t2.id} />);
    expect(screen.getAllByText('custom product page').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('combobox')).toHaveValue(t2.id);
  });

  it('falls back to "Unknown" when selectedTypeId points to a missing type', () => {
    render(
      <ReportsFilters
        types={[makeType({ id: 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })]}
        selectedTypeId="cccc3333-cccc-cccc-cccc-cccccccccccc"
      />,
    );
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('renders an option for every type plus the "All types" reset', () => {
    const types = [
      makeType({ id: '11111111-1111-1111-1111-111111111111', name: 'app' }),
      makeType({ id: '22222222-2222-2222-2222-222222222222', name: 'in-app purchase' }),
      makeType({ id: '33333333-3333-3333-3333-333333333333', name: 'custom product page' }),
    ];
    render(<ReportsFilters types={types} />);
    expect(screen.getByRole('option', { name: 'All types' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'app' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'in-app purchase' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'custom product page' })).toBeInTheDocument();
  });

  it('renders gracefully with an empty types array (only "All types")', () => {
    render(<ReportsFilters types={[]} />);
    expect(screen.getByRole('option', { name: 'All types' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('pushes ?type_id=<uuid> when a type is selected', () => {
    const t = makeType({ id: 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'app' });
    render(<ReportsFilters types={[t]} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: t.id } });
    expect(pushMock).toHaveBeenCalledWith(`?type_id=${t.id}`);
  });

  it('pushes a clean URL (no type_id param) when "All types" is selected', () => {
    currentSearch = 'type_id=aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const t = makeType({ id: 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    render(<ReportsFilters types={[t]} selectedTypeId={t.id} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(pushMock).toHaveBeenCalledWith('?');
  });
});
