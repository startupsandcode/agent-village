const chat = document.querySelector('#hosted-chat');
const form = document.querySelector('#hosted-chat-form');
const message = document.querySelector('#hosted-message');
const state = document.querySelector('#hosted-request-state');
const events = document.querySelector('#hosted-events');
const artifact = document.querySelector('#hosted-artifact');
const build = document.querySelector('#hosted-build');
const review = document.querySelector('#hosted-review');
const cancel = document.querySelector('#hosted-cancel');
const another = document.querySelector('#hosted-new');
const publishPanel = document.querySelector('#hosted-publish');
const publishTargets = document.querySelector('#hosted-publish-targets');
const publishResult = document.querySelector('#hosted-publish-result');
const publishGithub = document.querySelector('#hosted-publish-github');
const publishVercel = document.querySelector('#hosted-publish-vercel');
const publishRefresh = document.querySelector('#hosted-publish-refresh');
let project = null;
let pending = null;
let busy = false;
let epoch = 0;
let restoringPoll = false;
let publishVersion = -1;
let publishStatusSequence = 0;
let targetFingerprints = null;

async function request(body) {
  const response = await fetch('/api/maya-projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Project request failed');
  return value;
}
function render(value, expectedEpoch = epoch) {
  if (expectedEpoch !== epoch || !value || (project && (value.id !== project.id ||
      !Number.isSafeInteger(value.version) || !Number.isSafeInteger(project.version) || value.version < project.version))) return false;
  project = value;
  sessionStorage.setItem('hostedVillageProjectId', value.id);
  message.disabled = !['needs_answer'].includes(value.status);
  form.querySelector('label').textContent = value.status === 'needs_answer' ? 'Your answer to Maya' : 'Project goal';
  form.querySelector('button').disabled = busy || message.disabled;
  build.hidden = value.status !== 'ready';
  review.hidden = value.status !== 'awaiting_review';
  cancel.hidden = !['clarifying', 'planning', 'building', 'reviewing'].includes(value.status);
  another.hidden = ['clarifying', 'planning', 'building', 'reviewing'].includes(value.status);
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
  publishGithub.hidden = true;
  publishVercel.hidden = true;
  try {
    const result = await request({ action: 'publishStatus', id });
    if (expectedEpoch !== epoch || project?.id !== id || sequence !== publishStatusSequence) return;
    const { github, vercel } = result.targets;
    targetFingerprints = { github: github.fingerprint, vercel: vercel.fingerprint };
    publishTargets.textContent = `GitHub: ${github.owner && github.repo && github.branch ? `${github.owner}/${github.repo} · ${github.branch}` : 'not configured'}; Vercel Preview: ${vercel.team && vercel.project ? `${vercel.team}/${vercel.project}` : 'not configured'}. Reviewed SHA-256 ${result.artifactSha256}.`;
    publishGithub.hidden = !github.available || result.receipts.github != null;
    publishVercel.hidden = !vercel.available || result.receipts.vercel != null;
    const lines = [];
    for (const service of ['github', 'vercel']) {
      const receipt = result.receipts[service];
      if (receipt) lines.push(receipt.status === 'submitting'
        ? `${service}: submission is uncertain. Inspect the configured target; automatic retry is blocked.`
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
publishRefresh?.addEventListener('click', () => { if (project?.id) loadPublishStatus(project.id); });
async function act(action, values = {}) {
  if (busy) return;
  busy = true;
  const thisEpoch = epoch;
  const key = `${action}:${project?.id ?? 'new'}:${JSON.stringify(values)}`;
  if (pending?.key !== key) pending = { key, requestId: crypto.randomUUID() };
  state.textContent = `Waiting for a recorded ${action} result…`;
  form.querySelector('button').disabled = true;
  build.disabled = true; review.disabled = true;
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
      ...(['start', 'create', 'answer', 'build', 'review'].includes(action) ? { requestId: pending.requestId } : {}) });
    if (thisEpoch !== epoch) return;
    pending = null; message.value = '';
    if (render(result, thisEpoch)) state.textContent = `${result.status.replaceAll('_', ' ')} · activity recorded below.`;
    return result;
  } catch (error) { if (thisEpoch === epoch) state.textContent = error.message; }
  finally { pollActive = false; clearInterval(timer); if (thisEpoch === epoch) { busy = false; build.disabled = false; review.disabled = false; if (project) render(project, thisEpoch); else form.querySelector('button').disabled = false; } }
}
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
cancel?.addEventListener('click', async () => {
  if (!project) return;
  const thisEpoch = epoch;
  try { const result = await request({ action: 'cancel', id: project.id }); if (render(result, thisEpoch)) state.textContent = 'Cancellation recorded.'; }
  catch (error) { if (thisEpoch === epoch) state.textContent = error.message; }
});
another?.addEventListener('click', () => {
  epoch++; project = null; pending = null; busy = false; publishVersion = -1; publishStatusSequence++; targetFingerprints = null;
  sessionStorage.removeItem('hostedVillageProjectId');
  events.replaceChildren(); artifact.replaceChildren(); message.value = ''; message.disabled = false;
  publishPanel.hidden = true; publishTargets.textContent = ''; publishResult.textContent = '';
  form.querySelector('label').textContent = 'Project goal'; form.querySelector('button').disabled = false;
  build.hidden = true; review.hidden = true; cancel.hidden = true; another.hidden = true;
  state.textContent = 'Describe a new small website.'; message.focus();
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
  const restoreEpoch = epoch;
  if (!response.ok) return;
  const status = await response.json();
  if (!status.runAvailable) return;
  chat.hidden = false;
  state.textContent = 'Hosted test mode is enabled. Give Maya a small static website goal.';
  const saved = sessionStorage.getItem('hostedVillageProjectId');
  if (saved) {
    const response = await fetch(`/api/maya-projects?id=${encodeURIComponent(saved)}`, { cache: 'no-store' });
    if (response.ok) {
      const restored = await response.json();
      if (!render(restored, restoreEpoch)) return;
      if (restored.status === 'clarifying') act('clarify');
    }
    else sessionStorage.removeItem('hostedVillageProjectId');
  }
}).catch(() => {});
