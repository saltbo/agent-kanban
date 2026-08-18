// @vitest-environment node

import { describe, expect, it } from "vitest";
import { amaOidcResource, authTrustedOrigins } from "./betterAuth";
import type { Env } from "./types";

function envWithAllowedHosts(allowedHosts: string): Env {
  return { ALLOWED_HOSTS: allowedHosts } as Env;
}

describe("amaOidcResource", () => {
  it("uses AMA_ORIGIN as the OIDC resource indicator without trailing slashes", () => {
    expect(amaOidcResource({ AMA_ORIGIN: "https://ama.tftt.cc///" })).toBe("https://ama.tftt.cc");
  });

  it("omits the resource indicator when AMA_ORIGIN is not configured", () => {
    expect(amaOidcResource({ AMA_ORIGIN: "  " })).toBeNull();
    expect(amaOidcResource({})).toBeNull();
  });
});

describe("authTrustedOrigins", () => {
  it("derives both https and http trusted origins for LAN/remote allowlisted hosts", () => {
    const origins = authTrustedOrigins(envWithAllowedHosts("localhost:6265,127.0.0.1:6265,10.10.31.32:6265"));
    expect(origins).toContain("https://10.10.31.32:6265");
    expect(origins).toContain("http://10.10.31.32:6265");
  });

  it("derives both schemes for localhost and loopback hosts", () => {
    const origins = authTrustedOrigins(envWithAllowedHosts("localhost:6265,127.0.0.1:6265"));
    expect(origins).toContain("http://localhost:6265");
    expect(origins).toContain("https://localhost:6265");
    expect(origins).toContain("http://127.0.0.1:6265");
    expect(origins).toContain("https://127.0.0.1:6265");
  });

  it("dedupes origins when ALLOWED_HOSTS contains duplicate hosts", () => {
    const origins = authTrustedOrigins(envWithAllowedHosts("10.0.0.5:6265,10.0.0.5:6265"));
    expect(origins).toEqual(["https://10.0.0.5:6265", "http://10.0.0.5:6265"]);
  });

  it("stays structurally stable for empty or whitespace ALLOWED_HOSTS", () => {
    expect(authTrustedOrigins(envWithAllowedHosts(""))).toHaveLength(2);
    expect(authTrustedOrigins(envWithAllowedHosts("   "))).toHaveLength(2);
  });
});
