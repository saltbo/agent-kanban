export function missingAuthSessionMessage(): string {
  return [
    "No Realmroot authority is available for AK.",
    "Humans and machines must run: ak auth login --api-url <url> --client-id <client-id>",
    "Agent runtimes must be enrolled by Realmroot and receive REALMROOT_STATE_DIR, AK_AGENT_ID, and AK_API_URL.",
  ].join("\n");
}
