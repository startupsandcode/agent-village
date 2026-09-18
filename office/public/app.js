const roster = [
  { name: 'Maya', role: 'Engineering lead', object: 'lamp', tone: 'coral' },
  { name: 'Sam', role: 'Implementation', object: 'code', tone: 'teal' },
  { name: 'Quinn', role: 'Independent review', object: 'paper', tone: 'gold' },
  { name: 'Theo', role: 'Architecture', object: 'plan', tone: 'blue' },
  { name: 'Susie', role: 'Product design', object: 'swatch', tone: 'pink' },
];

const grid = document.querySelector('#agent-grid');
const taskList = document.querySelector('#task-list');
const refreshButton = document.querySelector('#refresh-button');
const fetchMessage = document.querySelector('#fetch-message');
let lastSuccessfulUpdate = null;
let latestData = null;
let lastAnnouncement = null;

function stampSampleTimes(data) {
  const now = Date.now();
  data.generatedAt = new Date(now).toISOString();
  for (const agent of data.agents || []) {
    if (agent.status !== 'working' && agent.status !== 'stale') continue;
    const reported = now - (agent.status === 'working' ? 5 : 240) * 60_000;
    agent.updatedAt = new Date(reported).toISOString();
    agent.expiresAt = new Date(reported + 90 * 60_000).toISOString();
  }
  if (data.tasks) data.tasks.updatedAt = data.generatedAt;
  return data;
}

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined && content !== null) element.textContent = String(content);
  return element;
}

function timeLabel(value) {
  if (!value) return 'Time not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time not recorded';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function renderAgent(profile, report) {
  const status = ['working', 'stale', 'unavailable'].includes(report?.status) ? report.status : 'unknown';
  const card = node('article', `agent-card tone-${profile.tone} status-${status}`);
  card.setAttribute('aria-label', `${profile.name}, ${profile.role}`);

  const illustration = node('div', 'desk-illustration');
  illustration.setAttribute('aria-hidden', 'true');
  illustration.append(node('span', 'desk-chair'), node('span', 'desk-body'), node('span', `desk-object object-${profile.object}`));
  const identity = node('div', 'agent-identity');
  const names = node('div', 'agent-names');
  names.append(node('h3', '', profile.name), node('p', '', profile.role));
  identity.append(names, node('span', 'desk-light'));

  const statusText = status === 'working' ? 'Working · reported' : status === 'stale' ? 'Last reported' : status === 'unavailable' ? 'Report unavailable' : 'No activity reported';
  const state = node('span', 'agent-state', statusText);
  const description = node('p', 'agent-task', status === 'unknown' ? 'This desk has no current report.' : status === 'unavailable' ? 'The latest report could not be read.' : report.summary || 'No task summary supplied.');
  card.append(illustration, identity, state, description);

  if (status === 'working' || status === 'stale') {
    const detail = node('div', 'agent-detail');
    detail.append(node('span', '', `Updated ${timeLabel(report.updatedAt)}`));
    if (Number.isSafeInteger(report.issueNumber)) detail.append(node('span', '', `Sample issue #${report.issueNumber}`));
    card.append(detail);
  }
  return card;
}

function renderAgents(agents = []) {
  const byName = new Map(Array.isArray(agents) ? agents.map((agent) => [agent.name, agent]) : []);
  grid.replaceChildren(...roster.map((profile) => renderAgent(profile, byName.get(profile.name))));
  const active = roster.filter((profile) => byName.get(profile.name)?.status === 'working').length;
  document.querySelector('#active-count').textContent = String(active);
  document.querySelector('#active-caption').textContent = active === 1 ? 'agent has a fresh work report' : 'agents have fresh work reports';
}

function renderTasks(tasks) {
  const count = document.querySelector('#task-count');
  const sync = document.querySelector('#task-sync');
  if (!tasks || tasks.status !== 'ok') {
    count.textContent = 'Unavailable';
    sync.textContent = 'Sample data unavailable';
    const message = node('div', 'board-empty');
    message.append(node('strong', '', 'The task board could not refresh.'), node('p', '', 'Reload the demo data, then use Refresh to try again.'));
    taskList.replaceChildren(message);
    return;
  }

  const items = Array.isArray(tasks.items) ? tasks.items : [];
  count.textContent = `${items.length} open`;
  sync.textContent = `Sample data · ${timeLabel(tasks.updatedAt)}`;
  if (items.length === 0) {
    const empty = node('div', 'board-empty');
    empty.append(node('strong', '', 'The board is clear.'), node('p', '', 'There are no open issues. The next request can start with Maya.'));
    taskList.replaceChildren(empty);
    return;
  }

  const rows = items.map((item) => {
    const row = node('div', 'task-row');
    const text = node('span', 'task-title', item.title || `Issue #${item.number}`);
    row.append(node('span', 'task-number', `#${item.number}`), text);
    return row;
  });
  taskList.replaceChildren(...rows);
}

async function refresh() {
  refreshButton.disabled = true;
  fetchMessage.hidden = true;
  try {
    const response = await fetch('/demo-data.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = stampSampleTimes(await response.json());
    latestData = data;
    lastSuccessfulUpdate = data.generatedAt || new Date().toISOString();
    renderAgents(data.agents);
    renderTasks(data.tasks);
    document.querySelector('#last-updated').textContent = `Checked ${timeLabel(lastSuccessfulUpdate)}`;
    const working = Array.isArray(data.agents) ? data.agents.filter(agent => agent.status === 'working').map(agent => agent.name) : [];
    const issueCount = data.tasks?.status === 'ok' ? data.tasks.items.length : null;
    const announcement = `${working.length} agents reporting work${working.length ? `: ${working.join(', ')}` : ''}. ${issueCount === null ? 'Issue queue unavailable.' : `${issueCount} open issues.`}`;
    if (lastAnnouncement !== announcement) document.querySelector('#change-message').textContent = announcement;
    lastAnnouncement = announcement;
  } catch {
    fetchMessage.hidden = false;
    fetchMessage.textContent = lastSuccessfulUpdate
      ? `Updates are unavailable. Showing the last view from ${timeLabel(lastSuccessfulUpdate)}.`
      : 'Demo data is unavailable. Reload the page to try again.';
    if (!latestData) {
      renderAgents();
      renderTasks(null);
      document.querySelector('#last-updated').textContent = 'Not connected';
    }
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener('click', refresh);
renderAgents();
refresh();
setInterval(refresh, 30_000);
