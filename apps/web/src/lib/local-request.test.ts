import { describe, expect, it } from "vitest";
import { assertLocalRequest, type LocalRequestKind } from "./local-request";

function refusal(headers: Record<string, string>, kind: LocalRequestKind = "read"): string | undefined {
  try {
    assertLocalRequest(new Request("http://127.0.0.1:47812/api/chats", { headers: { host: "127.0.0.1:47812", ...headers } }), kind);
    return undefined;
  } catch (error: unknown) {
    const { status, message } = error as { status: number; message: string };
    return `${status} ${message}`;
  }
}

describe("assertLocalRequest", () => {
  it("accepts the local browser", () => {
    expect(refusal({})).toBeUndefined();
    expect(refusal({ host: "localhost:47812", origin: "http://localhost:47812" })).toBeUndefined();
    expect(refusal({ origin: "http://127.0.0.1:47812", "content-type": "application/json; charset=utf-8" }, "json")).toBeUndefined();
    expect(refusal({ origin: "http://127.0.0.1:47812" }, "bodiless")).toBeUndefined();
  });

  it("refuses a foreign Host, a cross-site fetch, and a foreign Origin", () => {
    expect(refusal({ host: "evil.example:47812" })).toBe("403 This app only accepts local browser requests.");
    expect(refusal({ "sec-fetch-site": "cross-site" })).toBe("403 Cross-site requests are not allowed.");
    expect(refusal({ origin: "http://evil.example" })).toBe("403 Cross-origin requests are not allowed.");
    expect(refusal({ origin: "http://127.0.0.1:9999" }, "json")).toBe("403 Cross-origin requests are not allowed.");
  });

  it("refuses a JSON mutation that is not JSON", () => {
    expect(refusal({ "content-type": "text/plain" }, "json")).toBe("415 This request must use JSON.");
    expect(refusal({}, "json")).toBe("415 This request must use JSON.");
  });
});
