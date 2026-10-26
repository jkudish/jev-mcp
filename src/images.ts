import { createHash } from "node:crypto";
import { image, type DiscernImage } from "@jkudish/discern-sdk";
import { z } from "zod";

const MiB = 1024 * 1024;
export const imageSchema = z.object({
  mime_type: z.enum(["image/png", "image/jpeg"]),
  data_base64: z.string().min(4).max(1_398_104).describe("Canonical standard base64, no data URL. At most 1 MiB decoded."),
}).strict();
type ImageInput = z.infer<typeof imageSchema>;

/** Tool boundary shared by stdio, HTTP and embedded hosts. No file/network reads. */
export function prepareImageInputs(args: unknown, inputs: ImageInput[]): { value: DiscernImage; digest: string }[] {
  if (!inputs.length) return [];
  if (inputs.length > 4 || Buffer.byteLength(JSON.stringify(args)) > 4 * MiB) throw new Error("Image arguments exceed the count or 4 MiB argument limit");
  let total = 0;
  // Check all encoded/decoded bounds before allocating any decoded image.
  for (const input of inputs) {
    const encoded = input.data_base64;
    if (encoded.length > 1_398_104 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || !encoded.length) {
      throw new Error("Image must contain canonical standard base64");
    }
    const length = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    total += length;
    if (length > MiB || total > 2 * MiB) throw new Error("Image decoded bytes exceed 1 MiB per image or 2 MiB total");
  }
  return inputs.map((input) => {
    const bytes = Buffer.from(input.data_base64, "base64");
    if (bytes.toString("base64") !== input.data_base64) throw new Error("Image must contain canonical standard base64");
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!(input.mime_type === "image/png" ? png : jpeg)) throw new Error("Image signature does not match mime_type");
    return { value: image(bytes), digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  });
}

export const VISION_WARNING = "Experimental visual judgments: provider accuracy and thresholds are not calibrated for your workload; review before acting. Images are sent to the configured provider under its retention policy.";
