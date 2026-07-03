// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { copyText } from "@/lib/ui/clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("copyText", () => {
  test("uses the async Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  test("falls back to execCommand when writeText rejects", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const exec = vi.fn().mockReturnValue(true);
    // jsdom provides document; stub execCommand.
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    await expect(copyText("fallback")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  test("never throws and returns false when nothing works", async () => {
    vi.stubGlobal("navigator", {});
    (document as unknown as { execCommand: unknown }).execCommand = () => {
      throw new Error("boom");
    };
    await expect(copyText("x")).resolves.toBe(false);
  });
});
