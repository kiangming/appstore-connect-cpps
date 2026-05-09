// @vitest-environment jsdom

/**
 * Renderer tests for DateRangePicker (PR-Reports.C).
 *
 * Mirrors ReportsFilters test pattern: router + searchParams hooks
 * mocked so a selection produces the right `router.push` URL without a
 * real Next.js navigation context. System time is frozen to a known
 * date so day-arithmetic assertions are deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const pushMock = vi.fn();
let currentSearch = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

import { DateRangePicker } from './DateRangePicker';

const FIXED_NOW = new Date('2026-05-09T12:00:00Z');

beforeEach(() => {
  pushMock.mockReset();
  currentSearch = '';
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DateRangePicker', () => {
  it('renders default values (last 30 days) when no props provided', () => {
    render(<DateRangePicker />);
    expect(screen.getByLabelText('From date')).toHaveValue('2026-04-09');
    expect(screen.getByLabelText('To date')).toHaveValue('2026-05-09');
  });

  it('reflects from + to props in the inputs', () => {
    render(<DateRangePicker from="2026-01-01" to="2026-02-01" />);
    expect(screen.getByLabelText('From date')).toHaveValue('2026-01-01');
    expect(screen.getByLabelText('To date')).toHaveValue('2026-02-01');
  });

  it('does not render Reset link in default state', () => {
    render(<DateRangePicker />);
    expect(screen.queryByText('Reset to last 30 days')).not.toBeInTheDocument();
  });

  it('renders Reset link when range is custom', () => {
    render(<DateRangePicker from="2026-01-01" to="2026-02-01" />);
    expect(screen.getByText('Reset to last 30 days')).toBeInTheDocument();
  });

  it('clicking Reset link pushes a clean URL (no params)', () => {
    currentSearch = 'from=2026-01-01&to=2026-02-01';
    render(<DateRangePicker from="2026-01-01" to="2026-02-01" />);
    fireEvent.click(screen.getByText('Reset to last 30 days'));
    expect(pushMock).toHaveBeenCalledWith('?');
  });

  it('clicking 7d preset pushes ?from=<7d ago>&to=<today>', () => {
    render(<DateRangePicker />);
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    expect(pushMock).toHaveBeenCalledWith('?from=2026-05-02&to=2026-05-09');
  });

  it('clicking 30d preset clears params (clean URL = default)', () => {
    render(<DateRangePicker from="2026-01-01" to="2026-02-01" />);
    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    expect(pushMock).toHaveBeenCalledWith('?');
  });

  it('clicking 90d preset pushes a 90-day range to today', () => {
    render(<DateRangePicker />);
    fireEvent.click(screen.getByRole('button', { name: '90d' }));
    expect(pushMock).toHaveBeenCalledWith('?from=2026-02-08&to=2026-05-09');
  });

  it('clicking 1y preset pushes a 365-day range', () => {
    render(<DateRangePicker />);
    fireEvent.click(screen.getByRole('button', { name: '1y' }));
    expect(pushMock).toHaveBeenCalledWith('?from=2025-05-09&to=2026-05-09');
  });

  it('clicking 2y preset pushes a 730-day range (Manager Q5 max)', () => {
    render(<DateRangePicker />);
    fireEvent.click(screen.getByRole('button', { name: '2y' }));
    expect(pushMock).toHaveBeenCalledWith('?from=2024-05-09&to=2026-05-09');
  });

  it('marks the preset matching the current range as active', () => {
    // 7-day range to today → 7d preset should carry the active styling.
    render(<DateRangePicker from="2026-05-02" to="2026-05-09" />);
    const sevenDayBtn = screen.getByRole('button', { name: '7d' });
    expect(sevenDayBtn.className).toContain('bg-blue-50');
  });

  it('marks 30d preset active in default state (no params)', () => {
    render(<DateRangePicker />);
    const thirtyDayBtn = screen.getByRole('button', { name: '30d' });
    expect(thirtyDayBtn.className).toContain('bg-blue-50');
  });

  it('changing From date pushes updated ?from + preserves To', () => {
    render(<DateRangePicker />);
    fireEvent.change(screen.getByLabelText('From date'), {
      target: { value: '2026-03-01' },
    });
    expect(pushMock).toHaveBeenCalledWith('?from=2026-03-01&to=2026-05-09');
  });

  it('changing To date pushes updated ?to + preserves From', () => {
    render(<DateRangePicker from="2026-04-01" to="2026-05-01" />);
    fireEvent.change(screen.getByLabelText('To date'), {
      target: { value: '2026-05-05' },
    });
    expect(pushMock).toHaveBeenCalledWith('?from=2026-04-01&to=2026-05-05');
  });

  it('preserves unrelated URL params (e.g. type_id) when range changes', () => {
    currentSearch = 'type_id=aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    render(<DateRangePicker />);
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    expect(pushMock).toHaveBeenCalledWith(
      '?type_id=aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa&from=2026-05-02&to=2026-05-09',
    );
  });
});
