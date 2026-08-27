import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

function source(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

describe("active v2 production source boundaries", () => {
  it("keeps retired daemon, relay, tunnel, and maintainer modules unmounted", () => {
    for (const path of [
      "apps/web/src/components/BoardMaintainerDialog.tsx",
      "apps/web/src/components/RelayRuntimeProvider.tsx",
      "apps/web/src/hooks/useSessionRelay.ts",
      "apps/web/src/routes/MaintainerDetailPage.tsx",
      "apps/web/server/boardMaintainerRepo.ts",
      "apps/web/server/maintainerTriggerConcurrency.ts",
      "apps/web/server/tunnelRelay.ts",
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(false);
    }

    const app = source("apps/web/src/App.tsx");
    const worker = source("apps/web/worker/index.ts");
    expect(app).not.toMatch(/Maintainer|Relay|Daemon|Tunnel/);
    expect(worker).not.toMatch(/maintainer|relay|daemon|tunnel/i);
  });

  it("selects chat exclusively from a persisted AMA Session URI on a TaskRun", () => {
    const drawer = source("apps/web/src/components/TaskChatDrawer.tsx");
    const chat = source("apps/web/src/components/ChatPanel.tsx");

    expect(drawer).toContain("currentTask?.runs?.find");
    expect(drawer).toContain("run.amaSessionUri");
    expect(drawer).not.toMatch(/currentTask\?\.(?:session_id|sessionId)|useSessionRelay|RelayRuntimeProvider|daemon|tunnel/i);
    expect(chat).toContain("AmaSessionChat");
    expect(chat).toContain("api.sessions.sessionWs(sessionId)");
    expect(chat).not.toMatch(/useSessionRelay|RelayRuntimeProvider|daemon|tunnel/i);
  });

  it("uses public SPA Resource tokens and a Machine Application instead of retired BFF authorization", () => {
    const browserAuth = source("apps/web/src/lib/auth-client.ts");
    const browserApi = source("apps/web/src/lib/api.ts");
    const serverAma = source("apps/web/server/ama.ts");
    const routes = source("apps/web/server/routes.ts");
    const migration = source("apps/web/migrations/0001_v2.sql");

    expect(browserAuth).toContain('response_type: "code"');
    expect(browserAuth).toContain("resource: [config.ak.resource, config.ama.resource]");
    expect(browserAuth).toContain("new UserManager");
    expect(browserApi).toContain('getAuthHeaders("ama")');
    expect(serverAma).toContain('grant_type: "client_credentials"');
    expect(serverAma).toContain("AK_SERVICE_CLIENT_ID");
    for (const retired of ["/api/auth/", "/api/console/", "X-AMA-Realmroot-Authorization", "web_sessions", "ama_grants"]) {
      expect(`${routes}\n${serverAma}\n${migration}`).not.toContain(retired);
    }
  });
});
