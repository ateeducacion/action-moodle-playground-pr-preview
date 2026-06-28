/**
 * Pure helpers for the Moodle **core** PR overlay preview mode.
 *
 * These functions are side-effect free (no octokit, no network) so they can be
 * unit tested in isolation, matching this repo's convention of testing exported
 * helpers rather than the side-effectful index.js entrypoint. index.js wires
 * the GitHub API (listing PR files) to these helpers.
 *
 * The companion runtime step `applyPrOverlay` lives in moodle-playground; this
 * module only resolves the PR's changed files into the manifest that step
 * consumes. See moodle-playground docs/decisions/0016-runtime-pr-file-overlay.md.
 */

// Default safety caps for the action; overridable via inputs.
export const DEFAULT_MAX_CORE_FILES = 80;
export const DEFAULT_MAX_CORE_FILE_BYTES = 262144; // 256 KiB

// Map a Moodle core PR target branch (base.ref) to a Moodle Playground base
// version. Kept in one place so the action and the playground agree. `master`
// is GitHub's historical default-branch alias for `main` (dev).
export const CORE_BASE_REF_TO_VERSION = {
  MOODLE_404_STABLE: "4.4",
  MOODLE_405_STABLE: "4.5",
  MOODLE_500_STABLE: "5.0",
  MOODLE_501_STABLE: "5.1",
  MOODLE_502_STABLE: "5.2",
  main: "dev",
  master: "dev",
};

// GitHub change statuses -> canonical overlay operations.
const STATUS_MAP = {
  added: "added",
  modified: "modified",
  changed: "modified",
  copied: "added",
  removed: "removed",
  renamed: "renamed",
};

// File extensions treated as binary. Such files are skipped unless
// allow-core-binary-files is true (they are fetched as bytes by the runtime).
// Note: .svg is XML text and is intentionally NOT listed.
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "ico",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "pdf",
  "zip",
  "gz",
  "tar",
  "tgz",
  "bz2",
  "7z",
  "rar",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "otf",
  "mp3",
  "mp4",
  "wav",
  "ogg",
  "oga",
  "ogv",
  "mov",
  "avi",
  "mpg",
  "mpeg",
  "webm",
  "class",
  "jar",
  "bin",
  "dat",
  "exe",
  "dll",
  "so",
  "dylib",
  "sqlite",
  "db",
]);

// Paths whose change indicates a Moodle upgrade is likely required. Identical to
// the runtime classifier (moodle-playground src/blueprint/pr-overlay.js).
const UPGRADE_TRIGGER_RE =
  /^(?:(?:public\/)?version\.php|(?:.*\/)?db\/(?:install\.xml|install\.php|upgrade\.php))$/u;

/**
 * Resolve the effective preview type from the input and the repository.
 *
 * @param {string} input "auto" | "plugin" | "core"
 * @param {string} repoFullName "owner/name"
 * @returns {"plugin"|"core"}
 */
export const resolvePreviewType = (input, repoFullName) => {
  const value = String(input || "auto").toLowerCase();
  if (value === "core" || value === "plugin") return value;
  if (value === "auto") {
    return isLikelyCoreRepo(repoFullName) ? "core" : "plugin";
  }
  throw new Error(
    `Invalid preview-type: ${input}. Accepted values: auto, plugin, core.`,
  );
};

/**
 * Conservative Moodle-core detection. Without a checkout we cannot inspect repo
 * markers, so we only treat the canonical upstream repository as core.
 *
 * @param {string} repoFullName
 * @returns {boolean}
 */
export const isLikelyCoreRepo = (repoFullName) =>
  String(repoFullName || "").toLowerCase() === "moodle/moodle";

/**
 * Map a PR base branch to a Moodle Playground base version, or null when there
 * is no known mapping (the caller should then require an explicit base-version).
 *
 * @param {string} baseRef
 * @returns {string|null}
 */
export const mapBaseRefToVersion = (baseRef) => {
  if (!baseRef) return null;
  return Object.hasOwn(CORE_BASE_REF_TO_VERSION, baseRef)
    ? CORE_BASE_REF_TO_VERSION[baseRef]
    : null;
};

/**
 * Validate a repo-relative PR file path. Returns a reason string when the path
 * is unsafe (so the caller can skip + report it), or null when it is safe.
 *
 * @param {unknown} filename
 * @returns {string|null}
 */
export const validateCorePath = (filename) => {
  if (typeof filename !== "string" || filename.trim() === "") {
    return "empty or non-string path";
  }
  if (filename.includes("\0")) return "contains a null byte";
  for (let i = 0; i < filename.length; i++) {
    if (filename.charCodeAt(i) < 0x20) return "contains control characters";
  }
  if (filename.includes("\\")) return "contains a backslash";
  if (filename.startsWith("/")) return "absolute path";
  if (filename.split("/").some((s) => s === "" || s === "." || s === "..")) {
    return "contains an unsafe path segment";
  }
  return null;
};

/**
 * Build a raw.githubusercontent.com URL for a file at a specific commit,
 * preferring the head repo + head SHA (works for fork PRs and is immutable).
 * Each path segment is URL-encoded while `/` separators are preserved.
 *
 * @param {string} headRepoFullName "owner/name" of the PR head
 * @param {string} headSha commit SHA of the PR head
 * @param {string} filename repo-relative path
 * @returns {string}
 */
export const buildRawUrl = (headRepoFullName, headSha, filename) => {
  const encodedPath = String(filename)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `https://raw.githubusercontent.com/${headRepoFullName}/${headSha}/${encodedPath}`;
};

/**
 * Normalize a GitHub change status to a canonical overlay operation. Throws on
 * an unknown status so a misleading preview is never silently produced.
 *
 * @param {unknown} status
 * @returns {"added"|"modified"|"removed"|"renamed"}
 */
export const normalizeCoreStatus = (status) => {
  const mapped = STATUS_MAP[String(status || "").toLowerCase()];
  if (!mapped) {
    throw new Error(`Unsupported PR file status: ${status}`);
  }
  return mapped;
};

/**
 * Whether a path looks like a binary file (by extension).
 *
 * @param {string} filename
 * @returns {boolean}
 */
export const isBinaryPath = (filename) => {
  const dot = String(filename).lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
};

/**
 * Convert a GitHub PR file object to an `applyPrOverlay` manifest entry.
 *
 * @param {object} file GitHub pulls.listFiles item
 * @param {{headRepoFullName: string, headSha: string}} ctx
 * @returns {{path: string, status: string, rawUrl?: string, previousPath?: string}}
 */
export const changedFileToOverlayEntry = (
  file,
  { headRepoFullName, headSha },
) => {
  const status = normalizeCoreStatus(file.status);
  const entry = { path: file.filename, status };
  if (file.previous_filename) {
    entry.previousPath = file.previous_filename;
  }
  if (status !== "removed") {
    // Prefer building from headRepoFullName + headSha rather than trusting the
    // API's raw_url (which may reference the base repo / branch name).
    entry.rawUrl = buildRawUrl(headRepoFullName, headSha, file.filename);
  }
  return entry;
};

/**
 * Whether the changed files indicate a Moodle upgrade is likely needed.
 *
 * @param {Array<{filename?: string, path?: string}|string>} files
 * @returns {boolean}
 */
export const coreNeedsUpgrade = (files) =>
  (Array.isArray(files) ? files : []).some((f) => {
    const p = typeof f === "string" ? f : (f?.filename ?? f?.path);
    return typeof p === "string" && UPGRADE_TRIGGER_RE.test(p);
  });

/**
 * Classify changed files into human-readable caveats about preview
 * completeness. Returns an array of distinct warning messages (possibly empty).
 *
 * @param {Array<{filename?: string, path?: string}|string>} files
 * @returns {string[]}
 */
export const classifyCoreWarnings = (files) => {
  const list = (Array.isArray(files) ? files : []).map((f) =>
    typeof f === "string" ? f : (f?.filename ?? f?.path ?? ""),
  );
  const warnings = [];

  const any = (re) => list.some((p) => re.test(p));

  if (any(/(^|\/)composer\.(json|lock)$/u) || any(/(^|\/)vendor\//u)) {
    warnings.push(
      "Composer dependencies changed (composer.json/lock, vendor/) and are not reinstalled in the preview.",
    );
  }
  if (
    any(/(^|\/)package\.json$/u) ||
    any(/(^|\/)(npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/u) ||
    any(/(^|\/)Gruntfile\.js$/u) ||
    any(/(^|\/)amd\/src\//u)
  ) {
    warnings.push(
      "Frontend sources changed (amd/src, Gruntfile, package.json, lockfiles); compiled assets are not rebuilt in the preview.",
    );
  }
  if (coreNeedsUpgrade(list)) {
    warnings.push(
      "Database schema or version changed (version.php, db/install.*, db/upgrade.php); run-upgrade=auto will attempt an upgrade, but SQLite/WASM fidelity is lower than a full Moodle Docker/Codespaces environment.",
    );
  }

  return warnings;
};

/**
 * Build the Moodle core overlay blueprint object.
 *
 * @param {{baseVersion: string, baseRef: string, runUpgrade: string, coreRoot: string, prNumber: number|string, files: object[], maxFiles?: number, maxFileBytes?: number}} opts
 * @returns {object}
 */
export const buildCoreOverlayBlueprint = ({
  baseVersion,
  baseRef,
  runUpgrade,
  coreRoot,
  prNumber,
  files,
  maxFiles,
  maxFileBytes,
}) => {
  const overlayStep = {
    step: "applyPrOverlay",
    baseRef,
    runUpgrade,
    root: coreRoot,
    files,
  };
  if (Number.isFinite(maxFiles)) overlayStep.maxFiles = maxFiles;
  if (Number.isFinite(maxFileBytes)) overlayStep.maxFileBytes = maxFileBytes;

  return {
    preferredVersions: { php: "8.3", moodle: baseVersion },
    landingPage: "/admin/index.php",
    steps: [
      {
        step: "installMoodle",
        options: {
          siteName: `Moodle core PR #${prNumber} Preview`,
          adminUser: "admin",
          adminPass: "password",
        },
      },
      overlayStep,
      { step: "login", username: "admin" },
    ],
  };
};

/**
 * Assert that the core-pr-mode is supported. Only "files" (a pre-resolved
 * manifest) is implemented; any other value throws a clear error.
 *
 * @param {string} mode
 * @returns {"files"}
 */
export const assertCorePrMode = (mode) => {
  const value = String(mode || "files")
    .trim()
    .toLowerCase();
  if (value !== "files") {
    throw new Error(
      `Unsupported core-pr-mode: ${mode}. Only "files" is supported.`,
    );
  }
  return value;
};

/**
 * Normalize the run-upgrade input to off | on | auto (default auto).
 *
 * @param {unknown} value
 * @returns {"off"|"on"|"auto"}
 */
export const normalizeRunUpgrade = (value) => {
  const v = String(value ?? "auto")
    .trim()
    .toLowerCase();
  if (v === "" || v === "auto") return "auto";
  if (["off", "false", "no", "0"].includes(v)) return "off";
  if (["on", "true", "yes", "1"].includes(v)) return "on";
  throw new Error(
    `Invalid run-upgrade: ${value}. Accepted values: off, on, auto.`,
  );
};
