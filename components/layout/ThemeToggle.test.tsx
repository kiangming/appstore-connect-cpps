/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the dark-mode toggle. Mocks next-themes so we can drive
 * resolvedTheme deterministically.
 */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "./ThemeToggle";

const setThemeMock = vi.fn();
const themeState = { resolvedTheme: "light" as "light" | "dark" };

vi.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: themeState.resolvedTheme,
    setTheme: setThemeMock,
  }),
}));

beforeEach(() => {
  setThemeMock.mockClear();
  themeState.resolvedTheme = "light";
});

describe("ThemeToggle", () => {
  it("renders an icon button (variant=icon)", () => {
    render(<ThemeToggle variant="icon" />);
    const btn = screen.getByRole("button");
    expect(btn).toBeInTheDocument();
  });

  it("clicking when light → setTheme('dark')", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle variant="icon" />);
    await user.click(screen.getByRole("button"));
    expect(setThemeMock).toHaveBeenCalledWith("dark");
  });

  it("clicking when dark → setTheme('light')", async () => {
    themeState.resolvedTheme = "dark";
    const user = userEvent.setup();
    render(<ThemeToggle variant="icon" />);
    await user.click(screen.getByRole("button"));
    expect(setThemeMock).toHaveBeenCalledWith("light");
  });

  it("variant=row renders a labeled button", () => {
    render(<ThemeToggle variant="row" />);
    const btn = screen.getByRole("button");
    expect(btn).toBeInTheDocument();
    // After mount, the row label reads "Dark mode" or "Light mode"
    // depending on resolvedTheme. We just verify some text rendered.
    expect(btn.textContent ?? "").toMatch(/mode|theme/i);
  });
});
