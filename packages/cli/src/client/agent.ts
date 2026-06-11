import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { ApiClient } from "./base.js";

export class AgentClient extends ApiClient {
  private agentId: string;
  private sessionId: string;
  private privateKey: CryptoKey;

  constructor(baseUrl: string, agentId: string, sessionId: string, privateKey: CryptoKey) {
    super(baseUrl);
    this.agentId = agentId;
    this.sessionId = sessionId;
    this.privateKey = privateKey;
  }

  static async fromEnv(): Promise<AgentClient | null> {
    const agentId = process.env.AK_AGENT_ID;
    const sessionId = process.env.AK_SESSION_ID;
    const keyJson = process.env.AK_AGENT_KEY;
    const apiUrl = process.env.AK_API_URL;
    if (!agentId || !sessionId || !keyJson || !apiUrl) return null;

    const privateKey = await crypto.subtle.importKey("jwk", JSON.parse(keyJson), { name: "Ed25519" } as any, false, ["sign"]);
    return new AgentClient(apiUrl, agentId, sessionId, privateKey);
  }

  protected async authorize(): Promise<string> {
    // Backdate iat by 30s: the server verifies with zero clock tolerance, so a
    // client clock even one second ahead of the server rejects every request
    // with invalid_jwt. exp is still resolved from the current time, so the
    // token's validity window is unchanged.
    const jwt = await new SignJWT({ sub: this.sessionId, aid: this.agentId, jti: randomUUID(), aud: this.baseUrl })
      .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 30)
      .setExpirationTime("60s")
      .sign(this.privateKey);
    return `Bearer ${jwt}`;
  }

  getAgentId(): string {
    return this.agentId;
  }
  getSessionId(): string {
    return this.sessionId;
  }
}
