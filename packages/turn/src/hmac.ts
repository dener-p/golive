import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacSignature(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function verifyHmacSignature(secret: string, data: string, signature: string): boolean {
  const expected = Buffer.from(hmacSignature(secret, data), "hex");
  const provided = Buffer.from(signature ?? "", "hex");
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}