export async function signTokenPayload(payload: string, encodedKey: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", signingKeyBytes(encodedKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
}

export function assertSigningKey(encodedKey: string): void {
  signingKeyBytes(encodedKey);
}

function signingKeyBytes(encodedKey: string): ArrayBuffer {
  if (typeof encodedKey !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) throw invalidSigningKey();
  let binary: string;
  try {
    binary = atob(encodedKey);
  } catch (error) {
    throw invalidSigningKey(error);
  }
  if (binary.length !== 32 || btoa(binary) !== encodedKey) throw invalidSigningKey();
  const bytes = new Uint8Array(32);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function invalidSigningKey(cause?: unknown): Error {
  return new Error("AK_SIGNING_KEY must be a canonical Base64-encoded 32-byte key", cause === undefined ? undefined : { cause });
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
