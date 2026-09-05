import { describe, expect, it } from "vitest";
import { mergePatch } from "../../../server/http/resource-server/mergePatch";

describe("JSON Merge Patch", () => {
  it.each([
    { name: "an object over an absent value", target: undefined, patch: { nested: { removed: null, added: 1 } }, expected: { nested: { added: 1 } } },
    { name: "an object over an array", target: [1, 2], patch: { added: true }, expected: { added: true } },
    { name: "an array over an object", target: { keep: 1 }, patch: [3], expected: [3] },
    { name: "a scalar over an object", target: { keep: 1 }, patch: false, expected: false },
    { name: "null over an object", target: { keep: 1 }, patch: null, expected: null },
  ])("[spec: tasks/structured-fields] replaces $name according to merge patch semantics", ({ target, patch, expected }) => {
    expect(mergePatch(target, patch)).toEqual(expected);
  });

  it("[spec: tasks/structured-fields] preserves ordinary JSON prototype keys without mutating either input", () => {
    const target = JSON.parse('{"__proto__":{"keep":true,"remove":1},"constructor":{"keep":true},"untouched":1}');
    const patch = JSON.parse('{"__proto__":{"remove":null,"added":2},"constructor":{"added":3},"toString":{"added":4}}');
    const targetBefore = JSON.stringify(target);
    const patchBefore = JSON.stringify(patch);

    const result = mergePatch(target, patch);

    expect(result).toEqual(
      JSON.parse('{"__proto__":{"keep":true,"added":2},"constructor":{"keep":true,"added":3},"untouched":1,"toString":{"added":4}}'),
    );
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(JSON.stringify(target)).toBe(targetBefore);
    expect(JSON.stringify(patch)).toBe(patchBefore);
  });
});
