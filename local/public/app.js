const form = document.querySelector('#chat-form');
const field = document.querySelector('#message');
const conversation = document.querySelector('#conversation');
const events = document.querySelector('#events');
const provider = document.querySelector('#provider');
const build = document.querySelector('#build');
const cancel = document.querySelector('#cancel');
const newProject = document.querySelector('#new-project');
const artifact = document.querySelector('#artifact');
let project = null;
let busy = false;
let lastEventCount = 0;
let pendingMessage = null;
let pendingBuildId = null;

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
  sessionStorage.setItem('villageProjectId', value.id);
  for (const event of value.events.slice(lastEventCount)) {
    const item = document.createElement('li');
    const title = document.createElement('strong'); title.textContent = `${event.agent} · ${event.type}`;
    const detail = document.createElement('span'); detail.textContent = event.message;
    const time = document.createElement('small'); time.textContent = new Date(event.at).toLocaleString();
    item.append(title, detail, time);
    if (event.usage) { const usage = document.createElement('small'); usage.textContent = `Provider tokens: ${event.usage.input} input, ${event.usage.output} output`; item.append(usage); }
    if (event.findings?.length) { const findings = document.createElement('small'); findings.textContent = `Findings: ${event.findings.join('; ')}`; item.append(findings); }
    events.append(item);
    if (event.type === 'question') bubble('maya', event.message);
    if (event.type === 'plan') bubble('maya', `Plan: ${event.message}\n\nAcceptance: ${value.plan?.acceptance?.join('; ') ?? ''}`);
    if (['review', 'blocked', 'error', 'cancelled'].includes(event.type)) bubble('system', `${event.agent}: ${event.message}`);
  }
  lastEventCount = value.events.length;
  build.hidden = value.status !== 'ready'; cancel.hidden = !['building', 'reviewing'].includes(value.status);
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
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const message = field.value.trim(); if (!message) return;
  busy = true; form.querySelector('button').disabled = true;
  const action = project ? 'answer' : 'create';
  if (!pendingMessage || pendingMessage.message !== message || pendingMessage.action !== action) {
    pendingMessage = { message, action, requestId: id() };
  }
  field.value = '';
  try {
    const result = project ? await api(`/api/projects/${project.id}/answer`, 'POST', { answer: message, requestId: pendingMessage.requestId }) : await api('/api/projects', 'POST', { goal: message, requestId: pendingMessage.requestId });
    bubble('user', message);
    display(result);
    pendingMessage = null;
  }
  catch (error) { bubble('system', error.message); if (error.message === 'Do not put an API key in chat') pendingMessage = null; else field.value = message; }
  finally { busy = false; if (!project) form.querySelector('button').disabled = false; else display(project); }
});
build.addEventListener('click', async () => { try { pendingBuildId ??= id(); display(await api(`/api/projects/${project.id}/build`, 'POST', { requestId: pendingBuildId })); pendingBuildId = null; } catch (error) { bubble('system', error.message); } });
cancel.addEventListener('click', async () => { try { display(await api(`/api/projects/${project.id}/cancel`, 'POST')); } catch (error) { bubble('system', error.message); } });
newProject.addEventListener('click', () => { sessionStorage.removeItem('villageProjectId'); project = null; pendingMessage = null; pendingBuildId = null; lastEventCount = 0; conversation.replaceChildren(); events.replaceChildren(); artifact.replaceChildren(); newProject.hidden = true; build.hidden = true; cancel.hidden = true; field.disabled = false; form.querySelector('button').disabled = false; field.focus(); });
setInterval(async () => { if (project && ['clarifying', 'planning', 'building', 'reviewing'].includes(project.status)) { try { display(await api(`/api/projects/${project.id}`)); } catch {} } }, 1000);
api('/api/status').then(async value => {
  provider.textContent = value.ready ? `Server ready · ${value.provider} · ${value.model}. API use may incur provider charges.` : `Setup needed: ${value.error}. Set the key in your shell, then restart this server.`;
  if (!value.ready) form.querySelector('button').disabled = true;
  const saved = sessionStorage.getItem('villageProjectId');
  if (saved && value.ready) { try { display(await api(`/api/projects/${saved}`)); } catch { sessionStorage.removeItem('villageProjectId'); } }
}).catch(error => { provider.textContent = error.message; });
