// @vitest-environment jsdom

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PaginationControls } from './PaginationControls';

describe('PaginationControls', () => {
  const baseProps = {
    currentPage: 0,
    totalPages: 5,
    totalItems: 87,
    hasPrev: false,
    hasNext: true,
    onPrev: vi.fn(),
    onNext: vi.fn(),
  };

  it('renders "Page N of M · X items total" with 1-indexed page display', () => {
    const { getByText } = render(
      <PaginationControls {...baseProps} currentPage={2} />,
    );
    // currentPage=2 (0-indexed) → "Page 3 of 5"
    expect(getByText(/Page 3 of 5/)).toBeInTheDocument();
    expect(getByText(/87 items total/)).toBeInTheDocument();
  });

  it('singular "item" when totalItems === 1', () => {
    const { getByText } = render(
      <PaginationControls {...baseProps} totalItems={1} totalPages={1} />,
    );
    expect(getByText(/1 item total/)).toBeInTheDocument();
  });

  it('disables Prev when hasPrev=false (first page)', () => {
    const { getByLabelText } = render(<PaginationControls {...baseProps} />);
    const prev = getByLabelText('Previous page') as HTMLButtonElement;
    const next = getByLabelText('Next page') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
  });

  it('disables Next when hasNext=false (last page)', () => {
    const { getByLabelText } = render(
      <PaginationControls
        {...baseProps}
        currentPage={4}
        hasPrev={true}
        hasNext={false}
      />,
    );
    expect((getByLabelText('Previous page') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((getByLabelText('Next page') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('invokes onPrev / onNext on click when enabled', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { getByLabelText } = render(
      <PaginationControls
        {...baseProps}
        currentPage={2}
        hasPrev={true}
        hasNext={true}
        onPrev={onPrev}
        onNext={onNext}
      />,
    );
    fireEvent.click(getByLabelText('Previous page'));
    fireEvent.click(getByLabelText('Next page'));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
