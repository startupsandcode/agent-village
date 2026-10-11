import { officeData } from './office-data.mjs';

const grid = document.querySelector('#agent-grid');
const board = document.querySelector('#task-list');
const count = document.querySelector('#active-count');
const caption = document.querySelector('#active-caption');
const sync = document.querySelector('#task-sync');

function node(tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}

function desk(agent) {
  const card = node('article', `agent-card tone-${agent.tone} status-${agent.status === 'reported' ? 'stale' : agent.status}`);
  card.setAttribute('aria-label', `${agent.name}, ${agent.role}`);
  const illustration = node('div', 'desk-illustration');
  illustration.setAttribute('aria-hidden', 'true');
  illustration.append(node('span', 'desk-chair'), node('span', 'desk-body'), node('span', `desk-object object-${agent.object}`));
  const identity = node('div', 'agent-identity');
  const names = node('div', 'agent-names');
  names.append(node('h3', '', agent.name), node('p', '', agent.role));
  identity.append(names, node('span', 'desk-light'));
  card.append(illustration, identity,
    node('span', 'agent-state', agent.status === 'working' ? 'Working now · recorded' : agent.status === 'reported' ? 'Last recorded' : 'No work assigned'),
    node('p', 'agent-task', agent.summary));
  if (agent.updatedAt) card.append(node('div', 'agent-detail', `Updated ${new Date(agent.updatedAt).toLocaleString()}`));
  return card;
}

function render(project) {
  const data = officeData(project);
  grid.replaceChildren(...data.agents.map(desk));
  board.replaceChildren(...data.tasks.map(task => {
    const row = node('div', 'task-row');
    row.append(node('span', 'task-number', task.status), node('span', 'task-title', `${task.owner} · ${task.title}`));
    if (task.receipt) row.append(node('small', 'task-receipt', task.receipt));
    return row;
  }));
  count.textContent = String(data.activeCount);
  caption.textContent = data.activeCount === 1 ? 'agent has a recorded stage in progress' : 'agents have recorded stages in progress';
  sync.textContent = project ? `Project ${project.id.slice(0, 8)} · ${project.status}` : 'Waiting for a project';
}

window.addEventListener('village-project', event => render(event.detail));
render(window.villageProject ?? null);
