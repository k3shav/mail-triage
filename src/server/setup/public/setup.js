// Mail Triage setup page. Loaded as an external script (CSP: script-src 'self').
// It shows setup status and counts only; it never requests or renders email content.
'use strict';

const state = { csrf: '', revision: 0, source: 'database' };
const $ = (id) => document.getElementById(id);

const OAUTH_ERRORS = {
  access_denied: 'Google sign-in was cancelled.',
  session_missing: 'Your session expired during sign-in. Try Connect Gmail again.',
  invalid_state: 'The sign-in link was not recognized. Try again.',
  state_used: 'That sign-in link was already used. Try again.',
  state_expired: 'The sign-in took too long. Try again.',
  session_mismatch: 'The sign-in started in a different browser session. Try again.',
  token_exchange_failed: 'Google rejected the sign-in. Check the client id, secret, and redirect URI.',
  missing_read_scope: 'Gmail read access was not granted, so nothing was connected.',
  no_refresh_token: 'Google did not return a refresh token. Remove the app from your Google account permissions and connect again.',
  different_account: 'A different Google account is already connected. Disconnect it first.',
  profile_failed: 'Could not read the Gmail profile.',
  not_configured: 'Gmail is not configured on this server.',
  oauth_error: 'Google returned an error.',
};

function show(element, visible) {
  element.hidden = !visible;
}

function notice(text, isError) {
  const box = $('notice');
  box.textContent = text;
  box.classList.toggle('error', Boolean(isError));
  show(box, Boolean(text));
}

async function api(method, path, body) {
  const headers = { accept: 'application/json' };
  if (method !== 'GET') headers['x-csrf-token'] = state.csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error((data.error && data.error.message) || `Request failed (${response.status})`);
    error.code = data.error && data.error.code;
    error.details = data.error && data.error.details;
    throw error;
  }
  return data;
}

function when(ms) {
  return ms ? new Date(ms).toLocaleString() : '—';
}

function describeCycle(cycle) {
  if (!cycle) return 'No cycle has run yet.';
  const s = cycle.summary || {};
  const parts = [`${cycle.status} (${cycle.mode}) at ${when(cycle.finishedAt || cycle.startedAt)}`];
  if (s.sync) parts.push(`${s.sync.added} new of ${s.sync.listed} listed`);
  if (s.classify) parts.push(`${s.classify.classified} classified`);
  if (s.tag) {
    const would = cycle.mode === 'dry-run' ? 'would get' : 'got';
    parts.push(`${s.tag.labeled} ${would} labels, ${s.tag.reviewOnly} ${would} Needs Review only`);
    parts.push(`${s.tag.labelsAdded} label additions${cycle.mode === 'dry-run' ? ' planned' : ''}`);
  }
  if (cycle.error) parts.push(cycle.error);
  return parts.join(' · ');
}

function renderStatus(status) {
  $('mode').textContent =
    status.mode === 'apply'
      ? 'Apply: labels are added in Gmail automatically.'
      : 'Dry run: nothing is written to Gmail. Counts show what would change. Set TAGGING_MODE=apply to add labels.';

  const gmail = status.gmail;
  const account = gmail.account;
  let gmailText;
  if (!gmail.configured) gmailText = `Not configured. ${gmail.problem}`;
  else if (!account) gmailText = 'Configured, not connected.';
  else {
    const caps = account.capabilities;
    gmailText = `Connected as ${account.email}. ${caps.canRead ? 'Read access granted.' : 'Read access unavailable; reconnect.'} ${
      caps.canApply ? 'Label writes allowed.' : caps.applyBlockedReason
    }`;
  }
  $('gmail').textContent = gmailText;

  const model = status.model;
  $('model').textContent = model.configured
    ? `${model.info.provider} / ${model.info.model}${model.info.confidenceKind === 'none' ? ' (reports no confidence)' : ''}. ${
        model.info.sendsEmailOffDevice ? `Email text is sent to ${model.info.endpointHost}.` : 'Email text stays on this network.'
      }`
    : `Not configured. ${model.reason}`;

  const pipeline = status.pipeline;
  $('pipeline').textContent = pipeline.polling
    ? `Every ${pipeline.intervalSeconds} s. ${pipeline.running ? 'Running now.' : `Next run ${when(pipeline.nextRunAt)}.`}`
    : 'Off in this server process (POLL_INTERVAL_SECONDS=0). Use the CLI.';
  $('cycle').textContent = describeCycle(pipeline.lastCycle);

  const tags = (account && account.tags) || {};
  const applied = tags.applied || 0;
  const planned = tags.planned || 0;
  $('labels').textContent = `Prefix "${status.labels.prefix}". Uncertain results get "${status.labels.review}". ${
    status.mode === 'apply' ? `${applied} messages labeled` : `${planned} messages planned`
  } for the current categories.`;

  const problems = status.ready.problems;
  const list = $('problems');
  list.replaceChildren(...problems.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
  show($('problems-box'), problems.length > 0);

  $('redirect-uri').textContent = gmail.redirectUri || 'not configured';
  $('scopes').textContent = gmail.requestedScopes.map((scope) => scope.replace('https://www.googleapis.com/auth/', '')).join(', ');
  $('connect').textContent = account ? 'Reconnect Gmail' : 'Connect Gmail';
  $('connect').disabled = !gmail.configured;
  $('run').disabled = !pipeline.polling;
  show($('disconnect'), Boolean(account));
  show($('logout'), status.auth.mode === 'password');
}

async function loadTaxonomy() {
  const current = await api('GET', '/taxonomy');
  state.revision = current.revision;
  state.source = current.source;
  const area = $('taxonomy');
  area.value = JSON.stringify(current.taxonomy, null, 2);
  area.readOnly = current.source === 'file';
  show($('save-taxonomy'), current.source !== 'file');
  $('categories-source').textContent =
    current.source === 'file'
      ? `Revision ${current.revision}, loaded from CATEGORIES_FILE. Edit that file; it is reloaded before every cycle.`
      : `Revision ${current.revision}, stored in the database. Saving a change reclassifies the messages in the sync window.`;
}

async function refresh() {
  renderStatus(await api('GET', '/status'));
}

async function startApp() {
  show($('login'), false);
  show($('app'), true);
  await Promise.all([refresh(), loadTaxonomy()]);
}

async function ensureSession() {
  const session = await api('GET', '/session');
  if (session.authenticated) {
    state.csrf = session.csrfToken;
    return true;
  }
  if (session.mode === 'local') {
    const created = await api('POST', '/session/local');
    state.csrf = created.csrfToken;
    return true;
  }
  show($('login'), true);
  return false;
}

function oauthResult() {
  const params = new URLSearchParams(window.location.search);
  const gmail = params.get('gmail');
  if (!gmail) return;
  if (gmail === 'connected') notice('Gmail connected. Tagging starts in the background; check labels in Gmail.');
  else notice(OAUTH_ERRORS[params.get('reason')] || 'Connecting Gmail failed.', true);
  window.history.replaceState(null, '', '/');
}

function guard(button, action) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

function wire() {
  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const session = await api('POST', '/session/login', { password: $('password').value });
      state.csrf = session.csrfToken;
      $('password').value = '';
      show($('login-error'), false);
      await startApp();
    } catch (error) {
      $('login-error').textContent = error.message;
      show($('login-error'), true);
    }
  });

  guard($('connect'), async () => {
    const { url } = await api('POST', '/gmail/connect');
    window.location.assign(url);
  });
  guard($('run'), async () => {
    await api('POST', '/pipeline/run');
    notice('A cycle was scheduled.');
    setTimeout(() => refresh().catch(() => {}), 1500);
  });
  guard($('refresh'), refresh);
  guard($('disconnect'), async () => {
    if (!window.confirm('Disconnect Gmail? This revokes access and deletes the local copies of your mail. Labels already in Gmail stay.')) return;
    await api('POST', '/gmail/disconnect');
    notice('Gmail disconnected.');
    await refresh();
  });
  guard($('logout'), async () => {
    await api('POST', '/session/logout');
    window.location.reload();
  });

  $('taxonomy-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = $('taxonomy-result');
    let taxonomy;
    try {
      taxonomy = JSON.parse($('taxonomy').value);
    } catch (error) {
      result.textContent = `Not valid JSON: ${error.message}`;
      result.className = 'error';
      show(result, true);
      return;
    }
    try {
      const saved = await api('PUT', '/taxonomy', { expectedRevision: state.revision, taxonomy });
      result.textContent = saved.changed ? `Saved as revision ${saved.revision}.` : 'No changes.';
      result.className = 'ok';
      await loadTaxonomy();
    } catch (error) {
      const issues = (error.details && error.details.issues) || [];
      result.textContent = [error.message, ...issues.map((issue) => `${issue.path}: ${issue.message}`)].join(' — ');
      result.className = 'error';
    }
    show(result, true);
  });
}

async function main() {
  wire();
  oauthResult();
  try {
    if (await ensureSession()) await startApp();
  } catch (error) {
    notice(error.message, true);
  }
  setInterval(() => {
    if (!$('app').hidden) refresh().catch(() => {});
  }, 15_000);
}

main();
