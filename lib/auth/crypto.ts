import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

export function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

const VERSION = "v1";

// AES-256-GCM. `context` is bound as additional authenticated data so a
// ciphertext copied into another column or another user's row fails to decrypt.
export function encrypt(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv, ciphertext, cipher.getAuthTag()]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decrypt(key: Buffer, sealed: string, context: string): string {
  const [version, iv, ciphertext, tag] = sealed.split(".");
  if (version !== VERSION || !iv || !ciphertext || !tag) {
    throw new Error("Unrecognized ciphertext format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
