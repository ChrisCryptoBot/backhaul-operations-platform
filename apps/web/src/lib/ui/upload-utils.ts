export const MAX_UPLOAD_FILES = 5;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface UploadFileLike {
  name: string;
  type: string;
  size: number;
}

export function isPdfUpload(file: UploadFileLike): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function splitUploadBatch<T extends UploadFileLike>(files: T[]) {
  const acceptedFiles = files.filter(isPdfUpload);
  const rejectedFiles = files.filter((file) => !isPdfUpload(file));
  const oversizedFiles = acceptedFiles.filter((file) => file.size > MAX_UPLOAD_BYTES);
  const validFiles = acceptedFiles.filter((file) => file.size <= MAX_UPLOAD_BYTES);
  return { acceptedFiles, rejectedFiles, oversizedFiles, validFiles };
}

export function uploadDropzoneLabel(isDragActive: boolean): string {
  return isDragActive ? "Release to upload" : "Drop rate cons here";
}

/** Read a browser File as base64 (the data-URL payload only), for JSON upload bodies. */
export async function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unable to read file."));
        return;
      }
      const base64 = result.split(",")[1];
      if (!base64) {
        reject(new Error("Unable to encode file."));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Unable to read file."));
    reader.readAsDataURL(file);
  });
}
