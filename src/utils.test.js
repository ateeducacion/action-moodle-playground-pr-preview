import { describe, expect, it } from "vitest";
import {
  mergeVariables,
  sanitizeSlug,
  substitute,
  toBase64Url,
} from "./utils.js";

describe("toBase64Url", () => {
  it("encodes ASCII input and strips padding", () => {
    // 'sure.' encodes to 'c3VyZS4=' in standard base64; base64url drops the '='.
    expect(toBase64Url("sure.")).toBe("c3VyZS4");
  });

  it("replaces + and / with - and _ so URLSearchParams round-trips losslessly", () => {
    // The byte sequence 0xFB 0xFF emits '+' and '/' in standard base64.
    const tricky = String.fromCharCode(0xfb, 0xff, 0xfb, 0xff, 0xfb, 0xff);
    const encoded = toBase64Url(tricky);
    expect(encoded).not.toMatch(/[+/=]/u);

    const roundtrip = new URLSearchParams(`blueprint=${encoded}`).get(
      "blueprint",
    );
    expect(roundtrip).toBe(encoded);
  });

  it("preserves UTF-8 multi-byte characters", () => {
    const encoded = toBase64Url("café 🎉");
    const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
    const standard = padded.replaceAll("-", "+").replaceAll("_", "/");
    expect(Buffer.from(standard, "base64").toString("utf-8")).toBe("café 🎉");
  });

  it("produces an output decodable by the Moodle Playground parser", () => {
    // The playground's parser.js normalises base64url back to standard base64
    // and runs atob() — emulate that here to prove the round-trip works.
    const json = JSON.stringify({ steps: [{ step: "installMoodle" }] });
    const encoded = toBase64Url(json);
    const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
    const standard = padded.replaceAll("-", "+").replaceAll("_", "/");
    expect(Buffer.from(standard, "base64").toString("utf-8")).toBe(json);
  });
});

describe("sanitizeSlug", () => {
  it("lowercases and strips non-alphanumeric characters", () => {
    expect(sanitizeSlug("My Plugin", "fallback")).toBe("my-plugin");
  });

  it("returns fallback when value is empty", () => {
    expect(sanitizeSlug("", "fallback")).toBe("fallback");
    expect(sanitizeSlug(null, "fallback")).toBe("fallback");
    expect(sanitizeSlug(undefined, "fallback")).toBe("fallback");
  });

  it("returns fallback when cleaned result is empty", () => {
    expect(sanitizeSlug("!!!", "fallback")).toBe("fallback");
  });

  it("strips leading and trailing hyphens", () => {
    expect(sanitizeSlug("--hello--", "fallback")).toBe("hello");
  });

  it("handles paths and special characters", () => {
    expect(sanitizeSlug("moodle-mod_board", "fallback")).toBe(
      "moodle-mod-board",
    );
  });
});

describe("mergeVariables", () => {
  it("merges multiple maps with uppercase keys", () => {
    const result = mergeVariables({ foo: "bar" }, { baz: "qux" });
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips null and undefined values", () => {
    const result = mergeVariables({ a: "1", b: null, c: undefined });
    expect(result).toEqual({ A: "1" });
  });

  it("JSON-stringifies non-string values", () => {
    const result = mergeVariables({ count: 42, flag: true });
    expect(result).toEqual({ COUNT: "42", FLAG: "true" });
  });

  it("later maps override earlier ones", () => {
    const result = mergeVariables({ key: "first" }, { key: "second" });
    expect(result).toEqual({ KEY: "second" });
  });

  it("handles empty and null maps", () => {
    const result = mergeVariables(null, {}, { a: "1" });
    expect(result).toEqual({ A: "1" });
  });
});

describe("substitute", () => {
  it("replaces {{VARIABLE}} placeholders", () => {
    const result = substitute("Hello {{NAME}}", { NAME: "World" });
    expect(result).toBe("Hello World");
  });

  it("returns empty string for empty template", () => {
    expect(substitute("", { FOO: "bar" })).toBe("");
    expect(substitute(null, { FOO: "bar" })).toBe("");
  });

  it("replaces missing variables with empty string", () => {
    expect(substitute("{{MISSING}}", {})).toBe("");
  });

  it("HTML-escapes variable values", () => {
    const result = substitute("{{TITLE}}", {
      TITLE: '<script>alert("xss")</script>',
    });
    expect(result).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  it("does NOT HTML-escape PLAYGROUND_BUTTON", () => {
    const result = substitute("{{PLAYGROUND_BUTTON}}", {
      PLAYGROUND_BUTTON: '<a href="url">Click</a>',
    });
    expect(result).toBe('<a href="url">Click</a>');
  });

  it("handles multiple variables in one template", () => {
    const result = substitute("PR #{{PR_NUMBER}} by {{REPO_OWNER}}", {
      PR_NUMBER: "42",
      REPO_OWNER: "acme",
    });
    expect(result).toBe("PR #42 by acme");
  });

  it("is case-insensitive for variable names in template", () => {
    const result = substitute("{{name}}", { NAME: "test" });
    expect(result).toBe("test");
  });

  it("handles spaces inside braces", () => {
    const result = substitute("{{ NAME }}", { NAME: "test" });
    expect(result).toBe("test");
  });
});
