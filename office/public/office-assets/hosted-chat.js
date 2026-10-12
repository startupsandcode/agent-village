const chat = document.querySelector('#hosted-chat');
const dashboard = document.querySelector('#project-dashboard');
const projectList = document.querySelector('#project-list');
const projectListStatus = document.querySelector('#project-list-status');
const loadMore = document.querySelector('#project-load-more');
const createOpen = document.querySelector('#project-create-open');
const createView = document.querySelector('#project-create');
const createBack = document.querySelector('#project-create-back');
const createForm = document.querySelector('#hosted-create-form');
const createGoal = document.querySelector('#hosted-create-goal');
const createState = document.querySelector('#hosted-create-state');
const detailView = document.querySelector('#project-detail');
const detailBack = document.querySelector('#project-detail-back');
const detailTitle = document.querySelector('#project-detail-title');
const detailMeta = document.querySelector('#project-detail-meta');
const progress = document.querySelector('#project-progress');
const planPanel = document.querySelector('#project-plan');
const team = document.querySelector('#project-team');
const globalOffice = document.querySelector('#global-office');
const form = document.querySelector('#hosted-chat-form');
const message = document.querySelector('#hosted-message');
const state = document.querySelector('#hosted-request-state');
const events = document.querySelector('#hosted-events');
const artifact = document.querySelector('#hosted-artifact');
const build = document.querySelector('#hosted-build');
const review = document.querySelector('#hosted-review');
const retryQuestion = document.querySelector('#hosted-retry-question');
const cancel = document.querySelector('#hosted-cancel');
const another = document.querySelector('#hosted-new');
const publishPanel = document.querySelector('#hosted-publish');
const publishTargets = document.querySelector('#hosted-publish-targets');
const publishResult = document.querySelector('#hosted-publish-result');
const publishGithub = document.querySelector('#hosted-publish-github');
const publishVercel = document.querySelector('#hosted-publish-vercel');
const publishReconcile = document.querySelector('#hosted-publish-reconcile');
const publishRefresh = document.querySelector('#hosted-publish-refresh');
const usageStatus = document.querySelector('#hosted-usage-status');
const usageAgents = document.querySelector('#hosted-usage-agents');
const usageCalls = document.querySelector('#hosted-usage-calls');
const usagePricing = document.querySelector('#hosted-usage-pricing');
const domainForm = document.querySelector('#hosted-domain-form');
const domainResult = document.querySelector('#hosted-domain-result');
const domainFields = Object.fromEntries(['audience', 'expertise', 'rules'].map(name => [name, document.querySelector(`#hosted-domain-${name}`)]));
let project = null;
let pending = null;
let busy = false;
let epoch = 0;
let restoringPoll = false;
let publishVersion = -1;
let publishStatusSequence = 0;
let reconcileAttempt = null;
let targetFingerprints = null;
let usageSequence = 0;
let lastUsageSignature = '';
let usagePending = false;
let usagePendingSince = 0;
let domainVersion = 0;
let savedDomainVersion = 0;
let view = 'dashboard';
let selectedProjectId = null;
let listOffset = 0;
let listSequence = 0;
let listLoadError = false;
let createAttempt = null;
for (const field of Object.values(domainFields)) field?.addEventListener('input', () => {
  domainVersion++; domainResult.textContent = 'Unsaved changes. Save before starting a new project.';
});

async function loadDomain() {
  if (!domainForm) return;
  const version = domainVersion;
  try {
    const response = await fetch('/api/maya-domain', { cache: 'no-store' });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? 'Domain answers unavailable');
    if (version !== domainVersion) return;
    for (const [name, field] of Object.entries(domainFields)) field.value = value[name] ?? '';
    savedDomainVersion = version;
    domainResult.textContent = Object.values(value).some(Boolean) ? 'Saved domain answers loaded.' : 'Optional: add your domain answers before starting a project.';
  } catch { if (version === domainVersion) domainResult.textContent = 'Domain answers could not be loaded. New projects are unavailable until setup is ready.'; }
}
domainForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const version = ++domainVersion;
  const button = domainForm.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/api/maya-domain', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(Object.entries(domainFields).map(([name, field]) => [name, field.value]))) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? 'Domain answers unavailable');
    if (version === domainVersion) {
      for (const [name, field] of Object.entries(domainFields)) field.value = value[name];
      savedDomainVersion = version;
      domainResult.textContent = 'Saved for new projects. Current projects keep their earlier answers.';
    }
  } catch (error) { if (version === domainVersion) domainResult.textContent = error.message; }
  finally { button.disabled = false; }
});

function dollars(nano) { return nano > 0 && nano < 1000 ? '<$0.000001' : `$${(Number(nano) / 1_000_000_000).toFixed(6)}`; }
function usageLine(label, value) {
  return `${label}: ${value.calls} call${value.calls === 1 ? '' : 's'}, ${value.inputTokens} input and ${value.outputTokens} output tokens, ${dollars(value.estimatedCostNanoUsd)} estimated API cost` +
    (value.unpricedCalls ? `; ${value.unpricedCalls} measured call${value.unpricedCalls === 1 ? '' : 's'} without a price` : '') +
    (value.pendingCalls || value.unreportedCalls ? `; ${value.pendingCalls} pending, ${value.unreportedCalls} without reported tokens` : '');
}
async function loadUsage(id = null) {
  const sequence = ++usageSequence;
  const expectedEpoch = epoch;
  const query = id ? `?projectId=${encodeURIComponent(id)}` : '';
  try {
    const response = await fetch(`/api/maya-usage${query}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Usage records unavailable');
    const data = await response.json();
    if (sequence !== usageSequence || expectedEpoch !== epoch || (id && project?.id !== id)) return;
    usagePending = data.project.total.pendingCalls > 0 || data.monthly.total.pendingCalls > 0;
    if (usagePending) usagePendingSince ||= Date.now();
    else usagePendingSince = 0;
    usageStatus.textContent = `${usageLine('This project', data.project.total)}. ${usageLine(`${data.month} across your projects`, data.monthly.total)}.` +
      (data.project.truncated || data.monthly.truncated ? ' Records exceed this view limit; totals shown are partial.' : '');
    usageAgents.replaceChildren(...Object.entries(data.project.agents).map(([agent, value]) => {
      const item = document.createElement('li'); item.textContent = usageLine(agent, value); return item;
    }));
    usageCalls.replaceChildren(...data.calls.map(call => {
      const item = document.createElement('li');
      const input = call.inputTokens + (call.provider === 'anthropic' ? call.cachedInputTokens + call.cacheCreationInputTokens : 0);
      item.textContent = `${call.agent} · ${call.model} · ${call.state === 'measured' ? `${input} total input, ${call.outputTokens} output tokens; ${call.estimatedCostNanoUsd == null ? 'cost unavailable' : `${dollars(call.estimatedCostNanoUsd)} estimated`}` : call.state === 'pending' ? 'provider result pending; usage unknown' : 'provider did not report tokens; actual billing may differ'}`;
      return item;
    }));
    usagePricing.replaceChildren();
    usagePricing.append(document.createTextNode(`Prices checked ${data.pricingDate}. Estimates use provider token counts and published model rates; check provider billing for actual charges. `));
    for (const [name, href] of Object.entries(data.pricingSources)) {
      const link = document.createElement('a'); link.href = href; link.textContent = `${name} pricing`; link.target = '_blank'; link.rel = 'noopener';
      usagePricing.append(link, document.createTextNode(' '));
    }
  } catch {
    if (sequence === usageSequence && expectedEpoch === epoch) {
      usageStatus.textContent = 'Usage records unavailable. No cost total can be verified.';
      usagePending = false;
      usageAgents.replaceChildren(); usageCalls.replaceChildren(); usagePricing.textContent = '';
    }
  }
}
setInterval(() => { if (!chat.hidden && usagePending && Date.now() - usagePendingSince < 60_000) loadUsage(project?.id ?? null); }, 5000);

async function request(body) {
  const response = await fetch('/api/maya-projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Project request failed');
  return value;
}
const projectHash = /^#project\/([A-Za-z0-9-]{1,80})$/;
const workingStatuses = new Set(['clarifying', 'needs_answer', 'planning', 'ready', 'building', 'awaiting_review', 'reviewing']);
function showView(next) {
  view = next;
  dashboard.hidden = next !== 'dashboard';
  createView.hidden = next !== 'create';
  detailView.hidden = next !== 'detail';
  if (globalOffice) globalOffice.hidden = next !== 'dashboard';
}
function changeHash(value) {
  if (globalThis.location && globalThis.location.hash !== value) globalThis.location.hash = value;
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time not recorded' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function statusLabel(value, retryQuestionAvailable = false) {
  if (retryQuestionAvailable) return 'Retry Maya question';
  return ({ needs_answer: 'Maya needs your answer', ready: 'Ready to build', awaiting_review: 'Ready for Quinn review',
    reviewed: 'Reviewed', blocked: 'Needs attention', interrupted: 'Interrupted', question_error: 'Retry Maya question' })[value] ?? String(value ?? 'Unknown').replaceAll('_', ' ');
}
function projectCard(item) {
  const link = document.createElement('a');
  link.className = 'project-card';
  link.href = `#project/${item.id}`;
  link.setAttribute('aria-label', `Open project: ${item.goal ?? 'Untitled project'}`);
  const top = document.createElement('div'); top.className = 'project-card-top';
  const title = document.createElement('strong'); title.textContent = item.goal || 'Untitled project';
  const badge = document.createElement('span'); badge.className = `project-badge${workingStatuses.has(item.status) ? ' is-active' : ''}`;
  badge.textContent = statusLabel(item.status, item.status === 'blocked' && item.latestAgent === 'Maya' && item.latestMessage === 'Maya returned an invalid question');
  top.append(title, badge);
  const activity = document.createElement('p');
  activity.textContent = item.latestMessage ? `${item.latestAgent ?? 'Team'} · ${item.latestMessage}` : 'No team activity recorded yet.';
  const time = document.createElement('small'); time.textContent = `Updated ${dateLabel(item.updatedAt ?? item.createdAt)}`;
  link.append(top, activity, time);
  link.addEventListener('click', event => { event.preventDefault(); changeHash(`#project/${item.id}`); openProject(item.id); });
  return link;
}
async function loadProjects(reset = false) {
  const sequence = ++listSequence;
  if (reset) { listOffset = 0; projectList.replaceChildren(); }
  projectListStatus.textContent = reset ? 'Loading projects…' : 'Loading more projects…';
  loadMore.hidden = true;
  try {
    const response = await fetch(`/api/maya-projects?offset=${listOffset}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.projects)) throw new Error(data.error ?? 'Project list unavailable');
    if (sequence !== listSequence || view !== 'dashboard') return;
    projectList.append(...data.projects.map(projectCard));
    listOffset += data.projects.length;
    listLoadError = false;
    projectListStatus.textContent = listOffset ? `${listOffset} project${listOffset === 1 ? '' : 's'} shown. Current work comes first.`
      : 'No projects yet. Create one to talk with Maya.';
    loadMore.hidden = !data.hasMore;
    loadMore.textContent = 'Show more projects';
  } catch {
    if (sequence !== listSequence || view !== 'dashboard') return;
    listLoadError = true;
    projectListStatus.textContent = 'Projects could not be loaded. Try again.';
    loadMore.textContent = 'Try again'; loadMore.hidden = false;
  }
}
function goDashboard(updateHash = true) {
  epoch++; project = null; selectedProjectId = null; pending = null; busy = false;
  publishVersion = -1; publishStatusSequence++; targetFingerprints = null; reconcileAttempt = null;
  usagePending = false; usagePendingSince = 0; lastUsageSignature = '';
  showView('dashboard');
  if (updateHash) changeHash('');
  loadProjects(true);
}
function clearDetail() {
  detailMeta.textContent = ''; progress.textContent = '';
  planPanel.replaceChildren(); team.replaceChildren(); events.replaceChildren(); artifact.replaceChildren();
  usageStatus.textContent = 'Usage records unavailable until this project opens.';
  usageAgents.replaceChildren(); usageCalls.replaceChildren(); usagePricing.replaceChildren();
  publishPanel.hidden = true; publishTargets.textContent = ''; publishResult.textContent = '';
  publishGithub.hidden = true; publishVercel.hidden = true; publishReconcile.hidden = true;
  message.disabled = true; form.querySelector('button').disabled = true;
  build.hidden = true; review.hidden = true; retryQuestion.hidden = true; cancel.hidden = true;
}
function openCreate(updateHash = true) {
  epoch++; project = null; selectedProjectId = null; pending = null; busy = false;
  showView('create');
  createBack.disabled = false; createForm.querySelector('button').disabled = false;
  createGoal.value = createAttempt?.promise ? createAttempt.goal : '';
  createState.textContent = createAttempt?.promise ? 'Your project request is still finishing. Submit this same goal to reopen its result.'
    : 'Describe a small result for Maya to plan.';
  if (updateHash) changeHash('#new');
  createGoal.focus();
}
async function openProject(id) {
  if (selectedProjectId === id && view === 'detail') return;
  const thisEpoch = ++epoch;
  project = null; pending = null; busy = false; selectedProjectId = id;
  publishVersion = -1; publishStatusSequence++; targetFingerprints = null; reconcileAttempt = null;
  showView('detail');
  clearDetail();
  detailTitle.textContent = 'Opening project…'; state.textContent = 'Loading saved work…';
  try {
    const response = await fetch(`/api/maya-projects?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const saved = await response.json();
    if (!response.ok) throw new Error(saved.error ?? 'Project unavailable');
    if (thisEpoch !== epoch || selectedProjectId !== id) return;
    if (!render(saved, thisEpoch)) throw new Error('Project receipt could not be read');
    state.textContent = `${statusLabel(saved.status, saved.retryQuestionAvailable)} · activity recorded below.`;
    if (saved.status === 'clarifying' && !saved.clarifyRunId) act('clarify');
  } catch (error) { if (thisEpoch === epoch) { detailTitle.textContent = 'Project unavailable'; state.textContent = `${error.message}. Return to all projects and try again.`; } }
}
createOpen?.addEventListener('click', () => openCreate());
createBack?.addEventListener('click', () => goDashboard());
detailBack?.addEventListener('click', () => goDashboard());
loadMore?.addEventListener('click', () => loadProjects(listLoadError));
globalThis.addEventListener?.('hashchange', () => {
  const id = projectHash.exec(globalThis.location?.hash ?? '')?.[1];
  if (id) { if (selectedProjectId !== id || view !== 'detail') openProject(id); }
  else if (globalThis.location?.hash === '#new') { if (view !== 'create') openCreate(false); }
  else if (view !== 'dashboard') goDashboard(false);
});
function render(value, expectedEpoch = epoch) {
  if (expectedEpoch !== epoch || !value || (project && (value.id !== project.id ||
      !Number.isSafeInteger(value.version) || !Number.isSafeInteger(project.version) || value.version < project.version))) return false;
  project = value;
  const usageSignature = `${value.id}:${value.status}:${value.events.length}`;
  if (usageSignature !== lastUsageSignature) { lastUsageSignature = usageSignature; loadUsage(value.id); }
  sessionStorage.setItem('hostedVillageProjectId', value.id);
  detailTitle.textContent = value.goal || 'Untitled project';
  detailMeta.textContent = `Created ${dateLabel(value.createdAt)} · ${statusLabel(value.status, value.retryQuestionAvailable)}`;
  progress.textContent = value.retryQuestionAvailable
    ? 'Maya could not record a question. Retry Maya on this saved project; there is no question for you to answer yet.'
    : `${statusLabel(value.status)}. ${value.events.at(-1)?.agent ?? 'Team'} last recorded: ${value.events.at(-1)?.message ?? 'No activity yet.'}`;
  planPanel.replaceChildren();
  const planTitle = document.createElement('h4'); planTitle.textContent = 'Maya’s plan';
  const planText = document.createElement('p'); planText.textContent = value.plan?.summary ?? 'Maya has not recorded a plan yet.';
  planPanel.append(planTitle, planText);
  team.replaceChildren(...['Maya', 'Sam', 'Quinn'].map(agent => {
    const row = document.createElement('li');
    const latest = value.events.filter(entry => entry.agent === agent).at(-1);
    row.textContent = `${agent}: ${latest ? `last recorded ${latest.type} — ${latest.message}` : 'no recorded activity yet'}`;
    return row;
  }));
  message.disabled = !['needs_answer'].includes(value.status);
  form.querySelector('label').textContent = 'Your answer to Maya';
  form.querySelector('button').disabled = busy || message.disabled;
  build.hidden = value.status !== 'ready';
  review.hidden = value.status !== 'awaiting_review' && !value.retryReviewAvailable;
  retryQuestion.hidden = !value.retryQuestionAvailable;
  retryQuestion.disabled = busy;
  review.textContent = value.retryReviewAvailable ? 'Retry Quinn review once' : 'Ask Quinn to review';
  cancel.hidden = !['clarifying', 'planning', 'building', 'reviewing'].includes(value.status);
  another.disabled = busy;
  events.replaceChildren(...value.events.map(entry => {
    const row = document.createElement('li');
    row.textContent = `${entry.agent} · ${entry.type}: ${entry.message}`;
    if (entry.reviewedSha256) row.textContent += ` · reviewed SHA-256 ${entry.reviewedSha256}`;
    return row;
  }));
  artifact.replaceChildren();
  publishPanel.hidden = value.status !== 'reviewed';
  if (value.status === 'reviewed' && publishVersion !== value.version) {
    publishVersion = value.version;
    loadPublishStatus(value.id, expectedEpoch);
  }
  if (value.artifact) {
    const label = document.createElement('p');
    label.textContent = `${value.status === 'reviewed' ? 'Reviewed' : 'Awaiting or requiring review'} website · SHA-256 ${value.artifact.sha256}`;
    const link = document.createElement('a');
    link.href = `/api/maya-artifacts/${encodeURIComponent(value.id)}/index.html`;
    link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Open generated site';
    const frame = document.createElement('iframe');
    frame.src = link.href; frame.title = 'Generated website preview'; frame.sandbox = 'allow-same-origin';
    artifact.append(label, link, frame);
  }
  return true;
}
async function loadPublishStatus(id, expectedEpoch = epoch) {
  const sequence = ++publishStatusSequence;
  targetFingerprints = null;
  reconcileAttempt = null;
  publishGithub.hidden = true;
  publishVercel.hidden = true;
  publishReconcile.hidden = true;
  try {
    const result = await request({ action: 'publishStatus', id });
    if (expectedEpoch !== epoch || project?.id !== id || sequence !== publishStatusSequence) return;
    const { github, vercel } = result.targets;
    targetFingerprints = { github: github.fingerprint, vercel: vercel.fingerprint };
    if (result.receipts.vercel?.status === 'submitting') reconcileAttempt = {
      attemptStartedAt: result.receipts.vercel.startedAt, attemptId: result.receipts.vercel.attemptId ?? null,
    };
    publishTargets.textContent = `GitHub: ${github.owner && github.repo && github.branch ? `${github.owner}/${github.repo} · ${github.branch}` : 'not configured'}; Vercel Preview: ${vercel.team && vercel.project ? `${vercel.team}/${vercel.project}` : 'not configured'}. Reviewed SHA-256 ${result.artifactSha256}.`;
    publishGithub.hidden = !github.available || result.receipts.github != null;
    publishVercel.hidden = !vercel.available || (result.receipts.vercel != null && result.receipts.vercel.status !== 'reconciled');
    publishReconcile.hidden = !vercel.available || result.receipts.vercel?.status !== 'submitting';
    const lines = [];
    for (const service of ['github', 'vercel']) {
      const receipt = result.receipts[service];
      if (receipt) lines.push(receipt.status === 'submitting'
        ? `${service}: submission is uncertain. Inspect the configured target; automatic retry is blocked.`
        : receipt.status === 'needs_inspection'
          ? `${service}: unsafe ${receipt.receipt?.target ?? 'unknown'} deployment ${receipt.receipt?.deploymentId ?? 'unknown ID'}; inspect and remove if needed. Automatic retry is blocked.`
          : receipt.status === 'reconciled'
            ? `${service}: supplied deployment ID ${receipt.receipt?.deletedDeploymentId} is absent; protected baseline ${receipt.receipt?.baselineDeploymentId} retained. You may explicitly deploy Preview now.`
            : `${service}: ${receipt.receipt?.commitSha ?? receipt.receipt?.deploymentId} · ${receipt.receipt?.state ?? 'commit recorded'}${receipt.receipt?.url ? ` · ${receipt.receipt.url}` : ''}`);
    }
    publishResult.textContent = lines.length ? lines.join('\n') : 'No publication has been requested.';
  } catch (error) { if (expectedEpoch === epoch && project?.id === id && sequence === publishStatusSequence) publishResult.textContent = error.message; }
}
async function publish(service) {
  if (!project || project.status !== 'reviewed') return;
  const expectedEpoch = epoch;
  const id = project.id;
  const reviewedSha = project.artifact.sha256;
  const button = service === 'github' ? publishGithub : publishVercel;
  const targetFingerprint = targetFingerprints?.[service];
  if (!targetFingerprint || button.hidden) return;
  publishStatusSequence++;
  button.disabled = true;
  publishResult.textContent = `Submitting reviewed ${service === 'github' ? 'files to GitHub' : 'site to Vercel Preview'}…`;
  try {
    const result = await request({ action: service === 'github' ? 'publishGithub' : 'publishVercel', id, artifactSha256: reviewedSha, targetFingerprint });
    if (expectedEpoch !== epoch || project?.id !== id) return;
    publishResult.textContent = result.status === 'submitting' ? 'Submission status is uncertain. Inspect the configured target; automatic retry is blocked.' :
      `${service} accepted ${result.receipt?.commitSha ?? result.receipt?.deploymentId}; check the recorded status below.`;
    await loadPublishStatus(id, expectedEpoch);
    const response = await fetch(`/api/maya-projects?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (response.ok) render(await response.json(), expectedEpoch);
  } catch (error) {
    if (expectedEpoch === epoch && project?.id === id) {
      publishResult.textContent = `${error.message} Check publish status before trying again.`;
      await loadPublishStatus(id, expectedEpoch);
    }
  } finally { button.disabled = false; }
}
publishGithub?.addEventListener('click', () => publish('github'));
publishVercel?.addEventListener('click', () => publish('vercel'));
publishReconcile?.addEventListener('click', async () => {
  if (!project || project.status !== 'reviewed' || publishReconcile.hidden || !targetFingerprints?.vercel || !reconcileAttempt) return;
  const deletedDeploymentId = window.prompt('Enter the exact deleted Vercel deployment ID after verifying it is gone:');
  if (!deletedDeploymentId) return;
  const baselineDeploymentId = window.prompt('Enter the exact protected placeholder Production deployment ID:');
  if (!baselineDeploymentId) return;
  const id = project.id, expectedEpoch = epoch;
  publishReconcile.disabled = true;
  try {
    await request({ action: 'reconcileVercel', id, artifactSha256: project.artifact.sha256,
      targetFingerprint: targetFingerprints.vercel, deletedDeploymentId, baselineDeploymentId, ...reconcileAttempt });
    if (expectedEpoch !== epoch || project?.id !== id) return;
    await loadPublishStatus(id, expectedEpoch);
    const response = await fetch(`/api/maya-projects?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (response.ok) render(await response.json(), expectedEpoch);
  } catch (error) { if (expectedEpoch === epoch && project?.id === id) publishResult.textContent = error.message; }
  finally { publishReconcile.disabled = false; }
});
publishRefresh?.addEventListener('click', () => { if (project?.id) loadPublishStatus(project.id); });
async function act(action, values = {}) {
  if (busy) return;
  busy = true;
  const starting = action === 'start' || action === 'create';
  const feedback = starting ? createState : state;
  const submit = starting ? createForm.querySelector('button') : form.querySelector('button');
  const thisEpoch = epoch;
  const key = `${action}:${project?.id ?? 'new'}:${JSON.stringify(values)}`;
  if (pending?.key !== key) pending = { key, requestId: crypto.randomUUID() };
  if (starting && createAttempt?.goal === values.goal) pending.requestId = createAttempt.requestId;
  const pendingRequestId = pending.requestId;
  feedback.textContent = `Waiting for a recorded ${action} result…`;
  submit.disabled = true;
  if (starting) createBack.disabled = true;
  build.disabled = true; review.disabled = true; retryQuestion.disabled = true;
  let pollActive = true;
  let polling = false;
  const timer = setInterval(async () => {
    if (!project?.id || polling) return;
    polling = true;
    try {
      const response = await fetch(`/api/maya-projects?id=${encodeURIComponent(project.id)}`, { cache: 'no-store' });
      if (pollActive && response.ok) {
        const result = await response.json();
        if (pollActive) render(result, thisEpoch);
      }
    } catch { /* the action response still reports the outcome */ }
    finally { polling = false; }
  }, 500);
  try {
    const result = await request({ action, ...(project ? { id: project.id } : {}), ...values,
      ...(['start', 'create', 'answer', 'build', 'review', 'retryQuestion'].includes(action) ? { requestId: pendingRequestId } : {}) });
    if (starting && createAttempt?.requestId === pendingRequestId) createAttempt.result = result;
    if (thisEpoch !== epoch) {
      if (starting && view === 'create' && createAttempt?.goal === values.goal && createGoal.value.trim() === values.goal) {
        selectedProjectId = result.id;
        showView('detail'); changeHash(`#project/${result.id}`);
        render(result, epoch);
      } else if (starting && view === 'create') {
        createState.textContent = 'Previous project was created. Open All projects to see it; your new draft is still here.';
      } else if (starting && view === 'dashboard') loadProjects(true);
      return result;
    }
    pending = null;
    if (starting) {
      if (view !== 'create' || createGoal.value.trim() !== values.goal) {
        if (view === 'create') createState.textContent = 'Previous project was created. Open All projects to see it; your new draft is still here.';
        return result;
      }
      selectedProjectId = result.id;
      showView('detail'); changeHash(`#project/${result.id}`);
      createGoal.value = '';
    } else message.value = '';
    if (render(result, thisEpoch)) state.textContent = `${statusLabel(result.status, result.retryQuestionAvailable)} · activity recorded below.`;
    return result;
  } catch (error) { if (thisEpoch === epoch) feedback.textContent = error.message; }
  finally { pollActive = false; clearInterval(timer); if (thisEpoch === epoch) {
    busy = false; build.disabled = false; review.disabled = false; retryQuestion.disabled = false; createBack.disabled = false;
    if (project) render(project, thisEpoch); else submit.disabled = false;
  } }
}
createForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const goal = createGoal.value.trim();
  if (!goal) return;
  if (domainVersion !== savedDomainVersion) { createState.textContent = 'Save your domain answers before starting this project.'; return; }
  if (createAttempt?.promise && createAttempt.goal !== goal) {
    createState.textContent = 'Wait for the previous project request to finish before starting another.';
    return;
  }
  if (!createAttempt || createAttempt.goal !== goal) createAttempt = { goal, requestId: crypto.randomUUID(), result: null, promise: null, clarifyStarted: false };
  const attempt = createAttempt;
  if (!attempt.promise && !attempt.result) {
    attempt.promise = act('start', { goal });
    attempt.promise.finally(() => { attempt.promise = null; });
  }
  const started = attempt.result ?? await attempt.promise;
  if (started && view === 'create' && createGoal.value.trim() === goal) {
    selectedProjectId = started.id; showView('detail'); changeHash(`#project/${started.id}`); render(started, epoch);
  }
  if (started && view === 'detail' && project?.id === started.id && createAttempt === attempt) createAttempt = null;
  if (started?.status === 'clarifying' && view === 'detail' && project?.id === started.id && !attempt.clarifyStarted) {
    attempt.clarifyStarted = true;
    await act('clarify');
  }
});
form?.addEventListener('submit', async event => {
  event.preventDefault();
  const value = message.value.trim();
  if (!value) return;
  if (project) await act('answer', { answer: value });
  else {
    const started = await act('start', { goal: value });
    if (started?.status === 'clarifying') await act('clarify');
  }
});
build?.addEventListener('click', () => act('build'));
review?.addEventListener('click', () => act('review'));
retryQuestion?.addEventListener('click', () => act('retryQuestion'));
cancel?.addEventListener('click', async () => {
  if (!project) return;
  const thisEpoch = epoch;
  try { const result = await request({ action: 'cancel', id: project.id }); if (render(result, thisEpoch)) state.textContent = 'Cancellation recorded.'; }
  catch (error) { if (thisEpoch === epoch) state.textContent = error.message; }
});
another?.addEventListener('click', () => {
  openCreate();
});
// A function may keep working after a tab reload. Read its durable stage until
// the stored result arrives; a duplicate clarify action must not start a call.
setInterval(async () => {
  if (busy || restoringPoll || !project || !['clarifying', 'planning', 'building', 'reviewing'].includes(project.status)) return;
  restoringPoll = true;
  const thisEpoch = epoch;
  const id = project.id;
  try {
    const response = await fetch(`/api/maya-projects?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!response.ok) return;
    const result = await response.json();
    if (thisEpoch === epoch && !busy && project?.id === id && Number.isSafeInteger(result.version) &&
        Number.isSafeInteger(project.version) && result.version > project.version) {
      if (render(result, thisEpoch)) state.textContent = `${result.status.replaceAll('_', ' ')} · activity recorded below.`;
    }
  } catch { /* next interval can retry a status read */ }
  finally { restoringPoll = false; }
}, 2000);
fetch('/api/maya-status', { cache: 'no-store' }).then(async response => {
  if (!response.ok) return;
  const status = await response.json();
  if (!status.runAvailable) return;
  chat.hidden = false;
  const setup = document.querySelector('#maya-setup');
  if (setup) setup.hidden = true;
  loadDomain();
  const hash = globalThis.location?.hash ?? '';
  const selected = projectHash.exec(hash)?.[1];
  if (selected) openProject(selected);
  else if (hash === '#new') openCreate(false);
  else { showView('dashboard'); loadProjects(true); }
}).catch(() => {});
