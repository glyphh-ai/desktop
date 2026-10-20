/**
 * secure-store — encrypt/decrypt JSON blobs at rest on the local filesystem.
 *
 * Same approach as pipedream-config.ts: Electron safeStorage
 * (OS keychain) when available, with a machine-derived AES-256-GCM fallback.
 * Used for any on-disk config that may hold secrets (e.g. an app's MCP OAuth
 * client secret).
 *
 * Reads are backward-compatible: a file written as plaintext JSON before
 * encryption was introduced still loads, and is re-encrypted on the next write.
 */

import crypto from "crypto";
import os from "os";
import { safeStorage } from "electron";

const FALLBACK_SALT = "yo-secure-store-v1";
const AES_MAGIC = Buffer.from("YOAES1");

function fallbackKey(): Buffer {
  const material = [os.hostname(), os.homedir(), os.platform(), os.arch()].join("|");
  return crypto.scryptSync(material, FALLBACK_SALT, 32);
}

/** Encrypt a JSON-serializable value to bytes for writing to disk. */
export function encryptJson(value: unknown): Buffer {
  const plain = JSON.stringify(value, null, 2);
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain);
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", fallbackKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  return Buffer.concat([AES_MAGIC, iv, cipher.getAuthTag(), enc]);
}

/** Decrypt bytes read from disk back to a value. Falls back to plaintext JSON
 *  for files written before encryption (one-time migration on next save). */
export function decryptJson<T>(buf: Buffer): T | null {
  // 1) AES fallback format (written when safeStorage was unavailable).
  if (buf.length > AES_MAGIC.length && buf.subarray(0, AES_MAGIC.length).equals(AES_MAGIC)) {
    try {
      const body = buf.subarray(AES_MAGIC.length);
      const iv = body.subarray(0, 12);
      const tag = body.subarray(12, 28);
      const ciphertext = body.subarray(28);
      // A pinned tag length refuses a truncated tag on a tampered file.
      const decipher = crypto.createDecipheriv("aes-256-gcm", fallbackKey(), iv, { authTagLength: 16 });
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
      return JSON.parse(plain) as T;
    } catch {
      return null;
    }
  }
  // 2) safeStorage-encrypted.
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return JSON.parse(safeStorage.decryptString(buf)) as T;
    } catch {
      // not safeStorage data — fall through to legacy plaintext
    }
  }
  // 3) Legacy plaintext JSON (pre-encryption files).
  try {
    return JSON.parse(buf.toString("utf-8")) as T;
  } catch {
    return null;
  }
}
