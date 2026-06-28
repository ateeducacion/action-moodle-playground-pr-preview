import { describe, expect, it } from "vitest";
import {
  assertCorePrMode,
  buildCoreOverlayBlueprint,
  buildRawUrl,
  changedFileToOverlayEntry,
  classifyCoreWarnings,
  coreNeedsUpgrade,
  isBinaryPath,
  isLikelyCoreRepo,
  mapBaseRefToVersion,
  normalizeCoreStatus,
  normalizeRunUpgrade,
  resolvePreviewType,
  validateCorePath,
} from "./core-overlay.js";

describe("resolvePreviewType", () => {
  it("returns the explicit type when given plugin or core", () => {
    expect(resolvePreviewType("plugin", "moodle/moodle")).toBe("plugin");
    expect(resolvePreviewType("core", "someone/mod_board")).toBe("core");
  });

  it("auto-detects core only for the canonical moodle/moodle repo", () => {
    expect(resolvePreviewType("auto", "moodle/moodle")).toBe("core");
    expect(resolvePreviewType("auto", "ateeducacion/moodle-mod_board")).toBe(
      "plugin",
    );
    // Default (empty) behaves like auto.
    expect(resolvePreviewType("", "moodle/moodle")).toBe("core");
  });

  it("throws on an invalid preview type", () => {
    expect(() => resolvePreviewType("nonsense", "moodle/moodle")).toThrow(
      /Invalid preview-type/,
    );
  });
});

describe("isLikelyCoreRepo", () => {
  it("matches moodle/moodle case-insensitively and nothing else", () => {
    expect(isLikelyCoreRepo("moodle/moodle")).toBe(true);
    expect(isLikelyCoreRepo("Moodle/Moodle")).toBe(true);
    expect(isLikelyCoreRepo("someone/moodle")).toBe(false);
    expect(isLikelyCoreRepo("ateeducacion/moodle-mod_board")).toBe(false);
    expect(isLikelyCoreRepo(undefined)).toBe(false);
  });
});

describe("mapBaseRefToVersion", () => {
  it("maps stable branches to playground versions", () => {
    expect(mapBaseRefToVersion("MOODLE_404_STABLE")).toBe("4.4");
    expect(mapBaseRefToVersion("MOODLE_405_STABLE")).toBe("4.5");
    expect(mapBaseRefToVersion("MOODLE_500_STABLE")).toBe("5.0");
    expect(mapBaseRefToVersion("MOODLE_501_STABLE")).toBe("5.1");
    expect(mapBaseRefToVersion("MOODLE_502_STABLE")).toBe("5.2");
  });

  it("maps main and master to dev", () => {
    expect(mapBaseRefToVersion("main")).toBe("dev");
    expect(mapBaseRefToVersion("master")).toBe("dev");
  });

  it("returns null for an unknown branch so the caller can require base-version", () => {
    expect(mapBaseRefToVersion("MOODLE_999_STABLE")).toBeNull();
    expect(mapBaseRefToVersion("")).toBeNull();
  });
});

describe("validateCorePath", () => {
  it("returns null for a safe repo-relative path", () => {
    expect(validateCorePath("lib/classes/example.php")).toBeNull();
    expect(validateCorePath("public/course/view.php")).toBeNull();
  });

  it("returns a reason for every unsafe path", () => {
    expect(validateCorePath("")).toMatch(/empty/u);
    expect(validateCorePath(123)).toMatch(/non-string/u);
    expect(validateCorePath("/etc/passwd")).toMatch(/absolute/u);
    expect(validateCorePath("../../etc/passwd")).toMatch(
      /unsafe path segment/u,
    );
    expect(validateCorePath("a\\b")).toMatch(/backslash/u);
    expect(validateCorePath("a\0b")).toMatch(/null byte/u);
    expect(validateCorePath("a\tb")).toMatch(/control/u);
    expect(validateCorePath("a/./b")).toMatch(/unsafe path segment/u);
  });
});

describe("buildRawUrl", () => {
  it("builds a head-repo + head-SHA raw URL, preserving / and encoding segments", () => {
    expect(
      buildRawUrl("user/moodle", "abc123", "lib/classes/example.php"),
    ).toBe(
      "https://raw.githubusercontent.com/user/moodle/abc123/lib/classes/example.php",
    );
    // Each segment is URL-encoded but slashes are preserved.
    expect(buildRawUrl("user/moodle", "abc123", "lang/en/a b.php")).toBe(
      "https://raw.githubusercontent.com/user/moodle/abc123/lang/en/a%20b.php",
    );
  });
});

describe("normalizeCoreStatus", () => {
  it("maps GitHub statuses to canonical operations", () => {
    expect(normalizeCoreStatus("added")).toBe("added");
    expect(normalizeCoreStatus("modified")).toBe("modified");
    expect(normalizeCoreStatus("changed")).toBe("modified");
    expect(normalizeCoreStatus("copied")).toBe("added");
    expect(normalizeCoreStatus("removed")).toBe("removed");
    expect(normalizeCoreStatus("renamed")).toBe("renamed");
  });

  it("throws on an unsupported status", () => {
    expect(() => normalizeCoreStatus("exploded")).toThrow(
      /Unsupported PR file status/,
    );
  });
});

describe("changedFileToOverlayEntry", () => {
  const ctx = { headRepoFullName: "user/moodle", headSha: "abc123" };

  it("converts an added/modified file with a raw URL", () => {
    expect(
      changedFileToOverlayEntry(
        { filename: "lib/a.php", status: "modified" },
        ctx,
      ),
    ).toEqual({
      path: "lib/a.php",
      status: "modified",
      rawUrl: "https://raw.githubusercontent.com/user/moodle/abc123/lib/a.php",
    });
  });

  it("converts a removed file without a raw URL", () => {
    expect(
      changedFileToOverlayEntry(
        { filename: "lib/old.php", status: "removed" },
        ctx,
      ),
    ).toEqual({ path: "lib/old.php", status: "removed" });
  });

  it("converts a renamed file with previousPath and a raw URL", () => {
    expect(
      changedFileToOverlayEntry(
        {
          filename: "lib/new.php",
          previous_filename: "lib/old.php",
          status: "renamed",
        },
        ctx,
      ),
    ).toEqual({
      path: "lib/new.php",
      status: "renamed",
      previousPath: "lib/old.php",
      rawUrl:
        "https://raw.githubusercontent.com/user/moodle/abc123/lib/new.php",
    });
  });
});

describe("coreNeedsUpgrade", () => {
  it("is true for version and db upgrade files", () => {
    expect(coreNeedsUpgrade([{ filename: "version.php" }])).toBe(true);
    expect(coreNeedsUpgrade([{ filename: "public/version.php" }])).toBe(true);
    expect(coreNeedsUpgrade([{ filename: "lib/db/upgrade.php" }])).toBe(true);
    expect(coreNeedsUpgrade([{ filename: "mod/quiz/db/install.xml" }])).toBe(
      true,
    );
  });

  it("is false for ordinary code changes", () => {
    expect(coreNeedsUpgrade([{ filename: "lib/classes/x.php" }])).toBe(false);
    expect(coreNeedsUpgrade([{ filename: "lib/version.php" }])).toBe(false);
    expect(coreNeedsUpgrade([])).toBe(false);
  });
});

describe("classifyCoreWarnings", () => {
  it("warns about composer, frontend, and schema changes", () => {
    const warnings = classifyCoreWarnings([
      { filename: "composer.lock" },
      { filename: "lib/amd/src/foo.js" },
      { filename: "lib/db/upgrade.php" },
    ]);
    expect(warnings.length).toBe(3);
    expect(warnings.join(" ")).toMatch(/Composer/);
    expect(warnings.join(" ")).toMatch(/Frontend/);
    expect(warnings.join(" ")).toMatch(/Database schema/);
  });

  it("returns no warnings for plain code changes", () => {
    expect(classifyCoreWarnings([{ filename: "lib/classes/x.php" }])).toEqual(
      [],
    );
  });
});

describe("isBinaryPath", () => {
  it("flags binary extensions and not text/code/svg", () => {
    expect(isBinaryPath("pix/icon.png")).toBe(true);
    expect(isBinaryPath("fonts/a.woff2")).toBe(true);
    expect(isBinaryPath("lib/classes/x.php")).toBe(false);
    expect(isBinaryPath("pix/icon.svg")).toBe(false); // SVG is text
    expect(isBinaryPath("README")).toBe(false);
  });
});

describe("buildCoreOverlayBlueprint", () => {
  it("builds installMoodle + applyPrOverlay + login with caps", () => {
    const files = [
      {
        path: "lib/a.php",
        status: "modified",
        rawUrl: "https://raw/x",
      },
    ];
    const bp = buildCoreOverlayBlueprint({
      baseVersion: "5.1",
      baseRef: "MOODLE_501_STABLE",
      runUpgrade: "auto",
      coreRoot: "/www/moodle",
      prNumber: 123,
      files,
      maxFiles: 80,
      maxFileBytes: 262144,
    });
    expect(bp.preferredVersions).toEqual({ php: "8.3", moodle: "5.1" });
    expect(bp.landingPage).toBe("/admin/index.php");
    expect(bp.steps.map((s) => s.step)).toEqual([
      "installMoodle",
      "applyPrOverlay",
      "login",
    ]);
    const overlay = bp.steps[1];
    expect(overlay).toMatchObject({
      step: "applyPrOverlay",
      baseRef: "MOODLE_501_STABLE",
      runUpgrade: "auto",
      root: "/www/moodle",
      maxFiles: 80,
      maxFileBytes: 262144,
      files,
    });
    expect(bp.steps[0].options.siteName).toBe("Moodle core PR #123 Preview");
  });
});

describe("assertCorePrMode", () => {
  it("accepts files and rejects anything else", () => {
    expect(assertCorePrMode("files")).toBe("files");
    expect(assertCorePrMode("FILES")).toBe("files");
    expect(() => assertCorePrMode("diff")).toThrow(/Unsupported core-pr-mode/);
    expect(() => assertCorePrMode("patch")).toThrow(
      /Only "files" is supported/,
    );
  });
});

describe("normalizeRunUpgrade", () => {
  it("defaults to auto and accepts off/on/auto plus aliases", () => {
    expect(normalizeRunUpgrade(undefined)).toBe("auto");
    expect(normalizeRunUpgrade("")).toBe("auto");
    expect(normalizeRunUpgrade("auto")).toBe("auto");
    expect(normalizeRunUpgrade("off")).toBe("off");
    expect(normalizeRunUpgrade("false")).toBe("off");
    expect(normalizeRunUpgrade("on")).toBe("on");
    expect(normalizeRunUpgrade("true")).toBe("on");
  });

  it("throws on an invalid value", () => {
    expect(() => normalizeRunUpgrade("maybe")).toThrow(/Invalid run-upgrade/);
  });
});
