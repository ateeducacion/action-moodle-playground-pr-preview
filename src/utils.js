/**
 * Encode a UTF-8 string as URL-safe base64 (RFC 4648 §5).
 *
 * Standard base64 emits `+`, `/`, and `=`, all of which break in URL query
 * strings: `+` is decoded as a space by `URLSearchParams.get()` (a legacy of
 * `application/x-www-form-urlencoded`), `/` is fine inside the value but ugly
 * to log, and `=` is reserved as the key/value separator. Emitting base64url
 * (`-`, `_`, no padding) lets the playground decode the param losslessly.
 *
 * @param {string} input UTF-8 string to encode.
 * @returns {string} URL-safe base64 representation (no padding).
 */
export const toBase64Url = (input) =>
  Buffer.from(input, "utf-8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

export const sanitizeSlug = (value, fallback) => {
  if (!value) return fallback;
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
};

export const mergeVariables = (...maps) =>
  maps.reduce((acc, map) => {
    for (const [key, value] of Object.entries(map || {})) {
      if (value === undefined || value === null) continue;
      acc[String(key).toUpperCase()] =
        typeof value === "string" ? value : JSON.stringify(value);
    }
    return acc;
  }, {});

export const substitute = (template, values) => {
  if (!template) return "";
  return template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/gi, (_match, key) => {
    const upperKey = key.toUpperCase();
    let value = Object.hasOwn(values, upperKey) ? values[upperKey] : "";

    if (key !== "PLAYGROUND_BUTTON") {
      value = value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
    return value;
  });
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Returns a RegExp that matches the managed description block (between
 * `startMarker` and `endMarker`) plus a trailing run of whitespace. The body
 * between the markers is captured in group 1.
 *
 * @param {string} startMarker
 * @param {string} endMarker
 * @returns {RegExp}
 */
export const descriptionBlockPattern = (startMarker, endMarker) =>
  new RegExp(
    `${escapeRegex(startMarker)}([\\s\\S]*?)${escapeRegex(endMarker)}\\s*`,
    "m",
  );

/**
 * Pure logic for "what should the PR body look like after this run?"
 * Returns `null` when the action should leave the body untouched: either the
 * user replaced the block content with their own placeholder text, or the
 * markers are missing and `restoreIfRemoved` is `false`.
 *
 * @param {string} currentBody
 * @param {string} startMarker
 * @param {string} endMarker
 * @param {string} block managed block to insert, including markers
 * @param {object} [options]
 * @param {boolean} [options.restoreIfRemoved=true]
 * @returns {string | null}
 */
export const computeNextDescriptionBody = (
  currentBody,
  startMarker,
  endMarker,
  block,
  options = {},
) => {
  const { restoreIfRemoved = true } = options;
  const body = currentBody || "";
  const pattern = descriptionBlockPattern(startMarker, endMarker);
  const match = body.match(pattern);

  if (match) {
    const existingContent = (match[1] || "").trim();
    const looksLikeButton =
      existingContent.includes("<a ") &&
      existingContent.toLowerCase().includes("playground");
    if (existingContent && !looksLikeButton) {
      return null;
    }
    return body.replace(pattern, block);
  }

  if (!restoreIfRemoved) {
    return null;
  }

  const trimmed = body.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}` : block;
};

/**
 * Returns the PR body with the managed description block removed, or the
 * original body when no markers are present. Used when switching from
 * `append-to-description` to `comment` mode so the preview lives in exactly
 * one place.
 *
 * @param {string} currentBody
 * @param {string} startMarker
 * @param {string} endMarker
 * @returns {string}
 */
export const removeManagedDescriptionBlockBody = (
  currentBody,
  startMarker,
  endMarker,
) => {
  const body = currentBody || "";
  const pattern = descriptionBlockPattern(startMarker, endMarker);
  if (!pattern.test(body)) {
    return body;
  }
  return body.replace(pattern, "").trimEnd();
};
