import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { readWorkerAuthSession } from "../auth/session.js";
import { ApiClient } from "./base.js";

export class AgentClient extends ApiClient {
  constructor(
    baseUrl: string,
    private readonly agentId: string,
    private readonly sessionId: string,
    private readonly privateKey: CryptoKey,
  ) {
    super(baseUrl);
  }

  static async fromEnv(): Promise<AgentClient | null> {
    const apiUrl = process.env.AK_API_URL;
    const agentId = process.env.AK_AGENT_ID;
    const sessionId = process.env.AK_SESSION_ID;
    const keyJson = process.env.AK_AGENT_KEY;
    if (!apiUrl || !agentId || !sessionId || !keyJson) {
      if (process.env.AK_WORKER !== "1") return null;
      const cached = readWorkerAuthSession();
      if (!cached) return null;
      return new AgentClient(cached.apiUrl, cached.agentId, cached.sessionId, await importPrivateKey(cached.privateKeyJwk));
    }
    return new AgentClient(apiUrl, agentId, sessionId, await importPrivateKey(JSON.parse(keyJson)));
  }

  protected async authorizationHeaders(_method: string, _url: string): Promise<Record<string, string>> {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ sub: this.sessionId, aid: this.agentId, jti: randomUUID() })
      .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
      .setAudience(this.baseUrl)
      .setIssuedAt(now - 5)
      .setExpirationTime(now + 60)
      .sign(this.privateKey);
    return { authorization: `Bearer ${jwt}` };
  }

  getAgentId(): string {
    return this.agentId;
  }

  getSessionId(): string {
    return this.sessionId;
  }
}

function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" } as AlgorithmIdentifier, false, ["sign"]);
}
