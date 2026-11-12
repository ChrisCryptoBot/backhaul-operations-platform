import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { isPacketImage, normalizePacketImage, PACKET_IMAGE_MAX_PX } from "@/server/partners/packet-image";

/** Rule B of docs/MONEY_PLAN.md: every picture in a factoring packet is fitted inside 1600 px and saved as a JPEG at quality 75, so phone photos fit a factor's mailbox. */

/** A 12-megapixel phone-sized photo of noise (noise does not compress, so it is the worst case), with a camera tag that says "turn me a quarter". */
async function phonePhoto(): Promise<Buffer> {
  const w = 4032;
  const h = 3024;
  const raw = Buffer.alloc(w * h * 3);
  let x = 12345;
  for (let i = 0; i < raw.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = x & 0xff;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
}

describe("pictures in a factoring packet", () => {
  test("a 12-megapixel photo comes out fitted inside 1600 px, turned upright from its camera tag, as a JPEG many times smaller", async () => {
    const photo = await phonePhoto();
    const out = await normalizePacketImage(photo);
    // Orientation 6 is a quarter turn: the 4032 x 3024 picture stands up as 1200 x 1600.
    expect([out.width, out.height]).toEqual([1200, 1600]);
    const meta = await sharp(out.jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.orientation ?? 1).toBe(1);
    expect(out.jpeg.length).toBeLessThan(photo.length / 4);
  }, 30_000);

  test("a small picture is not enlarged, and a transparent PNG is laid on white", async () => {
    const png = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const out = await normalizePacketImage(png);
    expect([out.width, out.height]).toEqual([300, 200]);
    const { data } = await sharp(out.jpeg).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(245); // white, not black
  });

  test("the picture types it takes, and twelve phone photos fit a 15 MB packet with room to spare", async () => {
    expect(isPacketImage("image/jpeg") && isPacketImage("image/png") && isPacketImage("image/webp")).toBe(true);
    expect(isPacketImage("image/heic")).toBe(false);
    expect(isPacketImage("application/pdf")).toBe(false);
    // Noise is the worst case for JPEG; twelve copies of it are what twelve loads' photos would weigh.
    const one = (await normalizePacketImage(await phonePhoto())).jpeg;
    expect(one.length * 12).toBeLessThan(15 * 1024 * 1024);
    expect(PACKET_IMAGE_MAX_PX).toBe(1600);
  }, 30_000);
});
