const form = document.querySelector('#chat-form');
const field = document.querySelector('#message');
const conversation = document.querySelector('#conversation');
const events = document.querySelector('#events');
const provider = document.querySelector('#provider');
const build = document.querySelector('#build');
const cancel = document.querySelector('#cancel');
const newProject = document.querySelector('#new-project');
const artifact = document.querySelector('#artifact');
const exportButton = document.querySelector('#export');
const exportPath = document.querySelector('#export-path');
const publishStatus = document.querySelector('#publish-status');
const connectionButton = document.querySelector('#connections');
const connectionStatus = document.querySelector('#connection-status');
const usageStatus = document.querySelector('#usage-status');
const usageAgents = document.querySelector('#usage-agents');
const usageCalls = document.querySelector('#usage-calls');
const usagePricing = document.querySelector('#usage-pricing');
const publishActions = document.querySelector('#publish-actions');
const githubPublishForm = document.querySelector('#github-publish-form');
const vercelPublishForm = document.querySelector('#vercel-publish-form');
const previewStatusButton = document.querySelector('#preview-status');
const firstRun = document.querySelector('#first-run');
const officeForm = document.querySelector('#office-form');
const requestState = document.querySelector('#request-state');
let project = null;
let busy = false;
let lastEventCount = 0;
let pendingMessage = null;
let pendingBuildId = null;
let simulated = false;
let conversationEpoch = 0;
let usageSignature = '';
let usageSequence = 0;
let usageRetryTimer = null;
let usagePendingSince = 0;
let usagePendingProject = null;
const cost = value => Number(value) > 0 && Number(value) < 1000 ? '<$0.000001' : `$${(Number(value) / 1_000_000_000).toFixed(6)}`;
function usageText(label, value) {
  return `${label}: ${value.calls} calls; ${value.inputTokens} input and ${value.outputTokens} output tokens; ${cost(value.estimatedCostNanoUsd)} estimated API cost` +
    (value.unpricedCalls ? `; ${value.unpricedCalls} unpriced` : '') +
    (value.pendingCalls || value.unreportedCalls ? `; ${value.pendingCalls} pending, ${value.unreportedCalls} unreported` : '');
}
async function loadUsage(id = null) {
  if (!usageStatus) return;
  if (usageRetryTimer) { clearTimeout(usageRetryTimer); usageRetryTimer = null; }
  if (usagePendingProject !== id) { usagePendingProject = id; usagePendingSince = 0; }
  const sequence = ++usageSequence;
  const epoch = conversationEpoch;
  try {
    const value = await api(`/api/usage${id ? `?projectId=${encodeURIComponent(id)}` : ''}`);
    if (sequence !== usageSequence || epoch !== conversationEpoch || (id && project?.id !== id)) return;
    usageStatus.textContent = `${usageText('This project', value.project.total)}. ${usageText(`${value.month} across local projects`, value.monthly.total)}.`;
    usageAgents.replaceChildren(...Object.entries(value.project.agents).map(([agent, totals]) => {
      const item = document.createElement('li'); item.textContent = usageText(agent, totals); return item;
    }));
    usageCalls.replaceChildren(...value.calls.map(call => {
      const item = document.createElement('li');
      item.textContent = `${call.agent} · ${call.model} · ${call.state === 'measured' ? `${call.inputTokens} input, ${call.outputTokens} output tokens; ${call.estimatedCostNanoUsd == null ? 'cost unavailable' : `${cost(call.estimatedCostNanoUsd)} estimated`}` : call.state === 'pending' ? 'usage pending or interrupted' : 'tokens unreported; charges may still apply'}`;
      return item;
    }));
    usagePricing.textContent = `Prices checked ${value.pricingDate}. Check provider billing for actual charges. OpenAI: ${value.pricingSources.openai} · Anthropic: ${value.pricingSources.anthropic}`;
    if (id && value.project.total.pendingCalls > 0) {
      usagePendingSince ||= Date.now();
      if (Date.now() - usagePendingSince < 60_000) {
        usageRetryTimer = setTimeout(() => {
          if (epoch === conversationEpoch && project?.id === id) loadUsage(id);
        }, 1500);
      }
    } else usagePendingSince = 0;
  } catch {
    if (sequence === usageSequence && epoch === conversationEpoch) {
      usageStatus.textContent = 'Usage records unavailable; no cost total can be verified.';
      usageAgents.replaceChildren();
      usageCalls.replaceChildren();
      usagePricing.textContent = '';
    }
  }
}
function setupState(name, value) { const target = document.querySelector(`#setup-${name}-state`); if (target) target.textContent = value; }
function pendingRequest(message) {
  if (requestState) { requestState.hidden = !message; requestState.textContent = message ?? ''; }
  window.dispatchEvent(new CustomEvent('village-request', { detail: message }));
}

officeForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.querySelector('#office-input');
  const result = document.querySelector('#office-setup-result');
  const button = officeForm.querySelector('button');
  button.disabled = true;
  try {
    const saved = await api('/api/setup', 'POST', { name: input.value });
    document.querySelector('#office-name').textContent = saved.name;
    setupState('office', saved.name);
    firstRun.hidden = true;
  } catch (error) { result.textContent = error.message; }
  finally { button.disabled = false; }
});

const domainForm = document.querySelector('#domain-form');
const domainFields = { audience: document.querySelector('#domain-audience'), expertise: document.querySelector('#domain-expertise'), rules: document.querySelector('#domain-rules') };
if (domainForm) api('/api/domain').then(profile => {
  for (const [name, field] of Object.entries(domainFields)) field.value = profile[name] || '';
  if (Object.values(profile).some(Boolean)) setupState('domain', 'Saved for new projects.');
}).catch(() => { document.querySelector('#domain-result').textContent = 'Could not load saved domain answers.'; });
domainForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = domainForm.querySelector('button');
  const result = document.querySelector('#domain-result');
  button.disabled = true;
  try {
    const profile = await api('/api/domain', 'POST', Object.fromEntries(Object.entries(domainFields).map(([name, field]) => [name, field.value])));
    setupState('domain', Object.values(profile).some(Boolean) ? 'Saved for new projects.' : 'No domain answers saved.');
    result.textContent = 'Saved on this computer. New projects will use these answers.';
  } catch (error) { result.textContent = error.message; }
  finally { button.disabled = false; }
});

function bubble(kind, message) { const item = document.createElement('p'); item.className = `bubble ${kind}`; item.textContent = message; conversation.append(item); }
function id() { return crypto.randomUUID(); }
async function api(path, method = 'GET', data) {
  const response = await fetch(path, { method, headers: data ? { 'content-type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Request failed');
  return value;
}
function display(value) {
  project = value;
  const nextUsage = `${value.id}:${value.status}:${value.events.length}`;
  if (nextUsage !== usageSignature) { usageSignature = nextUsage; loadUsage(value.id); }
  setupState('project', `${value.status.replaceAll('_', ' ')} · ${value.goal}`);
  window.villageProject = value;
  window.dispatchEvent(new CustomEvent('village-project', { detail: value }));
  sessionStorage.setItem('villageProjectId', value.id);
  const restoringChat = conversation.childElementCount === 0;
  if (restoringChat) bubble('user', value.goal);
  for (const event of value.events.slice(lastEventCount)) {
    const item = document.createElement('li');
    const title = document.createElement('strong'); title.textContent = `${simulated ? 'Simulated · ' : ''}${event.agent} · ${event.type}`;
    const detail = document.createElement('span'); detail.textContent = event.message;
    const time = document.createElement('small'); time.textContent = new Date(event.at).toLocaleString();
    item.append(title, detail, time);
    if (event.usage) { const usage = document.createElement('small'); usage.textContent = `Provider tokens: ${event.usage.input} input, ${event.usage.output} output`; item.append(usage); }
    if (event.findings?.length) { const findings = document.createElement('small'); findings.textContent = `Findings: ${event.findings.join('; ')}`; item.append(findings); }
    if (event.checks?.length) { const checks = document.createElement('small'); checks.textContent = `Local checks passed: ${event.checks.join('; ')}`; item.append(checks); }
    events.append(item);
    if (event.type === 'question') bubble('maya', event.message);
    if (restoringChat && event.type === 'answer') bubble('user', event.message);
    if (event.type === 'plan') bubble('maya', `Plan: ${event.message}\n\nAcceptance: ${value.plan?.acceptance?.join('; ') ?? ''}`);
    if (['review', 'blocked', 'error', 'cancelled'].includes(event.type)) bubble('system', `${event.agent}: ${event.message}`);
  }
  lastEventCount = value.events.length;
  build.hidden = value.status !== 'ready'; cancel.hidden = !['building', 'reviewing'].includes(value.status);
  if (exportButton) exportButton.hidden = value.status !== 'reviewed';
  newProject.hidden = ['clarifying', 'planning', 'building', 'reviewing'].includes(value.status);
  field.disabled = busy || !['needs_answer'].includes(value.status) && value.events.length > 0;
  form.querySelector('button').disabled = busy || field.disabled;
  if (value.artifact && !artifact.firstChild) {
    const heading = document.createElement('h3'); heading.textContent = value.status === 'reviewed' ? 'Reviewed artifact' : 'Artifact awaiting or requiring review';
    const link = document.createElement('a'); link.href = value.artifact.url; link.textContent = 'Open website'; link.target = '_blank'; link.rel = 'noopener';
    const digest = document.createElement('p'); digest.textContent = `SHA-256: ${value.artifact.sha256}`;
    const frame = document.createElement('iframe'); frame.src = value.artifact.url; frame.title = 'Generated website preview'; frame.sandbox = 'allow-same-origin';
    artifact.append(heading, link, digest, frame);
  }
  if (value.artifact) artifact.querySelector('h3').textContent = value.status === 'reviewed' ? 'Reviewed artifact' : 'Artifact awaiting or requiring review';
  else if (artifact.firstChild) artifact.replaceChildren();
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const message = field.value.trim(); if (!message) return;
  busy = true; form.querySelector('button').disabled = true;
  const epoch = conversationEpoch;
  const action = project ? 'answer' : 'create';
  pendingRequest(action === 'create' ? 'Goal sent. Waiting for Maya’s recorded clarification.' : 'Answer sent. Waiting for Maya’s recorded plan.');
  if (!pendingMessage || pendingMessage.message !== message || pendingMessage.action !== action) {
    pendingMessage = { message, action, requestId: id() };
  }
  field.value = '';
  try {
    const result = project ? await api(`/api/projects/${project.id}/answer`, 'POST', { answer: message, requestId: pendingMessage.requestId }) : await api('/api/projects', 'POST', { goal: message, requestId: pendingMessage.requestId });
    if (epoch !== conversationEpoch) return;
    bubble('user', message);
    display(result);
    pendingMessage = null;
  }
  catch (error) { if (epoch !== conversationEpoch) return; bubble('system', error.message); if (error.message === 'Do not put an API key in chat') pendingMessage = null; else field.value = message; }
  finally { if (epoch === conversationEpoch) { pendingRequest(null); busy = false; if (!project) form.querySelector('button').disabled = false; else display(project); } }
});
build.addEventListener('click', async () => { const epoch = conversationEpoch; const projectId = project.id; try { pendingBuildId ??= id(); const result = await api(`/api/projects/${projectId}/build`, 'POST', { requestId: pendingBuildId }); if (epoch !== conversationEpoch) return; display(result); pendingBuildId = null; } catch (error) { if (epoch === conversationEpoch) bubble('system', error.message); } });
cancel.addEventListener('click', async () => { const epoch = conversationEpoch; const projectId = project.id; try { const result = await api(`/api/projects/${projectId}/cancel`, 'POST'); if (epoch === conversationEpoch) display(result); } catch (error) { if (epoch === conversationEpoch) bubble('system', error.message); } });
exportButton?.addEventListener('click', async () => { const epoch = conversationEpoch; const projectId = project.id; exportButton.disabled = true; try { const result = await api(`/api/projects/${projectId}/export`, 'POST'); if (epoch !== conversationEpoch) return; exportPath.textContent = result.path; if (connectionButton) connectionButton.hidden = false; if (publishActions) publishActions.hidden = false; publishStatus.textContent = 'Reviewed files prepared locally. Check the project and exact target before choosing either publish action.'; setupState('publish', 'Reviewed files prepared. GitHub and Vercel actions are available below.'); } catch (error) { if (epoch === conversationEpoch) publishStatus.textContent = error.message; } finally { exportButton.disabled = false; } });
function publishResult(node, message, url) {
  node.textContent = message;
  if (url) { const link = document.createElement('a'); link.href = url; link.textContent = ' Open result ↗'; link.target = '_blank'; link.rel = 'noopener'; node.append(link); }
}
function previewMessage(receipt) {
  if (receipt.status === 'submitting') return 'Preview submission status is uncertain. Inspect Vercel before retrying.';
  if (receipt.status === 'needs_inspection') return `Vercel returned ${receipt.target} deployment ${receipt.deploymentId}. Inspect its target and protection; automatic retry is blocked.`;
  return `Preview ${receipt.deploymentId} is ${receipt.state}; inspect its status before sharing.`;
}
githubPublishForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const epoch = conversationEpoch;
  const button = githubPublishForm.querySelector('button');
  const resultNode = document.querySelector('#github-publish-result');
  button.disabled = true;
  resultNode.textContent = 'Checking the private repository and reviewed files…';
  try {
    const result = await api(`/api/projects/${project.id}/publish/github`, 'POST', {
      owner: document.querySelector('#github-owner').value.trim(), repo: document.querySelector('#github-repo').value.trim(), branch: document.querySelector('#github-branch').value.trim(),
    });
    if (epoch !== conversationEpoch) return;
    publishResult(resultNode, `GitHub commit ${result.commitSha} ${result.idempotent ? 'already held the reviewed files' : 'published the reviewed files'}.`, result.url);
    try { display(await api(`/api/projects/${project.id}`)); } catch {}
  } catch (error) { if (epoch === conversationEpoch) resultNode.textContent = error.message; }
  finally { button.disabled = false; }
});
vercelPublishForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const epoch = conversationEpoch;
  const button = vercelPublishForm.querySelector('button[type="submit"]');
  const resultNode = document.querySelector('#vercel-publish-result');
  button.disabled = true;
  resultNode.textContent = 'Checking the Vercel target and submitting a Preview…';
  try {
    const result = await api(`/api/projects/${project.id}/publish/vercel`, 'POST', {
      team: document.querySelector('#vercel-team').value.trim(), project: document.querySelector('#vercel-project').value.trim(),
    });
    if (epoch !== conversationEpoch) return;
    const receipt = result.preview;
    publishResult(resultNode, previewMessage(receipt), receipt.url);
    previewStatusButton.hidden = false;
    try { display(await api(`/api/projects/${project.id}`)); } catch {}
  } catch (error) {
    if (epoch === conversationEpoch) {
      try {
        const { preview } = await api(`/api/projects/${project.id}/publish`);
        if (epoch !== conversationEpoch) return;
        if (preview) { publishResult(resultNode, previewMessage(preview), preview.url); previewStatusButton.hidden = false; }
        else resultNode.textContent = error.message;
      } catch { resultNode.textContent = error.message; }
    }
  }
  finally { button.disabled = false; }
});
previewStatusButton?.addEventListener('click', async () => {
  const epoch = conversationEpoch;
  const projectId = project?.id;
  const resultNode = document.querySelector('#vercel-publish-result');
  previewStatusButton.disabled = true;
  try {
    const { preview } = await api(`/api/projects/${projectId}/publish`);
    if (epoch !== conversationEpoch || project?.id !== projectId) return;
    if (preview) publishResult(resultNode, previewMessage(preview), preview.url);
  } catch (error) { if (epoch === conversationEpoch && project?.id === projectId) resultNode.textContent = error.message; }
  finally { previewStatusButton.disabled = false; }
});
connectionButton?.addEventListener('click', async () => {
  const epoch = conversationEpoch;
  connectionButton.disabled = true;
  try {
    const result = await api('/api/connections', 'POST');
    if (epoch !== conversationEpoch) return;
    connectionStatus.textContent = `GitHub: ${result.github?.state === 'connected' ? `signed in as ${result.github.account}` : 'not verified'} · Vercel: ${result.vercel?.state === 'connected' ? `signed in as ${result.vercel.account}` : 'not verified'}. This does not grant publishing access.`;
  } catch { if (epoch === conversationEpoch) connectionStatus.textContent = 'Connection check unavailable.'; }
  finally { connectionButton.disabled = false; }
});
newProject.addEventListener('click', () => { conversationEpoch++; pendingRequest(null); sessionStorage.removeItem('villageProjectId'); project = null; window.villageProject = null; window.dispatchEvent(new CustomEvent('village-project', { detail: null })); busy = false; pendingMessage = null; pendingBuildId = null; lastEventCount = 0; usageSignature = ''; if (usageStatus) { usageStatus.textContent = 'Loading local usage…'; usageAgents.replaceChildren(); usageCalls.replaceChildren(); usagePricing.textContent = ''; } conversation.replaceChildren(); events.replaceChildren(); artifact.replaceChildren(); if (exportButton) exportButton.hidden = true; if (exportPath) exportPath.textContent = ''; if (publishActions) publishActions.hidden = true; if (previewStatusButton) previewStatusButton.hidden = true; if (connectionButton) connectionButton.hidden = true; if (connectionStatus) connectionStatus.textContent = ''; if (publishStatus) publishStatus.textContent = 'A reviewed local site is required before publishing. No publish action has been requested.'; setupState('project', 'Describe a small website below.'); setupState('publish', 'After review, prepare the site and inspect your publishing targets.'); newProject.hidden = true; build.hidden = true; cancel.hidden = true; field.disabled = false; form.querySelector('button').disabled = false; field.focus(); loadUsage(); });
setInterval(async () => { if (project && (['clarifying', 'planning', 'building', 'reviewing'].includes(project.status) || project.artifact)) { const epoch = conversationEpoch; const projectId = project.id; try { const result = await api(`/api/projects/${projectId}`); if (epoch === conversationEpoch && project?.id === projectId) display(result); } catch {} } }, 1000);
const initialEpoch = conversationEpoch;
api('/api/status').then(async value => {
  const officeName = document.querySelector('#office-name');
  if (officeName && value.officeName) officeName.textContent = value.officeName;
  setupState('office', value.officeName || 'Choose a name above.');
  setupState('provider', value.ready ? `${value.provider} configured on this server; live access unverified until a request succeeds.` : value.error || 'Provider key missing.');
  if (firstRun) firstRun.hidden = Boolean(value.officeName) || value.officeNameEditable === false;
  simulated = value.provider === 'mock';
  provider.textContent = simulated ? 'SIMULATED PROVIDER FOR QA · Responses are deterministic fixtures; no live model calls.' : value.ready ? `Server ready · ${value.provider} · ${value.model}. API use may incur provider charges.` : `Setup needed: ${value.error}. Set the key in your shell, then restart this server.`;
  if (!value.ready) form.querySelector('button').disabled = true;
  loadUsage();
  const saved = sessionStorage.getItem('villageProjectId');
  if (saved && value.ready) { try { const result = await api(`/api/projects/${saved}`); if (initialEpoch === conversationEpoch && !project) display(result); } catch { if (initialEpoch === conversationEpoch) sessionStorage.removeItem('villageProjectId'); } }
}).catch(error => { provider.textContent = error.message; });
