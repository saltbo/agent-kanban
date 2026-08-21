import { AgentClient } from "../client/agent.js";
import type { ApiClient } from "../client/base.js";
import { MachineClient } from "../client/machine.js";

// Agent runtimes use Realmroot Toolbox and its stable Agent identity. Ordinary
// CLI and `ak start` calls use the Native Application authority in the OS
// keychain. The former local Ed25519 leader/session identity path is gone.
export async function createClient(): Promise<ApiClient> {
  return (await AgentClient.fromEnv()) ?? new MachineClient();
}
