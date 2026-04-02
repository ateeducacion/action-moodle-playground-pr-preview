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

The action finds all `installMoodlePlugin` steps whose `url` contains the current repository (`github.com/{owner}/{repo}`) and replaces them with the PR branch archive URL. This works correctly for PRs from forks too.

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

## Inputs

### `mode`

**Optional** How to publish the preview button.

- `append-to-description` (default) -- Updates the PR description with a managed block containing the preview button.
- `comment` -- Posts the preview button as a PR comment.

### `playground-host`

**Optional** Base Moodle Playground host URL.

**Default:** `https://ateeducacion.github.io/moodle-playground`

### `blueprint`

**Optional** Custom Moodle Playground Blueprint as a JSON string.

When provided, `plugin-path` is ignored. The blueprint is base64-encoded and passed via the `?blueprint=` parameter.

Learn more about Moodle Playground blueprints in the [Moodle Playground documentation](https://github.com/ateeducacion/moodle-playground/blob/main/docs/blueprint-json.md).

### `blueprint-file`

**Optional** Path to a local blueprint JSON file in the checked-out repository.

When provided, the action reads the file, finds all `installMoodlePlugin` steps whose URL matches the current repository (`github.com/{owner}/{repo}`), and replaces those URLs with the PR branch archive URL. This allows you to maintain a rich blueprint in your repo (with courses, users, additional plugins, etc.) without needing an intermediate `github-script` step.

Requires `actions/checkout` before this step. Takes priority over `plugin-path` but is overridden by `blueprint`.

### `blueprint-url`

**Optional** URL pointing to a remote blueprint JSON file.

### `plugin-path`

**Optional** Path to plugin directory inside the repository.

The action generates a GitHub archive URL for the PR branch and creates an `installMoodlePlugin` blueprint step. Plugin type and name are auto-detected from the repository name following Moodle conventions (e.g., `moodle-mod_board` -> type `mod`, name `board`).

### `moodle-version`

**Optional** Moodle version for the blueprint.

**Default:** `5.0`

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

### `comment-template`

**Optional** Custom markdown/HTML template for PR comments. Same variables available.

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

## License

This project is licensed under the GPL-2.0-or-later License - see the [LICENSE](LICENSE) file for details.
