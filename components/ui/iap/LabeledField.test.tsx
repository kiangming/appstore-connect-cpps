// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LabeledField } from "./LabeledField";

describe("LabeledField", () => {
  it("renders the label and value together", () => {
    render(
      <LabeledField label="Product ID">
        <span>com.x.diamond</span>
      </LabeledField>,
    );
    expect(screen.getByText("Product ID")).toBeInTheDocument();
    expect(screen.getByText("com.x.diamond")).toBeInTheDocument();
  });

  it("renders the tooltip when `tip` is provided", () => {
    render(
      <LabeledField label="Reference Name" tip="Not visible to customers">
        <span>Tool product 18</span>
      </LabeledField>,
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Not visible to customers",
    );
  });

  it("renders the right-side hint slot (character counter pattern)", () => {
    render(
      <LabeledField label="Reference Name" hint="44 / 64">
        <span>Foo</span>
      </LabeledField>,
    );
    expect(screen.getByText("44 / 64")).toBeInTheDocument();
  });
});
