const core = require('@actions/core');
const githubLib = require('@actions/github');

const MODE_APPEND = 'append-to-description';
const MODE_COMMENT = 'comment';

(async () => {
  const context = githubLib.context;
  const githubToken = core.getInput('github-token', {required: false});
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN (or github-token input) is required to call the GitHub API.');
  }
  const github = githubLib.getOctokit(githubToken);
  const mode = (core.getInput('mode', {required: false}) || '').trim().toLowerCase();
  if (mode !== MODE_APPEND && mode !== MODE_COMMENT) {
    throw new Error(`Invalid preview mode: ${mode}. Accepted values: ${MODE_APPEND}, ${MODE_COMMENT}.`);
  }

  const prNumberInput = core.getInput('pr-number', {required: false});

  let pr = context.payload.pull_request;
  let repo = context.payload.repository;

  if (prNumberInput) {
    const prNum = parseInt(prNumberInput, 10);
    core.info(`Fetching PR #${prNum} details from GitHub API...`);

    try {
      const {data: prData} = await github.rest.pulls.get({
        owner: repo ? (repo.owner.login || repo.owner.name || repo.owner.id) : context.repo.owner,
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
    throw new Error('This workflow must run on a pull_request event payload, or pr-number must be provided as input.');
  }

  const owner = repo.owner.login || repo.owner.name || repo.owner.id;
  const repoName = repo.name;
  const repoFullName = repo.full_name;
  const prNumber = pr.number;
  const prTitle = pr.title;
  const headRef = pr.head.ref;
  const headSha = pr.head.sha;
  const baseRef = pr.base.ref;

  const playgroundHostRaw = core.getInput('playground-host', {required: false}) || 'https://ateeducacion.github.io/moodle-playground';
  const playgroundHost = playgroundHostRaw.replace(/\/+$/, '');

  const pluginPath = (core.getInput('plugin-path', {required: false}) || '').trim();
  const blueprintInput = (core.getInput('blueprint', {required: false}) || '').trim();
  const blueprintUrlInput = (core.getInput('blueprint-url', {required: false}) || '').trim();
  const moodleVersion = (core.getInput('moodle-version', {required: false}) || '5.0').trim();

  if (!pluginPath && !blueprintInput && !blueprintUrlInput) {
    throw new Error('One of `plugin-path`, `blueprint`, or `blueprint-url` inputs is required.');
  }

  const descriptionTemplateInput = (core.getInput('description-template', {required: false}) || '').trim();
  const commentTemplateInput = (core.getInput('comment-template', {required: false}) || '').trim();
  const descriptionMarkerStart = '<!-- moodle-playground-preview:start -->';
  const descriptionMarkerEnd = '<!-- moodle-playground-preview:end -->';
  const commentIdentifier = '<!-- moodle-playground-preview-comment -->';
  const restoreButtonIfRemoved = core.getInput('restore-button-if-removed', {required: false}) !== 'false';

  // Shared regex for the managed description block
  const markerPattern = new RegExp(
    `${descriptionMarkerStart}([\\s\\S]*?)${descriptionMarkerEnd}\\s*`,
    'm'
  );

  const repoGitUrl = `https://github.com/${repoFullName}`;

  const sanitizeSlug = (value, fallback) => {
    if (!value) return fallback;
    const cleaned = value
  	.toLowerCase()
  	.replace(/[^a-z0-9-]+/g, '-')
  	.replace(/^-+|-+$/g, '');
    return cleaned || fallback;
  };
  const repoSlug = sanitizeSlug(repoName, 'project');
  const pluginSlug = pluginPath
    ? sanitizeSlug(pluginPath.replace(/^\.?\/?/, '').split('/').filter(Boolean).pop(), repoSlug)
    : '';

  const buildAutoBlueprint = () => {
    const pluginZipUrl = `${repoGitUrl}/archive/refs/heads/${headRef}.zip`;
    const steps = [
      {
        step: 'installMoodle',
        options: {
          siteName: `PR #${prNumber} Preview`,
          adminUser: 'admin',
          adminPass: 'password',
        }
      },
      { step: 'login', username: 'admin' }
    ];

    if (pluginPath) {
      steps.push({ step: 'installMoodlePlugin', url: pluginZipUrl });
    }

    return JSON.stringify({
      preferredVersions: { php: '8.3', moodle: moodleVersion },
      steps
    });
  };

  let blueprintJson = '';
  if (blueprintInput) {
    blueprintJson = blueprintInput;
    try {
      JSON.parse(blueprintJson);
    } catch (error) {
      core.warning(blueprintJson);
      throw new Error(`Blueprint is not valid JSON. ${error.message}`);
    }
  } else if (pluginPath) {
    blueprintJson = buildAutoBlueprint();
  }

  const mergeVariables = (...maps) => maps.reduce((acc, map) => {
    Object.entries(map || {}).forEach(([key, value]) => {
  	if (value === undefined || value === null) return;
  	acc[String(key).toUpperCase()] = typeof value === 'string' ? value : JSON.stringify(value);
    });
    return acc;
  }, {});

  const substitute = (template, values) => {
    if (!template) return '';
    return template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/gi, (match, key) => {
  	const upperKey = key.toUpperCase();
  	let value = Object.prototype.hasOwnProperty.call(values, upperKey)
  	  ? values[upperKey]
  	  : '';

  	if (key !== 'PLAYGROUND_BUTTON') {
  	  value = value
  		.replace(/&/g, '&amp;')
  		.replace(/</g, '&lt;')
  		.replace(/>/g, '&gt;')
  		.replace(/"/g, '&quot;')
  		.replace(/'/g, '&#039;');
  	}
  	return value;
    });
  };

  const blueprintBase64 = blueprintJson
    ? Buffer.from(blueprintJson).toString('base64')
    : '';
  const previewUrl = blueprintUrlInput
    ? `${playgroundHost}?blueprint-url=${encodeURIComponent(blueprintUrlInput)}`
    : blueprintBase64
      ? `${playgroundHost}?blueprint=${blueprintBase64}`
      : playgroundHost;

  const defaultButtonImageUrl = 'https://raw.githubusercontent.com/ateeducacion/action-moodle-playground-pr-preview/refs/heads/main/assets/playground-preview-button.svg';

  const defaultButtonTemplate = [
    '<a href="{{PLAYGROUND_URL}}" target="_blank" rel="noopener noreferrer">',
    `  <img src="${defaultButtonImageUrl}" alt="Preview in Moodle Playground" width="220" height="51" />`,
    '</a>'
  ].join('\n');

  const defaultDescriptionTemplate = '{{PLAYGROUND_BUTTON}}';

  const defaultCommentTemplate = [
    '### Moodle Playground Preview',
    '',
    'The changes in this pull request can be previewed and tested using a Moodle Playground instance.',
    '',
    '{{PLAYGROUND_BUTTON}}',
  ].join('\n');

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
    },
    {
      PLAYGROUND_URL: previewUrl,
      PLAYGROUND_BLUEPRINT_JSON: blueprintJson,
    }
  );
  templateVariables.PLAYGROUND_BUTTON = substitute(defaultButtonTemplate, templateVariables);

  const descriptionTemplate = descriptionTemplateInput || defaultDescriptionTemplate;
  const commentTemplate = commentTemplateInput || defaultCommentTemplate;

  const renderedDescription = mode === MODE_APPEND
    ? substitute(descriptionTemplate, templateVariables) : '';
  const renderedComment = mode === MODE_COMMENT
    ? substitute(commentTemplate, templateVariables) : '';

  const performDescriptionUpdate = async () => {
    const currentBody = pr.body || '';
    const managedBlock = `${descriptionMarkerStart}\n${renderedDescription.trim()}\n${descriptionMarkerEnd}`;
    let nextBody;

    if (currentBody.includes(descriptionMarkerStart) && currentBody.includes(descriptionMarkerEnd)) {
  	const match = currentBody.match(markerPattern);
  	if (match) {
  	  const existingContent = match[1].trim();
  	  const looksLikeButton = existingContent.includes('<a ') && existingContent.includes('playground');
  	  if (existingContent && !looksLikeButton) {
  		core.info('User placeholder detected between markers. Skipping update to respect user preference.');
  		return;
  	  }
  	}
  	nextBody = currentBody.replace(markerPattern, managedBlock);
    } else {
  	if (!restoreButtonIfRemoved) {
  	  core.info('Button markers not found and restore-button-if-removed is false. Skipping to respect user removal.');
  	  return;
  	}
  	const trimmed = currentBody.trimEnd();
  	nextBody = trimmed ? `${trimmed}\n\n${managedBlock}` : managedBlock;
    }

    if (nextBody !== currentBody) {
  	await github.rest.pulls.update({
  	  owner,
  	  repo: repoName,
  	  pull_number: prNumber,
  	  body: nextBody
  	});
  	core.info('PR description updated with Moodle Playground preview button.');
    } else {
  	core.info('PR description already up to date. No changes applied.');
    }
  };

  const removeManagedDescriptionBlock = async () => {
    const currentBody = pr.body || '';
    if (!currentBody.includes(descriptionMarkerStart) || !currentBody.includes(descriptionMarkerEnd)) {
  	return;
    }

    const nextBody = currentBody.replace(markerPattern, '').trimEnd();

    if (nextBody !== currentBody) {
  	await github.rest.pulls.update({
  	  owner,
  	  repo: repoName,
  	  pull_number: prNumber,
  	  body: nextBody
  	});
  	core.info('Removed managed Playground block from PR description (comment mode active).');
    }
  };

  const findExistingComment = async () => {
    let page = 1;
    while (true) {
  	const {data: batch} = await github.rest.issues.listComments({
  	  owner, repo: repoName, issue_number: prNumber,
  	  per_page: 100, page,
  	});
  	if (batch.length === 0) return null;
  	const found = batch.find(c => typeof c.body === 'string' && c.body.includes(commentIdentifier));
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
  		body: managedBody
  	  });
  	  core.info(`Updated existing preview comment (id: ${existing.id}).`);
  	} else {
  	  core.info('Preview comment already up to date.');
  	}
  	return existing.id;
    }

    const created = await github.rest.issues.createComment({
  	owner,
  	repo: repoName,
  	issue_number: prNumber,
  	body: managedBody
    });
    core.info(`Posted new preview comment (id: ${created.data.id}).`);
    return created.data.id;
  };

  let commentId = '';
  if (mode === MODE_APPEND) {
    await performDescriptionUpdate();
  } else {
    await removeManagedDescriptionBlock();
    commentId = String(await performCommentUpdate() || '');
  }

  core.setOutput('mode', mode);
  core.setOutput('preview-url', previewUrl);
  core.setOutput('blueprint-json', blueprintJson);
  core.setOutput('rendered-description', renderedDescription);
  core.setOutput('rendered-comment', renderedComment);
  core.setOutput('comment-id', commentId);
})().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
