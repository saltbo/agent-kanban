import { getCredentials } from "../config.js";
import { realmrootRequestHeaders } from "../nativeAuth.js";
import { ApiClient } from "./base.js";

export class MachineClient extends ApiClient {
  private machineId: string | null = null;

  constructor() {
    const { apiUrl } = getCredentials();
    super(apiUrl);
  }

  protected async authorizationHeaders(method: string, url: string): Promise<Record<string, string>> {
    const headers = await realmrootRequestHeaders(method, url);
    if (this.machineId) headers["x-ak-machine-id"] = this.machineId;
    return headers;
  }

  bindMachine(machineId: string): void {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(machineId)) throw new Error("AK machine ID is invalid");
    this.machineId = machineId;
  }
}
