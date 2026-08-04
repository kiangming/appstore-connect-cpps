// @vitest-environment jsdom
/**
 * Apple apps-list page — asserts the "Download bulk import template"
 * call site renders (Manager UAT: the wizard-only placement was too
 * buried). One of the four guarded call sites of
 * components/ui/shared/DownloadTemplateButton.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { AppsListClient } from "./AppsListClient";

describe("AppsListClient (Apple) — template download call site", () => {
  it("renders the labeled Download bulk import template button in the header", () => {
    render(<AppsListClient apps={[]} />);
    expect(
      screen.getByRole("button", { name: /download bulk import template/i }),
    ).toBeInTheDocument();
  });
});
