const CONTROL_PLANE_SECRET_KEYS = new Set([
  "AK_API_KEY",
  "AMA_TOKEN",
  "AMA_RUNNER_CONFIG",
  "AMA_RUNNER_CREDENTIALS",
  "AMA_OIDC_CLIENT_SECRET",
  "OIDC_CLIENT_SECRET",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_TOKEN",
  "CF_API_KEY",
]);

/** Remove machine/control-plane credentials before starting task-owned code. */
export function withoutControlPlaneSecrets(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && !CONTROL_PLANE_SECRET_KEYS.has(key)) safe[key] = value;
  }
  return safe;
}
