// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { FilterPill } from './FilterPill';

describe('FilterPill', () => {
  it('renders label, value, and children', () => {
    render(
      <FilterPill label="Type" value="App">
        <select data-testid="select">
          <option>foo</option>
        </select>
      </FilterPill>,
    );
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('App')).toBeInTheDocument();
    expect(screen.getByTestId('select')).toBeInTheDocument();
  });

  it('renders enabled state by default (no disabled, no dim)', () => {
    const { container } = render(
      <FilterPill label="Type" value="App">
        <span />
      </FilterPill>,
    );
    const label = container.querySelector('label')!;
    expect(label.className).toContain('cursor-pointer');
    expect(label.className).toContain('bg-white');
    expect(label.className).not.toContain('cursor-not-allowed');
    expect(label.getAttribute('title')).toBeNull();
  });

  it('applies disabled styling and surfaces disabledHint as title', () => {
    const { container } = render(
      <FilterPill
        label="Type"
        value="All"
        disabled
        disabledHint="Select platform first"
      >
        <span />
      </FilterPill>,
    );
    const label = container.querySelector('label')!;
    expect(label.className).toContain('cursor-not-allowed');
    expect(label.className).toContain('text-slate-300');
    expect(label.className).toContain('bg-slate-50');
    expect(label.getAttribute('title')).toBe('Select platform first');
  });

  it('applies dim styling (interactive, no tooltip)', () => {
    const { container } = render(
      <FilterPill label="Type" value="All" dim>
        <span />
      </FilterPill>,
    );
    const label = container.querySelector('label')!;
    expect(label.className).toContain('text-slate-400');
    expect(label.className).toContain('cursor-pointer');
    expect(label.className).not.toContain('cursor-not-allowed');
    expect(label.getAttribute('title')).toBeNull();
  });

  it('disabled overrides dim when both are true', () => {
    const { container } = render(
      <FilterPill
        label="Type"
        value="All"
        disabled
        disabledHint="hint"
        dim
      >
        <span />
      </FilterPill>,
    );
    const label = container.querySelector('label')!;
    expect(label.className).toContain('cursor-not-allowed');
    expect(label.className).toContain('text-slate-300');
    expect(label.getAttribute('title')).toBe('hint');
  });
});
