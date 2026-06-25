import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  dispatchTool: vi.fn(),
  getActiveCopilotConfig: vi.fn(async () => ({ provider: "anthropic", model: "claude-test", apiKey: "key" })),
  buildBoardContextDigest: vi.fn(async () => "")
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mocks.create };
  }
}));
vi.mock("@/server/llm/config", () => ({ getActiveCopilotConfig: mocks.getActiveCopilotConfig }));
vi.mock("@/server/copilot/context", () => ({ buildBoardContextDigest: mocks.buildBoardContextDigest }));
vi.mock("@/server/copilot/tools", () => ({ COPILOT_TOOLS: [], dispatchTool: mocks.dispatchTool }));

import { runCopilotTurn } from "@/server/copilot/agent";
import { PolicyViolationError } from "@/lib/policy-error";

const ctx = { userId: "u1", regionId: "r1", role: "COORDINATOR" as const, boardDate: "2026-06-18" };

function textResponse(text: string) {
  return { content: [{ type: "text", text }] };
}
function toolResponse(name: string, id: string, input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", name, id, input }] };
}

describe("copilot agent loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getActiveCopilotConfig.mockResolvedValue({ provider: "anthropic", model: "claude-test", apiKey: "key" });
    mocks.buildBoardContextDigest.mockResolvedValue("");
  });

  test("recovers from a thrown tool error and still returns a reply", async () => {
    mocks.create
      .mockResolvedValueOnce(toolResponse("move_load", "tu1", { loadId: "x", targetSectionId: "canceled" }))
      .mockResolvedValueOnce(textResponse("I couldn't move that — you don't have permission."));
    mocks.dispatchTool.mockRejectedValueOnce(new PolicyViolationError("Policy denies COORDINATOR WRITE on BOARD"));

    const result = await runCopilotTurn(ctx, { message: "cancel load x" });

    expect(result.reply).toMatch(/permission/i);
    // The model's 2nd call must have received the failure as a tool_result so it could recover.
    // (Scan blocks rather than positional — the messages array is mutated after each model call.)
    const msgs = mocks.create.mock.calls[1][0].messages as Array<{ role: string; content: unknown }>;
    const blocks = msgs.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []));
    const toolResult = blocks.find((b) => b.type === "tool_result");
    expect(toolResult?.is_error).toBe(true);
    expect(String(toolResult?.content)).toContain("forbidden");
  });

  test("round-trips the transcript across turns", async () => {
    mocks.create.mockResolvedValueOnce(textResponse("hi there"));
    const first = await runCopilotTurn(ctx, { message: "hello" });
    expect(first.transcript).toHaveLength(2); // user + assistant
    expect(first.transcript[0]).toMatchObject({ role: "user" });
    expect(first.transcript[1]).toMatchObject({ role: "assistant" });

    mocks.create.mockResolvedValueOnce(textResponse("second reply"));
    const second = await runCopilotTurn(ctx, { message: "again", transcript: first.transcript });
    // Memory preserved: the second turn builds on the first (prior 2 + new user + new assistant).
    expect(second.transcript).toHaveLength(4);
    expect(second.transcript[0]).toMatchObject({ role: "user", content: "hello" });
    expect(second.transcript[2]).toMatchObject({ role: "user", content: "again" });
  });

  test("honors the iteration budget when tools never stop", async () => {
    mocks.create.mockResolvedValue(toolResponse("get_board_summary", "t", {}));
    mocks.dispatchTool.mockResolvedValue({ content: { ok: true } });

    await runCopilotTurn(ctx, { message: "loop forever" });

    expect(mocks.create.mock.calls.length).toBe(12); // default COPILOT_MAX_ITERATIONS
  });
});
