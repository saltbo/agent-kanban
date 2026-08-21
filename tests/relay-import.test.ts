// @vitest-environment node

import { parseRelayImport } from "@agent-kanban/shared";
import { describe, expect, it } from "vitest";

const KIMI_ENV = {
  ANTHROPIC_BASE_URL: "https://api.kimi.com/anthropic",
  ANTHROPIC_AUTH_TOKEN: "sk-kimi-token",
};

describe("parseRelayImport — named env blocks", () => {
  it("parses a single named block with the core fields", () => {
    const result = parseRelayImport(JSON.stringify({ kimi: KIMI_ENV }));

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry.error).toBeUndefined();
    expect(entry.source).toBe("Kimi"); // brand casing restored for known relays
    expect(entry.input).toEqual({
      name: "Kimi",
      kind: "auto",
      base_url: "https://api.kimi.com/anthropic",
      token: "sk-kimi-token",
      model_map: {},
      extra_env: {},
    });
  });

  it("parses several blocks in one document, preserving display names", () => {
    const result = parseRelayImport(
      JSON.stringify({
        kimi: KIMI_ENV,
        deepseek: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "sk-ds" },
        myrelay: { ANTHROPIC_BASE_URL: "https://relay.example.com", ANTHROPIC_AUTH_TOKEN: "sk-x" },
      }),
    );

    expect(result.entries.map((e) => e.source)).toEqual(["Kimi", "DeepSeek", "Myrelay"]);
    expect(result.entries.every((e) => e.input)).toBe(true);
  });

  it("maps ANTHROPIC_MODEL onto the model field", () => {
    const result = parseRelayImport(JSON.stringify({ kimi: { ...KIMI_ENV, ANTHROPIC_MODEL: "kimi-for-coding" } }));

    expect(result.entries[0].input?.model).toBe("kimi-for-coding");
  });

  it("maps tier model keys onto model_map (model and model_name independently)", () => {
    const result = parseRelayImport(
      JSON.stringify({
        kimi: {
          ...KIMI_ENV,
          ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-opus",
          ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Kimi Opus",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-sonnet",
          ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "Kimi Haiku",
        },
      }),
    );

    expect(result.entries[0].input?.model_map).toEqual({
      opus: { model: "kimi-opus", model_name: "Kimi Opus" },
      sonnet: { model: "kimi-sonnet" },
      haiku: { model_name: "Kimi Haiku" },
    });
  });

  it("collects remaining UPPER_SNAKE keys into extra_env, coercing numbers and booleans", () => {
    const result = parseRelayImport(
      JSON.stringify({
        kimi: {
          ...KIMI_ENV,
          ANTHROPIC_SMALL_FAST_MODEL: "kimi-turbo",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1,
          SOME_FLAG: true,
        },
      }),
    );

    expect(result.entries[0].input?.extra_env).toEqual({
      ANTHROPIC_SMALL_FAST_MODEL: "kimi-turbo",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      SOME_FLAG: "true",
    });
  });

  it("excludes known keys, non-UPPER_SNAKE keys, and non-scalar values from extra_env", () => {
    const result = parseRelayImport(
      JSON.stringify({
        kimi: {
          ...KIMI_ENV,
          ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-sonnet", // known key — belongs in model_map
          lowercase_key: "nope",
          mixedCase: "nope",
          NESTED_OBJECT: { a: 1 },
          AN_ARRAY: [1, 2],
          A_NULL: null,
        },
      }),
    );

    expect(result.entries[0].input?.extra_env).toEqual({});
  });
});

describe("parseRelayImport — settings.json shape", () => {
  it("names a lone env block after the detected relay", () => {
    const result = parseRelayImport(JSON.stringify({ env: KIMI_ENV }));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].source).toBe("Kimi");
    expect(result.entries[0].input?.name).toBe("Kimi");
    expect(result.entries[0].input?.base_url).toBe("https://api.kimi.com/anthropic");
  });

  it("names a lone env block after its host when the relay is unrecognized", () => {
    const result = parseRelayImport(
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://relay.internal.example.com/anthropic", ANTHROPIC_AUTH_TOKEN: "sk-x" } }),
    );

    expect(result.entries[0].source).toBe("relay.internal.example.com");
  });

  it("falls back to the name Relay when the env block has no base URL", () => {
    const result = parseRelayImport(JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-x" } }));

    expect(result.entries[0].source).toBe("Relay");
    expect(result.entries[0].error).toBe("missing ANTHROPIC_BASE_URL");
  });
});

describe("parseRelayImport — per-block validation", () => {
  it("reports a missing ANTHROPIC_BASE_URL but keeps importing sibling blocks", () => {
    const result = parseRelayImport(
      JSON.stringify({
        broken: { ANTHROPIC_AUTH_TOKEN: "sk-x" },
        kimi: KIMI_ENV,
      }),
    );

    expect(result.entries[0]).toEqual({ source: "Broken", error: "missing ANTHROPIC_BASE_URL" });
    expect(result.entries[1].input).toBeDefined();
  });

  it("reports a missing ANTHROPIC_AUTH_TOKEN", () => {
    const result = parseRelayImport(JSON.stringify({ kimi: { ANTHROPIC_BASE_URL: "https://api.kimi.com" } }));

    expect(result.entries[0]).toEqual({ source: "Kimi", error: "missing ANTHROPIC_AUTH_TOKEN" });
  });

  it("treats whitespace-only core values as missing", () => {
    const result = parseRelayImport(JSON.stringify({ kimi: { ANTHROPIC_BASE_URL: "   ", ANTHROPIC_AUTH_TOKEN: "sk-x" } }));

    expect(result.entries[0].error).toBe("missing ANTHROPIC_BASE_URL");
  });

  it("trims surrounding whitespace from core values", () => {
    const result = parseRelayImport(JSON.stringify({ kimi: { ANTHROPIC_BASE_URL: "  https://api.kimi.com  ", ANTHROPIC_AUTH_TOKEN: " sk-x " } }));

    expect(result.entries[0].input?.base_url).toBe("https://api.kimi.com");
    expect(result.entries[0].input?.token).toBe("sk-x");
  });

  it("reports a block that is not an object of env vars", () => {
    const result = parseRelayImport(JSON.stringify({ kimi: "not-an-object", also_bad: 42 }));

    expect(result.entries[0]).toEqual({ source: "kimi", error: "block must be an object of env vars" });
    expect(result.entries[1]).toEqual({ source: "also_bad", error: "block must be an object of env vars" });
  });
});

describe("parseRelayImport — document splitting and malformed input", () => {
  it("parses multiple concatenated JSON documents", () => {
    const text = `${JSON.stringify({ kimi: KIMI_ENV })}\n${JSON.stringify({
      deepseek: { ANTHROPIC_BASE_URL: "https://api.deepseek.com", ANTHROPIC_AUTH_TOKEN: "sk-ds" },
    })}`;

    const result = parseRelayImport(text);
    expect(result.entries.map((e) => e.source)).toEqual(["Kimi", "DeepSeek"]);
    expect(result.entries.every((e) => e.input)).toBe(true);
  });

  it("reports unexpected text outside a JSON document as a file-level error", () => {
    const result = parseRelayImport("hello world");

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].source).toBe("file");
    expect(result.entries[0].error).toContain("unexpected text outside a JSON document");
  });

  it("reports trailing garbage after a valid document", () => {
    const result = parseRelayImport(`${JSON.stringify({ kimi: KIMI_ENV })} trailing`);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].source).toBe("file");
    expect(result.entries[0].error).toContain("unexpected text outside a JSON document");
  });

  it("reports empty input as no JSON document found", () => {
    for (const text of ["", "   \n\t  "]) {
      const result = parseRelayImport(text);
      expect(result.entries).toEqual([{ source: "file", error: "no JSON document found" }]);
    }
  });

  it("reports an unterminated document", () => {
    const result = parseRelayImport('{"kimi": {"ANTHROPIC_BASE_URL": "https://api.kimi.com"');

    expect(result.entries).toEqual([{ source: "file", error: "unterminated JSON document — missing a closing brace" }]);
  });

  it("reports a balanced but invalid JSON document and continues with later docs", () => {
    const text = `{not json}\n${JSON.stringify({ kimi: KIMI_ENV })}`;

    const result = parseRelayImport(text);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].source).toBe("document");
    expect(result.entries[0].error).toContain("invalid JSON");
    expect(result.entries[1].input).toBeDefined();
  });

  it("reports a top-level array document", () => {
    const result = parseRelayImport(JSON.stringify([KIMI_ENV]));

    expect(result.entries).toEqual([{ source: "document", error: "expected an object of named env blocks" }]);
  });

  it("does not get confused by braces inside string values", () => {
    const result = parseRelayImport(JSON.stringify({ kimi: { ...KIMI_ENV, EXTRA_NOTE: "use {braces} here" } }));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].input?.extra_env).toEqual({ EXTRA_NOTE: "use {braces} here" });
  });
});
