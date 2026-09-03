export interface AgentProfile {
  subject: string;
  name: string;
  username: string | null;
  picture: string;
  runtime: string | null;
}

interface ProtectedResourceMetadata {
  authorizationServer: string;
}

export interface AgentProfileDiscovery {
  issuer: string;
  template: string | null;
}

export async function discoverAgentProfile(signal?: AbortSignal): Promise<AgentProfileDiscovery> {
  const resourceResponse = await fetch("/.well-known/oauth-protected-resource", {
    headers: { accept: "application/json" },
    referrerPolicy: "no-referrer",
    signal: requestSignal(signal),
  });
  if (!resourceResponse.ok) throw new Error(`Protected-resource discovery failed with HTTP ${resourceResponse.status}`);
  const resource = decodeProtectedResourceMetadata(await resourceResponse.json());

  const metadataResponse = await fetch(authorizationServerMetadataUrl(resource.authorizationServer), {
    headers: { accept: "application/json" },
    referrerPolicy: "no-referrer",
    signal: requestSignal(signal),
  });
  if (!metadataResponse.ok) throw new Error(`Authorization-server discovery failed with HTTP ${metadataResponse.status}`);
  return decodeAgentProfileMetadata(await metadataResponse.json(), resource.authorizationServer);
}

export async function fetchAgentProfile(discovery: AgentProfileDiscovery, subject: string, signal?: AbortSignal): Promise<AgentProfile> {
  if (!discovery.template) throw new Error("Authorization server does not publish Agent profiles");
  const url = new URL(discovery.template.replace("{subject}", encodeURIComponent(subject)));
  url.searchParams.set("view", "summary");
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    referrerPolicy: "no-referrer",
    signal: requestSignal(signal),
  });
  if (!response.ok) throw new Error(`Agent profile request failed with HTTP ${response.status}`);
  return decodeAgentProfile(await response.json(), discovery.issuer, subject);
}

function decodeProtectedResourceMetadata(value: unknown): ProtectedResourceMetadata {
  if (!isRecord(value) || !Array.isArray(value.authorization_servers)) throw new Error("Invalid protected-resource metadata");
  const authorizationServer = value.authorization_servers[0];
  if (typeof authorizationServer !== "string") throw new Error("Protected-resource metadata has no authorization server");
  assertHttpsUrl(authorizationServer, "authorization server");
  return { authorizationServer };
}

function decodeAgentProfileMetadata(value: unknown, expectedIssuer: string): AgentProfileDiscovery {
  if (!isRecord(value) || value.issuer !== expectedIssuer) throw new Error("Invalid authorization-server metadata");
  const template = value.agent_profile_uri_template;
  if (template === undefined) return { issuer: expectedIssuer, template: null };
  if (typeof template !== "string" || template.split("{subject}").length !== 2) {
    throw new Error("Invalid Agent profile URI template");
  }
  assertHttpsUrl(template.replace("{subject}", "subject"), "Agent profile URI template");
  return { issuer: expectedIssuer, template };
}

function decodeAgentProfile(value: unknown, expectedIssuer: string, expectedSubject: string): AgentProfile {
  if (
    !isRecord(value) ||
    value.type !== "agent" ||
    value.view !== "summary" ||
    value.issuer !== expectedIssuer ||
    value.subject !== expectedSubject ||
    typeof value.name !== "string" ||
    (value.username !== null && typeof value.username !== "string") ||
    typeof value.picture !== "string" ||
    (value.runtime !== null && typeof value.runtime !== "string") ||
    !isIsoDateTime(value.createdAt) ||
    !isIsoDateTime(value.updatedAt)
  ) {
    throw new Error("Invalid Agent profile representation");
  }
  assertHttpsUrl(value.picture, "Agent profile picture");
  return {
    subject: value.subject,
    name: value.name,
    username: value.username,
    picture: value.picture,
    runtime: value.runtime,
  };
}

function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const issuerPath = url.pathname.replace(/\/$/, "");
  url.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function assertHttpsUrl(value: string, label: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
}

function requestSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(5_000);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
