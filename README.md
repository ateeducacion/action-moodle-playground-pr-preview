# "Preview in Moodle Playground" GitHub Action

> **Attribution:** This action is derived from [WordPress/action-wp-playground-pr-preview](https://github.com/WordPress/action-wp-playground-pr-preview) by the WordPress team. We are grateful for their excellent work on the original WordPress Playground PR preview action, which served as the foundation for this Moodle adaptation. Licensed under GPL-2.0-or-later.

This GitHub Action automatically adds a "Preview in Moodle Playground" button to your pull requests, enabling easy testing of Moodle plugins directly in the browser using [Moodle Playground](https://github.com/ateeducacion/moodle-playground).

## Usage

Say you're developing a Moodle plugin called `moodle-mod_myplugin` and your source code lives in the repository root.

Create a `.github/workflows/pr-preview.yml` file in your repository:

```yaml
name: PR Preview
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]

jobs:
  preview:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Post Moodle Playground Preview Button
        uses: ateeducacion/action-moodle-playground-pr-preview@v1
        with:
          plugin-path: .
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Examples

### Plugin in repository root

See the usage example above.

### Plugin in a subdirectory

```yaml
with:
  plugin-path: plugins/mod_myplugin
```

### Post as comment instead of updating description

```yaml
with:
  plugin-path: .
  mode: comment
```

### Specify Moodle version

```yaml
with:
  plugin-path: .
  moodle-version: '4.4'
```

### Custom Blueprint

For advanced configurations, provide a custom Moodle Playground blueprint:

```yaml
with:
  blueprint: |
    {
      "preferredVersions": { "php": "8.3", "moodle": "5.0" },
      "steps": [
        { "step": "installMoodle", "options": { "siteName": "PR Test" } },
        { "step": "login", "username": "admin" },
        {
          "step": "installMoodlePlugin",
          "url": "https://github.com/owner/moodle-mod_plugin/archive/refs/heads/feature-branch.zip"
        },
        {
          "step": "createCourse",
          "fullname": "Test Course",
          "shortname": "TEST101",
          "category": "Miscellaneous"
        }
      ]
    }
  github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Blueprint from file

If your repository includes a `blueprint.json` with a rich setup (courses, users, extra plugins, etc.), the action can read it directly and automatically replace plugin URLs for the PR branch:

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      ref: ${{ github.event.pull_request.head.sha }}
  - uses: ateeducacion/action-moodle-playground-pr-preview@v1
    with:
      blueprint-file: blueprint.json
      mode: comment
      github-token: ${{ secrets.GITHUB_TOKEN }}
```

The action finds all `installMoodlePlugin` and `installTheme` steps whose `url` is a `github.com/{any-owner}/{repo}/archive/...` URL for the current repository name (the owner is ignored, so blueprints that reference an upstream URL still work when the workflow runs from a fork) and replaces them with the PR branch archive URL. This works correctly for PRs from forks too.

> **Note:** You must run `actions/checkout` before this step so the file is available.

### External Blueprint URL

```yaml
with:
  mode: append-to-description
  blueprint-url: https://example.com/path/to/blueprint.json
```

### Custom playground host

If you host your own Moodle Playground instance:

```yaml
with:
  plugin-path: .
  playground-host: https://my-org.github.io/moodle-playground
```

### Moodle core PR overlay preview

Preview a **Moodle core** pull request by booting the prebuilt Moodle base for the PR's
target branch and overlaying the PR's changed files at runtime (whole-file replacement). No
per-PR bundle is built. On `moodle/moodle`, `preview-type: auto` selects this automatically.

```yaml
with:
  preview-type: core
  run-upgrade: auto
```

The action reads the PR's changed files via the GitHub API, sanitizes their paths, and emits a
blueprint whose `applyPrOverlay` step fetches each file's final contents at the PR head commit
(`raw.githubusercontent.com`). The base Moodle version is inferred from the PR target branch (see
`base-version` to override). Changes requiring Composer, frontend builds, generated assets, or a
full database upgrade may not be fully represented; the action surfaces these as caveats.

**Fork PRs are supported.** Raw file URLs are built from the PR **head** repository (the fork) and
head SHA, so a PR opened from `someone/moodle` against `moodle/moodle` previews the fork's changes
directly. The conservative `auto` detection only treats `moodle/moodle` as core, so if you run this
action inside a fork of Moodle (the base repository is itself a fork), set `preview-type: core`
explicitly.

For a large PR, the inlined manifest is automatically replaced by a compact `repo` + `pr`
blueprint so the preview URL never hits HTTP 414; the runtime then resolves the changed files
itself.

> Security: the action only reads PR metadata and posts a link. It never checks out or executes
> PR head code. PR code runs only later, in the reviewer's browser/WASM runtime. If you trigger
> this with `pull_request_target`, do **not** add a checkout-and-run of the PR head in that
> privileged context.

## Inputs

### `mode`

**Optional** How to publish the preview button.

- `append-to-description` (default) -- Updates the PR description with a managed block containing the preview button.
- `comment` -- Posts the preview button as a PR comment.

### `playground-host`

**Optional** Base Moodle Playground host URL.

**Default:** `https://moodle-playground.com`

### `blueprint`

**Optional** Custom Moodle Playground Blueprint as a JSON string.

When provided, `plugin-path` is ignored. The blueprint is base64-encoded and passed via the `?blueprint=` parameter.

Learn more about Moodle Playground blueprints in the [Moodle Playground documentation](https://github.com/ateeducacion/moodle-playground/blob/main/docs/blueprint-json.md).

### `blueprint-file`

**Optional** Path to a local blueprint JSON file in the checked-out repository.

When provided, the action reads the file, finds all `installMoodlePlugin` and `installTheme` steps whose URL is a `github.com/{any-owner}/{repo}/archive/...` URL for the current repository name, and replaces those URLs with the PR branch archive URL. The owner segment is ignored, so a blueprint that hard-codes the canonical upstream URL still gets rewritten when the workflow runs from a fork. This allows you to maintain a rich blueprint in your repo (with courses, users, additional plugins, etc.) without needing an intermediate `github-script` step.

Requires `actions/checkout` before this step. Takes priority over `plugin-path` but is overridden by `blueprint`.

### `blueprint-url`

**Optional** URL pointing to a remote blueprint JSON file.

### `proxy-url`

**Optional** Base URL of a github-proxy able to serve a single repo file with
CORS (its `?repo=&branch=&path=` mode, e.g.
`https://github-proxy.exelearning.dev/`).

When set **together with `blueprint-file`**, the preview links to that file on
the PR branch via `?blueprint-url=` instead of inlining the blueprint as base64.
This keeps the URL short and avoids **HTTP 414 (URI Too Long)** on large
blueprints (see [Large blueprints](#large-blueprints--http-414)).

The Moodle Playground derives `{{REPO}}`/`{{REF}}` constants from the proxied
URL, so the blueprint should use those placeholders for the plugin install step
so it targets the PR branch:

```json
{
  "constants": { "REPO": "owner/moodle-mod_myplugin", "REF": "main" },
  "steps": [
    {
      "step": "installMoodlePlugin",
      "url": "https://github.com/{{REPO}}/archive/refs/heads/{{REF}}.zip"
    }
  ]
}
```

```yaml
with:
  blueprint-file: blueprint.json
  proxy-url: https://github-proxy.exelearning.dev/
  github-token: ${{ secrets.GITHUB_TOKEN }}
```

> Note: with `proxy-url` the file is served as-is (no in-place URL rewrite), so
> the PR-branch targeting comes from the `{{REPO}}`/`{{REF}}` placeholders, not
> from the `installMoodlePlugin` URL rewrite that the plain `blueprint-file` path
> performs.

### `plugin-path`

**Optional** Path to plugin directory inside the repository.

The action generates a GitHub archive URL for the PR branch and creates an `installMoodlePlugin` blueprint step. Plugin type and name are auto-detected from the repository name following Moodle conventions (e.g., `moodle-mod_board` -> type `mod`, name `board`).

### `moodle-version`

**Optional** Moodle version for the blueprint.

**Default:** `5.0`

### `preview-type`

**Optional** Which kind of preview to generate.

- `auto` (default) -- `core` when the repository is `moodle/moodle`, otherwise `plugin`.
- `plugin` -- existing plugin-preview behavior (unchanged).
- `core` -- Moodle core PR overlay preview.

### `base-version`

**Optional** Override the Moodle Playground base version for core overlay previews. When unset,
the base is inferred from the PR target branch:

| Target branch (`base.ref`) | Base version |
|----------------------------|--------------|
| `MOODLE_404_STABLE`        | 4.4 |
| `MOODLE_405_STABLE`        | 4.5 |
| `MOODLE_500_STABLE`        | 5.0 |
| `MOODLE_501_STABLE`        | 5.1 |
| `MOODLE_502_STABLE`        | 5.2 |
| `main` / `master`          | dev |

If there is no mapping and `base-version` is unset, the action fails with a helpful message.

### `run-upgrade`

**Optional** Upgrade handling for core overlay previews: `off`, `on`, or `auto`.

**Default:** `auto` (runs the upgrade only when a changed file is `version.php`,
`public/version.php`, or a `db/install.*` / `db/upgrade.php`). The runtime upgrade is a
best-effort attempt; SQLite/WASM fidelity is lower than a full Moodle Docker/Codespaces
environment.

### `core-root`

**Optional** Moodle filesystem root the overlay writes into. **Default:** `/www/moodle`. The
`public/` prefix (Moodle 5.1+) comes from the PR path and is never auto-prepended.

### `max-core-files`

**Optional** Maximum number of changed files allowed in a core overlay preview. **Default:** `80`.
The action fails if the PR changes more files than this.

### `max-core-file-bytes`

**Optional** Per-file byte cap, enforced at runtime when fetching each file. **Default:** `262144`
(256 KiB).

### `allow-core-binary-files`

**Optional** Whether to include binary files in the overlay. **Default:** `false` (binary files are
skipped and reported as caveats).

### `core-pr-mode`

**Optional** How to apply core PR changes. Only `files` (a pre-resolved manifest) is supported;
any other value fails. **Default:** `files`.

### `description-template`

**Optional** Custom markdown/HTML template for PR descriptions. Supports `{{VARIABLE_NAME}}` interpolation.

**Available variables:**
- `{{PLAYGROUND_BUTTON}}` - Rendered preview button HTML
- `{{PLAYGROUND_URL}}` - Full URL to the Playground preview
- `{{PLAYGROUND_BLUEPRINT_JSON}}` - Complete blueprint JSON string
- `{{PLAYGROUND_HOST}}` - Playground host URL
- `{{PR_NUMBER}}`, `{{PR_TITLE}}`, `{{PR_HEAD_REF}}`, `{{PR_HEAD_SHA}}`, `{{PR_BASE_REF}}`
- `{{REPO_OWNER}}`, `{{REPO_NAME}}`, `{{REPO_FULL_NAME}}`, `{{REPO_SLUG}}`
- `{{PLUGIN_PATH}}`, `{{PLUGIN_SLUG}}`
- `{{MOODLE_VERSION}}`
- `{{EXTRA_TEXT}}`
- `{{PREVIEW_TYPE}}` - `plugin` or `core`
- Core overlay only: `{{CORE_BASE_REF}}`, `{{CORE_BASE_VERSION}}`, `{{CORE_HEAD_SHA}}`,
  `{{CORE_HEAD_REPO}}`, `{{CORE_CHANGED_FILES}}`, `{{CORE_SKIPPED_FILES}}`, `{{CORE_WARNINGS}}`,
  `{{CORE_RUN_UPGRADE}}`

### `comment-template`

**Optional** Custom markdown/HTML template for PR comments. Same variables available.

### `extra-text`

**Optional** Text or HTML to display after the preview button. Useful for adding testing instructions or notes without writing a full custom template.

```yaml
with:
  plugin-path: .
  extra-text: '> **Note:** Log in with `admin` / `password` and navigate to Site Administration to test.'
```

The text is appended after the button in both `append-to-description` and `comment` modes. It is also available as `{{EXTRA_TEXT}}` for precise placement in custom templates.

### `restore-button-if-removed`

**Optional** Whether to restore the preview button if removed by PR author (only applies to `append-to-description` mode).

**Default:** `true`

### `github-token`

**Optional** GitHub token for updating PRs. Defaults to `GITHUB_TOKEN`.

Required permissions: `pull-requests: write`, `contents: read`.

### `pr-number`

**Optional** Pull request number. Defaults to `context.payload.pull_request.number`.

## Outputs

- `preview-url` - Full URL to the Moodle Playground preview.
- `blueprint-json` - Blueprint JSON string used for the preview.
- `rendered-description` - Rendered description content.
- `rendered-comment` - Rendered comment content.
- `mode` - The mode used for publishing.
- `comment-id` - ID of the created/updated comment (comment mode only).

## How it works

1. The action runs on `pull_request` events.
2. It generates a Moodle Playground blueprint that installs the plugin from the PR branch using a GitHub archive ZIP URL (`https://github.com/{owner}/{repo}/archive/refs/heads/{branch}.zip`).
3. The blueprint is base64-encoded and appended as a `?blueprint=` parameter to the Moodle Playground URL.
4. A preview button/link is added to the PR description or as a comment.
5. Reviewers click the link to instantly test the plugin in an ephemeral Moodle instance running entirely in the browser.

## Troubleshooting

### Plugin not detected correctly

Moodle Playground auto-detects plugin type and name from the repository name (e.g., `moodle-mod_myplugin`). If your repo doesn't follow this convention, use a custom blueprint with explicit `pluginType` and `pluginName` fields.

### Preview loads but plugin is missing

Ensure the PR branch is pushed to the remote. The GitHub archive URL needs the branch to exist on GitHub.

### Workflow fails with "Resource not accessible by integration"

Add the permissions block with `pull-requests: write` and `contents: read` to your workflow.

### Large blueprints / HTTP 414

By default `blueprint` / `blueprint-file` / `plugin-path` inline the whole
blueprint as base64 in `?blueprint=`. For large blueprints the resulting URL can
exceed common web-server request-line limits (nginx defaults to 8 KB), so the
preview link returns **HTTP 414 (URI Too Long)** and the Playground never loads.
The action logs a warning when it builds a `?blueprint=` link past ~8000 chars.

To keep the link short, use one of:

- **`blueprint-url`** — point at a remote blueprint JSON served with CORS
  (e.g. through a github-proxy). Passed through verbatim.
- **`blueprint-file` + [`proxy-url`](#proxy-url)** — the action references the
  file on the PR branch through the proxy (`?blueprint-url=…&path=…`), and the
  Playground resolves `{{REPO}}`/`{{REF}}` so the plugin installs from the PR
  branch. This is the recommended option for rich, committed blueprints.

## License

This project is licensed under the GPL-2.0-or-later License - see the [LICENSE](LICENSE) file for details.
