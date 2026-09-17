import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function deriveKey(encKey: string): Buffer {
  const fromHex = Buffer.from(encKey, "hex");
  if (fromHex.length === 32) {
    return fromHex;
  }
  return createHash("sha256").update(encKey).digest();
}

/**
 * Encrypts a client secret at rest with AES-256-GCM. The raw secret must be
 * recoverable (not just hashed) because HMAC verification needs it. The master
 * key is a 32-byte value passed as hex or any string (hashed to 32 bytes).
 * Returns base64(iv || tag || ciphertext).
 */
export function encryptClientSecret(secret: string, encKey: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, deriveKey(encKey), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptClientSecret(blob: string, encKey: string): string {
  const buffer = Buffer.from(blob, "base64");
  if (buffer.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Invalid encrypted secret");
  }
  const iv = buffer.subarray(0, IV_LENGTH);
  const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, deriveKey(encKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}