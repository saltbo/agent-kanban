// Ed25519 keypair generation and PGP-style delegation for Agent identity.
// Uses Web Crypto API — works in both Cloudflare Workers and Node.js.

export interface Keypair {
  publicKeyBase64: string;
  privateKeyJwk: JsonWebKey;
}

export async function generateKeypair(): Promise<Keypair> {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]);
  const pubJwk = await crypto.subtle.exportKey("jwk", publicKey);
  const privJwk = await crypto.subtle.exportKey("jwk", privateKey);
  return { publicKeyBase64: pubJwk.x!, privateKeyJwk: privJwk };
}

export async function computeFingerprint(publicKeyBase64: string): Promise<string> {
  const bytes = base64UrlToBytes(publicKeyBase64);
  const hash = await crypto.subtle.digest("SHA-256", bytes as ArrayBufferView<ArrayBuffer>);
  return bytesToHex(new Uint8Array(hash));
}

export function computeKeyId(fingerprint: string): string {
  return fingerprint.slice(-16);
}

export async function signDelegation(agentPrivateKeyJwk: JsonWebKey, sessionPublicKeyBase64: string): Promise<string> {
  const privateKey = await crypto.subtle.importKey("jwk", agentPrivateKeyJwk, { name: "Ed25519" } as any, false, ["sign"]);
  const data = new TextEncoder().encode(sessionPublicKeyBase64);
  const signature = await crypto.subtle.sign("Ed25519" as any, privateKey, data);
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyDelegation(agentPublicKeyBase64: string, sessionPublicKeyBase64: string, proof: string): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: agentPublicKeyBase64 }, { name: "Ed25519" } as any, false, [
    "verify",
  ]);
  const data = new TextEncoder().encode(sessionPublicKeyBase64);
  const signature = base64UrlToBytes(proof) as ArrayBufferView<ArrayBuffer>;
  return crypto.subtle.verify("Ed25519" as any, publicKey, signature, data);
}

function base64UrlToBytes(b64: string): Uint8Array {
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std + "=".repeat((4 - (std.length % 4)) % 4);
  const binary = atob(pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
