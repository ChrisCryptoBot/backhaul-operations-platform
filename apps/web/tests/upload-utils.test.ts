import { describe, expect, test } from "vitest";
import { splitUploadBatch, uploadDropzoneLabel } from "@/lib/ui/upload-utils";

describe("upload utils", () => {
  test("keeps valid PDFs when batch includes oversized files", () => {
    const files = [
      { name: "small.pdf", type: "application/pdf", size: 1024 },
      { name: "large.pdf", type: "application/pdf", size: 26 * 1024 * 1024 },
      { name: "email.msg", type: "application/vnd.ms-outlook", size: 1000 }
    ];
    const result = splitUploadBatch(files);
    expect(result.validFiles.map((file) => file.name)).toEqual(["small.pdf"]);
    expect(result.oversizedFiles.map((file) => file.name)).toEqual(["large.pdf"]);
    expect(result.rejectedFiles.map((file) => file.name)).toEqual(["email.msg"]);
  });

  test("toggles drag-over dropzone label", () => {
    expect(uploadDropzoneLabel(false)).toBe("Drop rate cons here");
    expect(uploadDropzoneLabel(true)).toBe("Release to upload");
  });
});
