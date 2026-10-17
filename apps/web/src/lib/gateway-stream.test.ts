import { describe, expect, it } from "vitest";
import { parseGatewayChatStream } from "./gateway-stream";

const ndjson = (...lines: unknown[]) => new Blob([lines.map((line) => `${JSON.stringify(line)}\n`).join("")]).stream();

async function collect(stream: ReadableStream<Uint8Array>) {
  const events = [];
  for await (const event of parseGatewayChatStream(stream)) events.push(event.type);
  return events;
}

describe("parseGatewayChatStream", () => {
  it("reads a whole turn", async () => {
    expect(await collect(ndjson(
      { seq: 0, type: "turn.started", chatId: "c1", turnId: "t1" },
      { seq: 1, type: "text.delta", delta: "hi" },
      { seq: 2, type: "turn.finished", status: "completed" },
    ))).toEqual(["turn.started", "text.delta", "turn.finished"]);
  });

  it("rejects an event out of sequence", async () => {
    await expect(collect(ndjson(
      { seq: 0, type: "turn.started", chatId: "c1", turnId: "t1" },
      { seq: 2, type: "text.delta", delta: "hi" },
    ))).rejects.toThrow("The harness chat stream is out of order.");
  });

  it("rejects a stream that does not open with turn.started", async () => {
    await expect(collect(ndjson({ seq: 0, type: "text.delta", delta: "hi" })))
      .rejects.toThrow("The harness chat stream is out of order.");
  });

  it("rejects a stream that ends before turn.finished", async () => {
    await expect(collect(ndjson(
      { seq: 0, type: "turn.started", chatId: "c1", turnId: "t1" },
      { seq: 1, type: "text.delta", delta: "hi" },
    ))).rejects.toThrow("The harness chat stream ended early.");
  });

  it("rejects an event with the wrong shape", async () => {
    await expect(collect(ndjson({ seq: 0, type: "turn.started", chatId: 7 })))
      .rejects.toThrow("The harness chat stream is invalid.");
  });
});
