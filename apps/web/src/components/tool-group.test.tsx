// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolGroup } from "./tool-group";

afterEach(cleanup);

const rows = () => Array.from(document.querySelectorAll("[data-tool-status]"))
  .map((row) => [row.getAttribute("data-tool-status"), row.textContent]);

describe("ToolGroup", () => {
  it("names the running call in a collapsed row and lists every call when opened", async () => {
    const user = userEvent.setup();
    render(<ToolGroup calls={[
      { callId: "call-1", tool: "read", status: "completed", summary: "notes/verbs.md" },
      { callId: "call-2", tool: "bash", status: "running", summary: "ls -la" },
    ]} />);

    const trigger = screen.getByRole("button");
    expect(trigger.textContent).toBe("Running bash · ls -la2");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toEqual([]);

    await user.click(trigger);
    expect(rows()).toEqual([
      ["completed", "readnotes/verbs.mdcompleted"],
      ["running", "bashls -larunning"],
    ]);
  });

  it("counts failures once every call settled", () => {
    render(<ToolGroup calls={[
      { callId: "call-1", tool: "bash", status: "failed", summary: "missing-command" },
      { callId: "call-2", tool: "write", status: "completed", summary: "hello.md" },
    ]} />);
    expect(screen.getByRole("button").textContent).toBe("Used 2 tools · 1 failed");
  });
});
