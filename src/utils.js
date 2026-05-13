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
