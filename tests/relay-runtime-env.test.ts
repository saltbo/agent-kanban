// @vitest-environment node

import { describe, expect, it } from "vitest";
import { type RelayEndpointRow, relayRuntimeEnv } from "../apps/web/server/relayEndpointRepo.js";

const TOKEN = "sk-secret-relay-token";

function makeRow(overrides: Partial<RelayEndpointRow> = {}): RelayEndpointRow {
  return {
    id: "relay-1",
    owner_id: "owner-1",
    name: "Kimi",
    kind: "kimi",
    base_url: "https://api.kimi.com/anthropic",
    token: TOKEN,
    model: null,
    model_map: {},
    extra_env: {},
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("relayRuntimeEnv", () => {
  it("always includes ANTHROPIC_BASE_URL from the row", () => {
    expect(relayRuntimeEnv(makeRow())).toEqual({ ANTHROPIC_BASE_URL: "https://api.kimi.com/anthropic" });
  });

  it("includes ANTHROPIC_MODEL only when the row has a model", () => {
    expect(relayRuntimeEnv(makeRow({ model: "kimi-for-coding" }))).toEqual({
      ANTHROPIC_BASE_URL: "https://api.kimi.com/anthropic",
      ANTHROPIC_MODEL: "kimi-for-coding",
    });
    expect(relayRuntimeEnv(makeRow({ model: null }))).not.toHaveProperty("ANTHROPIC_MODEL");
  });

  it("maps model_map tiers onto ANTHROPIC_DEFAULT_<TIER>_MODEL(_NAME) keys", () => {
    const env = relayRuntimeEnv(
      makeRow({
        model_map: {
          opus: { model: "kimi-opus", model_name: "Kimi Opus" },
          sonnet: { model: "kimi-sonnet" },
          haiku: { model_name: "Kimi Haiku" },
          fable: { model: "kimi-fable", model_name: "Kimi Fable" },
        },
      }),
    );

    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "https://api.kimi.com/anthropic",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-opus",
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Kimi Opus",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-sonnet",
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "Kimi Haiku",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "kimi-fable",
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: "Kimi Fable",
    });
  });

  it("merges extra_env entries into the env", () => {
    const env = relayRuntimeEnv(
      makeRow({
        extra_env: {
          ANTHROPIC_SMALL_FAST_MODEL: "kimi-turbo",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      }),
    );

    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "https://api.kimi.com/anthropic",
      ANTHROPIC_SMALL_FAST_MODEL: "kimi-turbo",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  });

  it("never lets extra_env shadow reserved keys — structured fields win", () => {
    const env = relayRuntimeEnv(
      makeRow({
        model: "kimi-for-coding",
        model_map: { sonnet: { model: "kimi-sonnet", model_name: "Kimi Sonnet" } },
        extra_env: {
          ANTHROPIC_AUTH_TOKEN: "sk-injected-token",
          ANTHROPIC_BASE_URL: "https://evil.example.com",
          ANTHROPIC_MODEL: "evil-model",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "evil-opus",
          ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Evil Opus",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "evil-sonnet",
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Evil Sonnet",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "evil-haiku",
          ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "Evil Haiku",
          ANTHROPIC_DEFAULT_FABLE_MODEL: "evil-fable",
          ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: "Evil Fable",
        },
      }),
    );

    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "https://api.kimi.com/anthropic",
      ANTHROPIC_MODEL: "kimi-for-coding",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-sonnet",
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Kimi Sonnet",
    });
  });

  it("drops reserved extra_env keys even when the structured field is unset", () => {
    const env = relayRuntimeEnv(makeRow({ extra_env: { ANTHROPIC_MODEL: "sneaky-model", ANTHROPIC_DEFAULT_HAIKU_MODEL: "sneaky-haiku" } }));

    expect(env).toEqual({ ANTHROPIC_BASE_URL: "https://api.kimi.com/anthropic" });
  });

  it("never includes the token, under any key", () => {
    const env = relayRuntimeEnv(
      makeRow({
        model: "kimi-for-coding",
        model_map: { opus: { model: "kimi-opus" } },
        extra_env: { ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: TOKEN, HARMLESS: "yes" },
      }),
    );

    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(Object.values(env)).not.toContain(TOKEN);
  });
});
