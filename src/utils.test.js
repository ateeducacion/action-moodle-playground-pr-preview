import { describe, expect, it } from "vitest";
import {
  computeNextDescriptionBody,
  descriptionBlockPattern,
  mergeVariables,
  removeManagedDescriptionBlockBody,
  sanitizeSlug,
  substitute,
  toBase64Url,
} from "./utils.js";

const START = "<!-- moodle-playground-preview:start -->";
const END = "<!-- moodle-playground-preview:end -->";
const BUTTON_BLOCK = `${START}\n<a href="https://moodle-playground.com/?blueprint=ABC">Preview in Moodle Playground</a>\n${END}`;
const NEW_BUTTON_BLOCK = `${START}\n<a href="https://moodle-playground.com/?blueprint=NEW">Preview in Moodle Playground</a>\n${END}`;

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

describe("descriptionBlockPattern", () => {
  it("matches a managed block and captures the inner content in group 1", () => {
    const pattern = descriptionBlockPattern(START, END);
    const match = `Hello\n\n${BUTTON_BLOCK}\n\nGoodbye`.match(pattern);
    expect(match).not.toBeNull();
    expect(match[1].trim().startsWith("<a")).toBe(true);
  });

  it("returns no match when only one of the markers is present", () => {
    const pattern = descriptionBlockPattern(START, END);
    expect(`Hello ${START} only the start marker`.match(pattern)).toBeNull();
  });

  it("escapes regex metacharacters inside the markers", () => {
    // Build markers with a regex-sensitive character to make sure
    // descriptionBlockPattern doesn't blow up or over-match.
    const start = "<!-- foo.bar:start -->";
    const end = "<!-- foo.bar:end -->";
    const pattern = descriptionBlockPattern(start, end);
    const body = `pre\n${start}\ninner\n${end}\npost`;
    const match = body.match(pattern);
    expect(match).not.toBeNull();
    // A naive regex would happily treat `.` as "any char" and match a
    // marker like `<!-- fooXbar:start -->`. The escaping must prevent that.
    const adversarial = `pre\n<!-- fooXbar:start -->\ninner\n<!-- fooXbar:end -->\npost`;
    expect(adversarial.match(pattern)).toBeNull();
  });
});

describe("computeNextDescriptionBody", () => {
  it("appends the block when markers are missing and restore is enabled", () => {
    const result = computeNextDescriptionBody(
      "PR body here.",
      START,
      END,
      BUTTON_BLOCK,
    );
    expect(result.startsWith("PR body here.")).toBe(true);
    expect(result.endsWith(END)).toBe(true);
  });

  it("returns the block itself when the current body is empty", () => {
    expect(computeNextDescriptionBody("", START, END, BUTTON_BLOCK)).toBe(
      BUTTON_BLOCK,
    );
  });

  it("replaces an existing managed block with the new one", () => {
    const next = computeNextDescriptionBody(
      `Top\n\n${BUTTON_BLOCK}\n\nBottom`,
      START,
      END,
      NEW_BUTTON_BLOCK,
    );
    expect(next.includes("blueprint=NEW")).toBe(true);
    expect(next.includes("blueprint=ABC")).toBe(false);
    expect(next.startsWith("Top")).toBe(true);
    expect(next.endsWith("Bottom")).toBe(true);
  });

  it("returns null when the user replaced the block with placeholder text", () => {
    const userBody = `${START}\nI removed the button on purpose.\n${END}`;
    expect(
      computeNextDescriptionBody(userBody, START, END, NEW_BUTTON_BLOCK),
    ).toBeNull();
  });

  it("returns null when markers are missing and restoreIfRemoved is false", () => {
    expect(
      computeNextDescriptionBody("Plain body", START, END, BUTTON_BLOCK, {
        restoreIfRemoved: false,
      }),
    ).toBeNull();
  });

  it("treats an empty managed block as a button (no placeholder)", () => {
    // Edge case: the markers exist but the user (or a previous run) left
    // them with no content in between. We should replace, not bail out.
    const empty = `Top\n\n${START}\n\n${END}\n\nBottom`;
    const next = computeNextDescriptionBody(empty, START, END, BUTTON_BLOCK);
    expect(next).not.toBeNull();
    expect(next.includes(BUTTON_BLOCK)).toBe(true);
  });
});

describe("removeManagedDescriptionBlockBody", () => {
  it("strips the managed block but preserves the rest of the body", () => {
    const body = `Intro\n\n${BUTTON_BLOCK}\n\nOutro`;
    const stripped = removeManagedDescriptionBlockBody(body, START, END);
    expect(stripped.includes(START)).toBe(false);
    expect(stripped.includes(END)).toBe(false);
    expect(stripped.includes("Intro")).toBe(true);
    expect(stripped.includes("Outro")).toBe(true);
  });

  it("returns the body unchanged when markers are absent", () => {
    expect(removeManagedDescriptionBlockBody("Just text", START, END)).toBe(
      "Just text",
    );
  });

  it("trims trailing whitespace after removal", () => {
    const body = `Top\n\n${BUTTON_BLOCK}`;
    expect(removeManagedDescriptionBlockBody(body, START, END)).toBe("Top");
  });
});
