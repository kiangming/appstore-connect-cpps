// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScreenshotPreview } from "./ScreenshotPreview";

describe("ScreenshotPreview", () => {
  it("renders a disabled placeholder when no thumbnail URL is provided", () => {
    render(<ScreenshotPreview />);
    const btn = screen.getByRole("button", { name: /no screenshot/i });
    expect(btn).toBeDisabled();
  });

  it("renders the thumbnail + meta line and opens the enlarge modal on click", () => {
    render(
      <ScreenshotPreview
        thumbnailUrl="https://example/x.png"
        fileName="diamond.png"
        metaLine="1290 × 2796 · 1.4 MB"
      />,
    );
    expect(screen.getByText("diamond.png")).toBeInTheDocument();
    expect(screen.getByText("1290 × 2796 · 1.4 MB")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /enlarge diamond/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes the modal when the backdrop is clicked", () => {
    render(
      <ScreenshotPreview
        thumbnailUrl="https://example/x.png"
        fileName="diamond.png"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /enlarge diamond/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
