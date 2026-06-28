import fs from "node:fs";
import * as core from "@actions/core";
import * as githubLib from "@actions/github";
import {
  assertCorePrMode,
  buildCoreOverlayBlueprint,
  buildCoreRepoPrBlueprint,
  changedFileToOverlayEntry,
  classifyCoreWarnings,
  DEFAULT_MAX_CORE_FILE_BYTES,
  DEFAULT_MAX_CORE_FILES,
  isBinaryPath,
  mapBaseRefToVersion,
  normalizeRunUpgrade,
  resolvePreviewType,
  validateCorePath,
} from "./core-overlay.js";
import {
  buildProxyBlueprintUrl,
  computeNextDescriptionBody,
  isGithubArchiveUrlForRepo,
  MAX_SAFE_PREVIEW_URL,
  mergeVariables,
  previewUrlExceedsLimit,
  removeManagedDescriptionBlockBody,
  sanitizeSlug,
  substitute,
  toBase64Url,
} from "./utils.js";

const MODE_APPEND = "append-to-description";
const MODE_COMMENT = "comment";

(async () => {
  const context = githubLib.context;
  const githubToken = core.getInput("github-token", { required: false });
  if (!githubToken) {
    throw new Error(
      "GITHUB_TOKEN (or github-token input) is required to call the GitHub API.",
    );
  }
  const github = githubLib.getOctokit(githubToken);
  const mode = (core.getInput("mode", { required: false }) || "")
    .trim()
    .toLowerCase();
  if (mode !== MODE_APPEND && mode !== MODE_COMMENT) {
    throw new Error(
      `Invalid preview mode: ${mode}. Accepted values: ${MODE_APPEND}, ${MODE_COMMENT}.`,
    );
  }

  const prNumberInput = core.getInput("pr-number", { required: false });

  let pr = context.payload.pull_request;
  let repo = context.payload.repository;

  if (prNumberInput) {
    const prNum = parseInt(prNumberInput, 10);
    core.info(`Fetching PR #${prNum} details from GitHub API...`);

    try {
      const { data: prData } = await github.rest.pulls.get({
        owner: repo
          ? repo.owner.login || repo.owner.name || repo.owner.id
          : context.repo.owner,
        repo: repo ? repo.name : context.repo.repo,
        pull_number: prNum,
      });

      pr = prData;
      if (!repo) {
        repo = prData.base.repo;
      }
      core.info(`Successfully fetched PR #${prNum}: "${prData.title}"`);
    } catch (error) {
      throw new Error(`Failed to fetch PR #${prNum}: ${error.message}`);
    }
  }

  if (!pr) {
    throw new Error(
      "This workflow must run on a pull_request event payload, or pr-number must be provided as input.",
    );
  }

  const owner = repo.owner.login || repo.owner.name || repo.owner.id;
  const repoName = repo.name;
  const repoFullName = repo.full_name;
  const prNumber = pr.number;
  const prTitle = pr.title;
  const headRef = pr.head.ref;
  const headSha = pr.head.sha;
  const baseRef = pr.base.ref;
  const headRepoFullName = pr.head.repo?.full_name || repoFullName;

  const playgroundHostRaw =
    core.getInput("playground-host", { required: false }) ||
    "https://moodle-playground.com";
  const playgroundHost = playgroundHostRaw.replace(/\/+$/, "");

  const pluginPath = (
    core.getInput("plugin-path", { required: false }) || ""
  ).trim();
  const blueprintInput = (
    core.getInput("blueprint", { required: false }) || ""
  ).trim();
  const blueprintFileInput = (
    core.getInput("blueprint-file", { required: false }) || ""
  ).trim();
  const blueprintUrlInput = (
    core.getInput("blueprint-url", { required: false }) || ""
  ).trim();
  const proxyUrlInput = (
    core.getInput("proxy-url", { required: false }) || ""
  ).trim();
  const moodleVersion = (
    core.getInput("moodle-version", { required: false }) || "5.0"
  ).trim();

  // ── Core PR overlay inputs (preview-type: auto | plugin | core) ──
  const parseIntInput = (raw, fallback) => {
    const n = parseInt(String(raw ?? "").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const previewTypeInput = (
    core.getInput("preview-type", { required: false }) || "auto"
  ).trim();
  const baseVersionInput = (
    core.getInput("base-version", { required: false }) || ""
  ).trim();
  const runUpgradeInput = (
    core.getInput("run-upgrade", { required: false }) || "auto"
  ).trim();
  const coreRootInput = (
    core.getInput("core-root", { required: false }) || "/www/moodle"
  ).trim();
  const corePrMode = (
    core.getInput("core-pr-mode", { required: false }) || "files"
  )
    .trim()
    .toLowerCase();
  const maxCoreFiles = parseIntInput(
    core.getInput("max-core-files", { required: false }),
    DEFAULT_MAX_CORE_FILES,
  );
  const maxCoreFileBytes = parseIntInput(
    core.getInput("max-core-file-bytes", { required: false }),
    DEFAULT_MAX_CORE_FILE_BYTES,
  );
  const allowCoreBinary =
    (core.getInput("allow-core-binary-files", { required: false }) || "false")
      .trim()
      .toLowerCase() === "true";

  const previewType = resolvePreviewType(previewTypeInput, repoFullName);
  core.info(`Resolved preview type: ${previewType}`);

  if (
    previewType !== "core" &&
    !pluginPath &&
    !blueprintInput &&
    !blueprintFileInput &&
    !blueprintUrlInput
  ) {
    throw new Error(
      "One of `plugin-path`, `blueprint`, `blueprint-file`, or `blueprint-url` inputs is required.",
    );
  }

  const descriptionTemplateInput = (
    core.getInput("description-template", { required: false }) || ""
  ).trim();
  const commentTemplateInput = (
    core.getInput("comment-template", { required: false }) || ""
  ).trim();
  const extraText = (
    core.getInput("extra-text", { required: false }) || ""
  ).trim();
  const descriptionMarkerStart = "<!-- moodle-playground-preview:start -->";
  const descriptionMarkerEnd = "<!-- moodle-playground-preview:end -->";
  const commentIdentifier = "<!-- moodle-playground-preview-comment -->";
  const restoreButtonIfRemoved =
    core.getInput("restore-button-if-removed", { required: false }) !== "false";

  const repoGitUrl = `https://github.com/${repoFullName}`;

  const repoSlug = sanitizeSlug(repoName, "project");
  const pluginSlug = pluginPath
    ? sanitizeSlug(
        pluginPath
          .replace(/^\.?\/?/, "")
          .split("/")
          .filter(Boolean)
          .pop(),
        repoSlug,
      )
    : "";

  const buildAutoBlueprint = () => {
    const pluginZipUrl = `${repoGitUrl}/archive/refs/heads/${headRef}.zip`;
    const steps = [
      {
        step: "installMoodle",
        options: {
          siteName: `PR #${prNumber} Preview`,
          adminUser: "admin",
          adminPass: "password",
        },
      },
      { step: "login", username: "admin" },
    ];

    if (pluginPath) {
      steps.push({ step: "installMoodlePlugin", url: pluginZipUrl });
    }

    return JSON.stringify({
      preferredVersions: { php: "8.3", moodle: moodleVersion },
      steps,
    });
  };

  const buildBlueprintFromFile = () => {
    let raw;
    try {
      raw = fs.readFileSync(blueprintFileInput, "utf8");
    } catch (err) {
      throw new Error(
        `Failed to read blueprint file "${blueprintFileInput}": ${err.message}`,
      );
    }

    let blueprint;
    try {
      blueprint = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Blueprint file "${blueprintFileInput}" is not valid JSON: ${err.message}`,
      );
    }

    const prArchiveUrl = `https://github.com/${headRepoFullName}/archive/refs/heads/${headRef}.zip`;
    const rewritableSteps = new Set(["installMoodlePlugin", "installTheme"]);
    let replacedCount = 0;

    if (Array.isArray(blueprint.steps)) {
      for (const step of blueprint.steps) {
        if (
          rewritableSteps.has(step.step) &&
          isGithubArchiveUrlForRepo(step.url, repoName)
        ) {
          core.info(
            `blueprint-file: replacing URL in ${step.step} step: ${step.url} -> ${prArchiveUrl}`,
          );
          step.url = prArchiveUrl;
          replacedCount++;
        }
      }
    }

    if (replacedCount === 0) {
      core.warning(
        `blueprint-file: no installMoodlePlugin/installTheme steps found with github.com archive URLs for repo "${repoName}". The blueprint will be used as-is.`,
      );
    } else {
      core.info(
        `blueprint-file: replaced ${replacedCount} plugin/theme URL(s) to point at PR branch.`,
      );
    }

    return JSON.stringify(blueprint);
  };

  // Resolve a Moodle core PR overlay: fetch the changed files, sanitize and
  // convert them into an applyPrOverlay manifest, and build the blueprint. The
  // action never checks out or executes PR head code; it only reads metadata.
  const resolveCorePreview = async () => {
    assertCorePrMode(corePrMode);

    const baseVersion = baseVersionInput || mapBaseRefToVersion(baseRef);
    if (!baseVersion) {
      throw new Error(
        `No Moodle Playground base mapping for target branch "${baseRef}". ` +
          "Set the `base-version` input (e.g. 5.1) to override.",
      );
    }
    const runUpgrade = normalizeRunUpgrade(runUpgradeInput);

    // Fetch all changed files, following pagination.
    const allFiles = [];
    let page = 1;
    while (true) {
      const { data: batch } = await github.rest.pulls.listFiles({
        owner,
        repo: repoName,
        pull_number: prNumber,
        per_page: 100,
        page,
      });
      allFiles.push(...batch);
      if (batch.length < 100) break;
      page++;
    }

    if (allFiles.length > maxCoreFiles) {
      throw new Error(
        `This PR changes ${allFiles.length} files, exceeding max-core-files=${maxCoreFiles}. ` +
          "Raise the limit or preview a smaller change.",
      );
    }

    const manifest = [];
    const skipped = [];
    for (const file of allFiles) {
      const reason = validateCorePath(file.filename);
      if (reason) {
        skipped.push({ path: String(file.filename), reason });
        continue;
      }
      if (!allowCoreBinary && isBinaryPath(file.filename)) {
        skipped.push({
          path: file.filename,
          reason: "binary file (not allowed)",
        });
        continue;
      }
      manifest.push(
        changedFileToOverlayEntry(file, {
          headRepoFullName,
          headSha,
        }),
      );
    }

    if (skipped.length) {
      core.warning(
        `Skipped ${skipped.length} file(s) in the core overlay preview: ` +
          skipped.map((s) => `${s.path} (${s.reason})`).join(", "),
      );
    }

    const warnings = classifyCoreWarnings(allFiles);
    for (const w of warnings) core.warning(w);

    // Pre-resolved `files` manifest (preferred: reproducible, no runtime API
    // calls). For large PRs this can overflow the `?blueprint=` URL length and
    // 414, so we also build a compact `repo`+`pr` blueprint and let the URL
    // selection below fall back to it when the inlined manifest is too long.
    const filesBlueprint = buildCoreOverlayBlueprint({
      baseVersion,
      baseRef,
      runUpgrade,
      coreRoot: coreRootInput,
      prNumber,
      files: manifest,
      maxFiles: maxCoreFiles,
      maxFileBytes: maxCoreFileBytes,
    });
    const repoPrBlueprint = buildCoreRepoPrBlueprint({
      baseVersion,
      baseRef,
      runUpgrade,
      coreRoot: coreRootInput,
      prNumber,
      repo: repoFullName,
      maxFiles: maxCoreFiles,
      maxFileBytes: maxCoreFileBytes,
    });

    return {
      filesBlueprintJson: JSON.stringify(filesBlueprint),
      repoPrBlueprintJson: JSON.stringify(repoPrBlueprint),
      baseVersion,
      runUpgrade,
      warnings,
      skipped,
      changedCount: manifest.length,
    };
  };

  let corePreview = null;
  let blueprintJson = "";
  if (previewType === "core") {
    corePreview = await resolveCorePreview();
    // Prefer the reproducible inlined `files` manifest; fall back to the compact
    // `repo`+`pr` blueprint when inlining `files` would exceed the safe URL
    // length (HTTP 414). The runtime resolves the files itself in that case.
    const filesPreviewUrl = `${playgroundHost}?blueprint=${toBase64Url(
      corePreview.filesBlueprintJson,
    )}`;
    if (previewUrlExceedsLimit(filesPreviewUrl)) {
      core.info(
        "Core overlay manifest is large; using a compact repo+pr blueprint to keep the preview URL short.",
      );
      blueprintJson = corePreview.repoPrBlueprintJson;
    } else {
      blueprintJson = corePreview.filesBlueprintJson;
    }
  } else if (blueprintInput) {
    blueprintJson = blueprintInput;
    try {
      JSON.parse(blueprintJson);
    } catch (error) {
      core.warning(blueprintJson);
      throw new Error(`Blueprint is not valid JSON. ${error.message}`);
    }
  } else if (blueprintFileInput) {
    blueprintJson = buildBlueprintFromFile();
  } else if (pluginPath) {
    blueprintJson = buildAutoBlueprint();
  }

  // URL-safe base64 (RFC 4648 §5): the standard alphabet emits `+` which
  // URLSearchParams.get() decodes as a space, corrupting the payload before
  // the playground can read it. The playground accepts both variants.
  const blueprintBase64Url = blueprintJson ? toBase64Url(blueprintJson) : "";

  // Prefer a short ?blueprint-url= link. Order:
  //   1. an explicit blueprint-url input (passed through verbatim);
  //   2. blueprint-file + proxy-url: serve that file from the PR branch through
  //      the github-proxy, so the URL stays short and the Playground derives
  //      {{REPO}}/{{REF}} from it (the blueprint should use those placeholders);
  //   3. otherwise inline the blueprint as base64 — which can overflow the URL
  //      length limit and 414 for large blueprints, so warn past a threshold.
  let previewUrl;
  if (blueprintUrlInput) {
    previewUrl = `${playgroundHost}?blueprint-url=${encodeURIComponent(
      blueprintUrlInput,
    )}`;
  } else if (blueprintFileInput && proxyUrlInput) {
    const proxied = buildProxyBlueprintUrl(
      proxyUrlInput,
      headRepoFullName,
      headRef,
      blueprintFileInput,
    );
    previewUrl = `${playgroundHost}?blueprint-url=${encodeURIComponent(proxied)}`;
    core.info(
      `Serving blueprint-file via proxy as ?blueprint-url=: ${proxied}`,
    );
  } else if (blueprintBase64Url) {
    previewUrl = `${playgroundHost}?blueprint=${blueprintBase64Url}`;
    if (previewUrlExceedsLimit(previewUrl)) {
      core.warning(
        `Preview URL is ${previewUrl.length} chars (> ${MAX_SAFE_PREVIEW_URL}); ` +
          "a web server may reject it with HTTP 414 (URI Too Long). Use the " +
          "`blueprint-url` input, or combine `blueprint-file` with `proxy-url` " +
          "to emit a short ?blueprint-url= link served through the github-proxy.",
      );
    }
  } else {
    previewUrl = playgroundHost;
  }

  const defaultButtonImageUrl =
    "https://raw.githubusercontent.com/ateeducacion/action-moodle-playground-pr-preview/refs/heads/main/assets/playground-preview-button.svg";

  const defaultButtonTemplate = [
    '<a href="{{PLAYGROUND_URL}}" target="_blank" rel="noopener noreferrer">',
    `  <img src="${defaultButtonImageUrl}" alt="Preview in Moodle Playground" width="220" height="51" />`,
    "</a>",
  ].join("\n");

  const defaultDescriptionTemplate = [
    "<hr>",
    "<h3>Moodle Playground Preview</h3>",
    "<p>The changes in this pull request can be previewed and tested using a Moodle Playground instance.</p>",
    "",
    "{{PLAYGROUND_BUTTON}}",
  ].join("\n");

  const defaultCommentTemplate = [
    "### Moodle Playground Preview",
    "",
    "The changes in this pull request can be previewed and tested using a Moodle Playground instance.",
    "",
    "{{PLAYGROUND_BUTTON}}",
  ].join("\n");

  // Core overlay caveats, rendered as plain-text bullet lists. They are exposed
  // as {{CORE_WARNINGS}} / {{CORE_SKIPPED_FILES}} so substitute() HTML-escapes
  // any PR-derived path; the surrounding Markdown structure lives in the static
  // template text below.
  const coreWarningsText = corePreview
    ? corePreview.warnings.map((w) => `- ${w}`).join("\n")
    : "";
  const coreSkippedText = corePreview
    ? corePreview.skipped.map((s) => `- ${s.path} (${s.reason})`).join("\n")
    : "";

  // Build the core caveats section only when there is something to warn about.
  const coreCaveatsLines = [];
  if (coreWarningsText) {
    coreCaveatsLines.push("", "**Preview caveats:**", "", "{{CORE_WARNINGS}}");
  }
  if (coreSkippedText) {
    coreCaveatsLines.push(
      "",
      `**Skipped files (${corePreview.skipped.length}):**`,
      "",
      "{{CORE_SKIPPED_FILES}}",
    );
  }

  const coreNote =
    "> Note: this preview applies file changes at runtime over a prebuilt base. " +
    "Changes requiring Composer, frontend builds, generated assets, database " +
    "upgrades, or a full Moodle bundle rebuild may not be fully represented.";

  const coreDefaultDescriptionTemplate = [
    "<hr>",
    "### Moodle Playground Preview",
    "",
    "This pull request can be previewed in Moodle Playground by loading the " +
      "prebuilt Moodle base for `{{CORE_BASE_REF}}` and applying the changed " +
      "files from commit `{{PR_HEAD_SHA}}`.",
    "",
    "{{PLAYGROUND_BUTTON}}",
    "",
    coreNote,
    ...coreCaveatsLines,
  ].join("\n");

  const coreDefaultCommentTemplate = [
    "### Moodle Playground Preview",
    "",
    "This pull request can be previewed in Moodle Playground by loading the " +
      "prebuilt Moodle base for `{{CORE_BASE_REF}}` and applying the changed " +
      "files from commit `{{PR_HEAD_SHA}}`.",
    "",
    "{{PLAYGROUND_BUTTON}}",
    "",
    coreNote,
    ...coreCaveatsLines,
  ].join("\n");

  const templateVariables = mergeVariables(
    {
      PR_NUMBER: String(prNumber),
      PR_TITLE: prTitle,
      PR_HEAD_REF: headRef,
      PR_HEAD_SHA: headSha,
      PR_BASE_REF: baseRef,
      REPO_OWNER: owner,
      REPO_NAME: repoName,
      REPO_FULL_NAME: repoFullName,
      REPO_SLUG: repoSlug,
      PLUGIN_PATH: pluginPath,
      PLUGIN_SLUG: pluginSlug,
      MOODLE_VERSION: moodleVersion,
      PLAYGROUND_HOST: playgroundHost,
      PREVIEW_TYPE: previewType,
    },
    {
      PLAYGROUND_URL: previewUrl,
      PLAYGROUND_BLUEPRINT_JSON: blueprintJson,
      EXTRA_TEXT: extraText,
    },
    // Core-only template variables (empty strings in plugin mode).
    corePreview
      ? {
          CORE_BASE_REF: baseRef,
          CORE_BASE_VERSION: corePreview.baseVersion,
          CORE_HEAD_SHA: headSha,
          CORE_HEAD_REPO: headRepoFullName,
          CORE_CHANGED_FILES: String(corePreview.changedCount),
          CORE_SKIPPED_FILES: coreSkippedText,
          CORE_WARNINGS: coreWarningsText,
          CORE_RUN_UPGRADE: corePreview.runUpgrade,
        }
      : {},
  );
  templateVariables.PLAYGROUND_BUTTON = substitute(
    defaultButtonTemplate,
    templateVariables,
  );

  const defaultDescription =
    previewType === "core"
      ? coreDefaultDescriptionTemplate
      : defaultDescriptionTemplate;
  const defaultComment =
    previewType === "core"
      ? coreDefaultCommentTemplate
      : defaultCommentTemplate;

  const descriptionTemplate = descriptionTemplateInput || defaultDescription;
  const commentTemplate = commentTemplateInput || defaultComment;

  let renderedDescription =
    mode === MODE_APPEND
      ? substitute(descriptionTemplate, templateVariables)
      : "";
  let renderedComment =
    mode === MODE_COMMENT ? substitute(commentTemplate, templateVariables) : "";

  // Append extra text after the rendered content if provided and not already
  // placed via {{EXTRA_TEXT}} in a custom template
  if (extraText) {
    const extraTextUsedInTemplate =
      descriptionTemplateInput?.includes("{{EXTRA_TEXT}}") ||
      commentTemplateInput?.includes("{{EXTRA_TEXT}}");
    if (!extraTextUsedInTemplate) {
      if (renderedDescription)
        renderedDescription = `${renderedDescription}\n\n${extraText}`;
      if (renderedComment)
        renderedComment = `${renderedComment}\n\n${extraText}`;
    }
  }

  const performDescriptionUpdate = async () => {
    const currentBody = pr.body || "";
    const managedBlock = `${descriptionMarkerStart}\n${renderedDescription.trim()}\n${descriptionMarkerEnd}`;
    const nextBody = computeNextDescriptionBody(
      currentBody,
      descriptionMarkerStart,
      descriptionMarkerEnd,
      managedBlock,
      { restoreIfRemoved: restoreButtonIfRemoved },
    );

    if (nextBody === null) {
      core.info(
        "Skipping description update (user placeholder detected, or markers removed with restore-button-if-removed=false).",
      );
      return;
    }

    if (nextBody === currentBody) {
      core.info("PR description already up to date. No changes applied.");
      return;
    }

    await github.rest.pulls.update({
      owner,
      repo: repoName,
      pull_number: prNumber,
      body: nextBody,
    });
    core.info("PR description updated with Moodle Playground preview button.");
  };

  const removeManagedDescriptionBlock = async () => {
    const currentBody = pr.body || "";
    const nextBody = removeManagedDescriptionBlockBody(
      currentBody,
      descriptionMarkerStart,
      descriptionMarkerEnd,
    );

    if (nextBody === currentBody) {
      return;
    }

    await github.rest.pulls.update({
      owner,
      repo: repoName,
      pull_number: prNumber,
      body: nextBody,
    });
    core.info(
      "Removed managed Playground block from PR description (comment mode active).",
    );
  };

  const findExistingComment = async () => {
    let page = 1;
    while (true) {
      const { data: batch } = await github.rest.issues.listComments({
        owner,
        repo: repoName,
        issue_number: prNumber,
        per_page: 100,
        page,
      });
      if (batch.length === 0) return null;
      const found = batch.find(
        (c) => typeof c.body === "string" && c.body.includes(commentIdentifier),
      );
      if (found) return found;
      page++;
    }
  };

  const performCommentUpdate = async () => {
    const managedBody = `${commentIdentifier}\n${renderedComment.trim()}`;
    const existing = await findExistingComment();

    if (existing) {
      if (existing.body !== managedBody) {
        await github.rest.issues.updateComment({
          owner,
          repo: repoName,
          comment_id: existing.id,
          body: managedBody,
        });
        core.info(`Updated existing preview comment (id: ${existing.id}).`);
      } else {
        core.info("Preview comment already up to date.");
      }
      return existing.id;
    }

    const created = await github.rest.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body: managedBody,
    });
    core.info(`Posted new preview comment (id: ${created.data.id}).`);
    return created.data.id;
  };

  let commentId = "";
  if (mode === MODE_APPEND) {
    await performDescriptionUpdate();
  } else {
    await removeManagedDescriptionBlock();
    commentId = String((await performCommentUpdate()) || "");
  }

  core.setOutput("mode", mode);
  core.setOutput("preview-url", previewUrl);
  core.setOutput("blueprint-json", blueprintJson);
  core.setOutput("rendered-description", renderedDescription);
  core.setOutput("rendered-comment", renderedComment);
  core.setOutput("comment-id", commentId);
})().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
