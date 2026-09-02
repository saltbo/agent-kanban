interface OidcMetadata {
  issuer?: unknown;
  token_endpoint?: unknown;
}

export class RealmrootClientCredentialsFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RealmrootClientCredentialsFailure";
  }
}

export async function realmrootClientCredentialsToken(input: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  resource: string;
  scope: string;
}): Promise<string> {
  try {
    const tokenEndpoint = await discoverTokenEndpoint(input.issuer);
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${input.clientId}:${input.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", resource: input.resource, scope: input.scope }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new RealmrootClientCredentialsFailure(`Realmroot token request failed with HTTP ${response.status}`);
    const payload = (await response.json()) as { access_token?: unknown };
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new RealmrootClientCredentialsFailure("Realmroot token response did not contain an access token");
    }
    return payload.access_token;
  } catch (error) {
    if (error instanceof RealmrootClientCredentialsFailure) throw error;
    throw new RealmrootClientCredentialsFailure("Realmroot client credentials request failed", { cause: error });
  }
}

async function discoverTokenEndpoint(issuer: string): Promise<string> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new RealmrootClientCredentialsFailure(`Realmroot discovery failed with HTTP ${response.status}`);
  const metadata = (await response.json()) as OidcMetadata;
  if (metadata.issuer !== issuer || typeof metadata.token_endpoint !== "string") {
    throw new RealmrootClientCredentialsFailure("Realmroot discovery returned invalid metadata");
  }
  const endpoint = new URL(metadata.token_endpoint);
  if (endpoint.protocol !== "https:" || endpoint.origin !== new URL(issuer).origin) {
    throw new RealmrootClientCredentialsFailure("Realmroot discovery returned an untrusted token endpoint");
  }
  return endpoint.href;
}
