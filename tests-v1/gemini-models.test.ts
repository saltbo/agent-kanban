// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import * as fs from "node:fs";
import { geminiProvider } from "../packages/cli/src/providers/gemini.js";

describe("geminiProvider.listModels", () => {
  const originalGeminiApiKey = process.env.GEMINI_API_KEY;
  const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
  const originalGoogleCloudProject = process.env.GOOGLE_CLOUD_PROJECT;
  const originalGoogleCloudProjectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "gemini-key";
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;
    globalThis.fetch = vi.fn();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();

    if (originalGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiApiKey;

    if (originalGoogleApiKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalGoogleApiKey;

    if (originalGoogleCloudProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = originalGoogleCloudProject;

    if (originalGoogleCloudProjectId === undefined) delete process.env.GOOGLE_CLOUD_PROJECT_ID;
    else process.env.GOOGLE_CLOUD_PROJECT_ID = originalGoogleCloudProjectId;

    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses Gemini CLI OAuth Code Assist quota buckets when no API key is configured", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ refresh_token: "refresh-token", expiry_date: 1 }));
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "access-token" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: { id: "cloud-project" }, currentTier: { name: "Free" } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          buckets: [
            { modelId: "gemini-2.5-pro", remainingFraction: 0.75 },
            { modelId: "gemini-2.5-flash", remainingFraction: 0.25 },
            { remainingFraction: 1 },
          ],
        }),
      } as Response);

    const models = await geminiProvider.listModels?.();

    expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringMatching(/\.gemini\/oauth_creds\.json$/), "utf-8");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        method: "POST",
        body: expect.any(URLSearchParams),
      }),
    );
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toBe("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    expect(vi.mocked(fetch).mock.calls[1][1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer access-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        metadata: {
          ideType: "IDE_UNSPECIFIED",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        },
      }),
    });
    expect(String(vi.mocked(fetch).mock.calls[2][0])).toBe("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota");
    expect(vi.mocked(fetch).mock.calls[2][1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer access-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ project: "cloud-project" }),
    });
    expect(models).toEqual([
      { id: "gemini-2.5-pro", name: "gemini-2.5-pro" },
      { id: "gemini-2.5-flash", name: "gemini-2.5-flash" },
    ]);
  });

  it("uses public Gemini models API when an API key is configured", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            {
              name: "models/gemini-2.5-pro",
              displayName: "Gemini 2.5 Pro",
              description: "Reasoning model",
              inputTokenLimit: 1048576,
              outputTokenLimit: 65536,
              supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
            },
            {
              name: "models/embedding-001",
              displayName: "Embedding",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
          nextPageToken: "page-2",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            {
              name: "gemini-2.5-flash",
              displayName: "Gemini 2.5 Flash",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }),
      } as Response);

    const models = await geminiProvider.listModels?.();

    expect(fetch).toHaveBeenCalledTimes(2);
    const firstUrl = vi.mocked(fetch).mock.calls[0][0] as URL;
    const secondUrl = vi.mocked(fetch).mock.calls[1][0] as URL;
    expect(firstUrl.origin + firstUrl.pathname).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(firstUrl.searchParams.get("key")).toBe("gemini-key");
    expect(firstUrl.searchParams.get("pageSize")).toBe("1000");
    expect(firstUrl.searchParams.has("pageToken")).toBe(false);
    expect(secondUrl.searchParams.get("key")).toBe("gemini-key");
    expect(secondUrl.searchParams.get("pageSize")).toBe("1000");
    expect(secondUrl.searchParams.get("pageToken")).toBe("page-2");
    expect(fetch).toHaveBeenNthCalledWith(1, expect.any(URL), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fetch).toHaveBeenNthCalledWith(2, expect.any(URL), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(models).toEqual([
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        description: "Reasoning model",
        input_token_limit: 1048576,
        output_token_limit: 65536,
        supports: {
          generate_content: true,
          stream_generate_content: true,
        },
      },
      {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        description: undefined,
        input_token_limit: undefined,
        output_token_limit: undefined,
        supports: {
          generate_content: true,
          stream_generate_content: false,
        },
      },
    ]);
  });

  it("checkAvailability is ready from API key without reading OAuth usage", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await expect(geminiProvider.checkAvailability()).resolves.toEqual({ status: "ready" });

    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["GOOGLE_CLOUD_PROJECT", "env-cloud-project"],
    ["GOOGLE_CLOUD_PROJECT_ID", "env-cloud-project-id"],
  ])("uses %s for Code Assist load and quota project fallback", async (envName, projectId) => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    process.env[envName] = projectId;
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ access_token: "cached-token", expiry_date: Date.now() + 120_000 }));
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ currentTier: { name: "Free" } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ buckets: [{ modelId: "gemini-2.5-pro" }] }),
      } as Response);

    await expect(geminiProvider.listModels?.()).resolves.toEqual([{ id: "gemini-2.5-pro", name: "gemini-2.5-pro" }]);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      cloudaicompanionProject: projectId,
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
        duetProject: projectId,
      },
    });
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toBe("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota");
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual({ project: projectId });
  });

  it("fetchUsage reports Gemini Code Assist usage windows from OAuth quota buckets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T12:00:00.000Z"));
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ access_token: "cached-token", expiry_date: Date.now() + 120_000 }));
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: "cloud-project", paidTier: { name: "Gemini Code Assist Standard" } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          buckets: [
            { modelId: "gemini-2.5-pro", remainingFraction: 0.4, resetTime: "2026-05-05T18:00:00Z" },
            { modelId: "gemini-2.5-flash", remainingFraction: 1, resetTime: "2026-05-05T20:00:00Z" },
            { modelId: "gemini-ignored" },
          ],
        }),
      } as Response);

    const usage = await geminiProvider.fetchUsage?.();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toBe("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota");
    expect(usage).toEqual({
      updated_at: "2026-05-05T12:00:00.000Z",
      windows: [
        {
          runtime: "gemini",
          label: "gemini-2.5-pro",
          utilization: 60,
          resets_at: "2026-05-05T18:00:00Z",
        },
        {
          runtime: "gemini",
          label: "gemini-2.5-flash",
          utilization: 0,
          resets_at: "2026-05-05T20:00:00Z",
        },
      ],
    });
  });

  it("returns null usage and unauthorized availability when OAuth credentials and API keys are absent", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await expect(geminiProvider.fetchUsage?.()).resolves.toBeNull();
    await expect(geminiProvider.checkAvailability()).resolves.toEqual({
      status: "unauthorized",
      detail: "Gemini CLI is not authenticated",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
