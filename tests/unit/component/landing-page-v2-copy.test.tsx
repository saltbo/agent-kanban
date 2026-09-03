import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { LandingPage } from "../../../src/features/landing/LandingPage";

vi.mock("../../../src/features/landing/DemoBoard", () => ({ DemoBoard: () => React.createElement("div", null, "Board demo") }));

describe("LandingPage v2 product copy", () => {
  it("presents Agency, Enbor Runner, Realmroot Toolbox, and independent review without legacy architecture copy", () => {
    render(React.createElement(MemoryRouter, null, React.createElement(LandingPage)));

    expect(
      screen.getByText(
        /Agency coordinates your Agents, and Enbor Runner hosts self-hosted execution\. Realmroot gives them identity and Toolbox access\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Toolbox-Native Workflow")).toBeInTheDocument();
    expect(screen.getByText("Realmroot Agent Identity")).toBeInTheDocument();
    expect(screen.getByText("AMA Runtime Ownership")).toBeInTheDocument();
    expect(screen.getByText("Independent Review")).toBeInTheDocument();
    expect(screen.getByText(/the assigned Agent cannot reject or complete its own Review Submission/i)).toBeInTheDocument();

    for (const obsolete of [/leader[- ]worker/i, /Ed25519/i, /CLI runtime/i, /Watch Video/i]) {
      expect(screen.queryByText(obsolete)).not.toBeInTheDocument();
    }
  });
});
