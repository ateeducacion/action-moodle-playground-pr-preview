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
