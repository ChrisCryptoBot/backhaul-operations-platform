import sharp from "sharp";

/**
 * A picture made ready for a factoring packet (docs/MONEY_PLAN.md, rule B): turned the right way up from its camera tag, fitted inside 1600 pixels on its longest side (never enlarged),
 * laid on white where it was transparent, and saved as a JPEG at quality 75. A phone photo of a signed proof of delivery goes from several megabytes to a few hundred kilobytes and stays
 * readable when printed, so a packet of several loads fits a factor's mailbox. The camera tags (location among them) are not carried over.
 */
export const PACKET_IMAGE_MAX_PX = 1600;
export const PACKET_IMAGE_QUALITY = 75;
/** The picture types the packet takes and turns into JPEG. A phone's HEIC photo is not among them: the desk's image library cannot read it. */
export const PACKET_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/tiff", "image/avif"] as const;

export const isPacketImage = (mime: string): boolean => (PACKET_IMAGE_TYPES as readonly string[]).includes(mime);

export async function normalizePacketImage(bytes: Uint8Array | Buffer): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(bytes, { failOn: "error", limitInputPixels: 100_000_000 })
    .rotate()
    .resize({ width: PACKET_IMAGE_MAX_PX, height: PACKET_IMAGE_MAX_PX, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: PACKET_IMAGE_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { jpeg: data, width: info.width, height: info.height };
}
