// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appFetch, type AppCall } from "@/test/app-fetch";
import { startFakeGateway, type FakeGateway } from "@/test/fake-gateway";
import { FileEditor } from "./file-editor";

const realFetch = globalThis.fetch;
const hello = { path: "notes/hello.md", content: "hi\n", revision: "sha256:base", modifiedAt: "2026-10-17T10:00:00.000Z" };
let gateway: FakeGateway;
let calls: AppCall[];

beforeEach(async () => {
  gateway = await startFakeGateway();
  process.env.PI_TEMPLATE_HOME = gateway.home;
  gateway.files.set(hello.path, hello);
  calls = [];
  vi.stubGlobal("fetch", appFetch(realFetch, calls));
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  delete process.env.PI_TEMPLATE_HOME;
  await gateway.close();
});

const renderEditor = (invalidationToken = 0, onFileCreated = vi.fn()) => render(
  <FileEditor
    invalidationToken={invalidationToken}
    onBackToChat={() => undefined}
    onFileCreated={onFileCreated}
    path={hello.path}
    siblingNames={["hello.md"]}
  />,
);
const saves = () => calls.filter((call) => call.method === "PUT");

describe("FileEditor", () => {
  it("saves the edit on blur with the revision it was based on", async () => {
    const user = userEvent.setup();
    renderEditor();
    const text = await screen.findByDisplayValue("hi");

    await user.type(text, "there");
    await user.tab();

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
    expect(saves()).toEqual([
      { method: "PUT", url: "/api/workspace/file?path=notes%2Fhello.md", body: { content: "hi\nthere", baseRevision: "sha256:base" } },
    ]);
    expect(gateway.files.get(hello.path)?.content).toBe("hi\nthere");
  });

  it("shows the conflict bar when the file changed on disk, and Keep both writes a copy beside it", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    renderEditor(0, created);
    const text = await screen.findByDisplayValue("hi");
    gateway.files.set(hello.path, { ...hello, content: "changed by the agent\n", revision: "sha256:agent" });

    await user.type(text, "mine");
    await user.tab();

    expect(await screen.findByText("This file changed on disk while you were editing.")).toBeDefined();
    expect(screen.getByText("changed by the agent")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Keep both" }));

    await waitFor(() => expect(created).toHaveBeenCalledWith("notes/hello (my copy).md"));
    expect(gateway.files.get("notes/hello (my copy).md")?.content).toBe("hi\nmine");
    expect(screen.getByDisplayValue("changed by the agent")).toBeDefined();
  });

  it("says when a file is not text", async () => {
    gateway.notText.add(hello.path);
    renderEditor();

    expect(await screen.findByText("Not a text file. The editor opens UTF-8 text only.")).toBeDefined();
    expect((screen.getByRole("textbox", { name: "File text" }) as HTMLTextAreaElement).disabled).toBe(true);
  });
});
