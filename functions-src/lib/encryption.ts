// Workers-compatible encryption using Web Crypto API (SubtleCrypto)
// Wire format is identical to server/lib/encryption.ts:
//   iv(hex):authTag(hex):saltHex:ciphertext(hex)

const KEY_LENGTH = 32; // bytes — AES-256
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;

// ── Hex helpers ──────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Key derivation ───────────────────────────────────────────────────────────

/**
 * Derive the deterministic per-user salt the same way the Node.js
 * implementation does:  SHA-256("flux-user-${userId}-salt").slice(0, 16)
 */
async function deriveUserSalt(userId: number): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`flux-user-${userId}-salt`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer).subarray(0, SALT_LENGTH);
}

/**
 * Import the raw base key bytes and run PBKDF2 to produce the per-user AES key.
 * Mirrors: crypto.pbkdf2Sync(baseKey, userSalt, 100000, 32, 'sha256')
 */
async function deriveUserKey(
  baseKeyBytes: Uint8Array,
  userSalt: Uint8Array
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    baseKeyBytes.buffer as ArrayBuffer,
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: userSalt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: KEY_LENGTH * 8 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Import raw base key bytes directly as an AES-GCM key (no PBKDF2).
 * Used when userId is undefined.
 */
async function importBaseKey(baseKeyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    baseKeyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

// ── Resolve the AES key for a given request ──────────────────────────────────

async function resolveKey(
  encryptionKey: string,
  userId: number | undefined
): Promise<{ key: CryptoKey; userSalt: Uint8Array | null }> {
  const baseKeyBytes = hexToBytes(encryptionKey);
  if (baseKeyBytes.length !== KEY_LENGTH) {
    throw new Error("Invalid encryption configuration");
  }

  if (userId !== undefined) {
    const userSalt = await deriveUserSalt(userId);
    const key = await deriveUserKey(baseKeyBytes, userSalt);
    return { key, userSalt };
  }

  const key = await importBaseKey(baseKeyBytes);
  return { key, userSalt: null };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function encrypt(
  plaintext: string,
  userId: number | undefined,
  encryptionKey: string
): Promise<string> {
  const { key, userSalt } = await resolveKey(encryptionKey, userId);

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoder = new TextEncoder();

  // AES-GCM appends the 16-byte auth tag to the end of the ciphertext buffer
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer, tagLength: AUTH_TAG_LENGTH * 8 },
    key,
    encoder.encode(plaintext)
  );

  const encryptedBytes = new Uint8Array(encryptedBuffer);
  // SubtleCrypto appends the auth tag after the ciphertext
  const ciphertextBytes = encryptedBytes.subarray(
    0,
    encryptedBytes.length - AUTH_TAG_LENGTH
  );
  const authTagBytes = encryptedBytes.subarray(
    encryptedBytes.length - AUTH_TAG_LENGTH
  );

  const saltHex = userSalt ? bytesToHex(userSalt) : "";
  return `${bytesToHex(iv)}:${bytesToHex(authTagBytes)}:${saltHex}:${bytesToHex(ciphertextBytes)}`;
}

export async function decrypt(
  ciphertext: string,
  userId: number | undefined,
  encryptionKey: string
): Promise<string> {
  const parts = ciphertext.split(":");

  if (parts.length < 3) {
    throw new Error("Invalid encrypted data format");
  }

  const ivHex = parts[0];
  const authTagHex = parts[1];
  const saltHex = parts[2];
  // Rejoin in case the ciphertext itself contained colons (shouldn't happen
  // with hex, but mirrors the original implementation's parts.slice(3).join(":"))
  const encryptedHex = parts.slice(3).join(":");

  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Invalid encrypted data format");
  }

  const iv = hexToBytes(ivHex);
  const authTag = hexToBytes(authTagHex);

  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Invalid authentication tag length");
  }

  const { key } = await resolveKey(encryptionKey, saltHex ? userId : undefined);

  // SubtleCrypto expects ciphertext || authTag concatenated
  const ciphertextBytes = hexToBytes(encryptedHex);
  const combined = new Uint8Array(ciphertextBytes.length + AUTH_TAG_LENGTH);
  combined.set(ciphertextBytes);
  combined.set(authTag, ciphertextBytes.length);

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer, tagLength: AUTH_TAG_LENGTH * 8 },
    key,
    combined
  );

  return new TextDecoder().decode(decryptedBuffer);
}

/**
 * Generates a 64-character hex token using 32 random bytes.
 * Replaces: crypto.randomBytes(32).toString("hex")
 */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}
