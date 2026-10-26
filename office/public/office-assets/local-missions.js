const missionStatus = document.querySelector('#local-missions-status');
const missionList = document.querySelector('#local-missions-list');
const refreshMissionsButton = document.querySelector('#local-missions-refresh');

function missionNode(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function localMissionStatusLabel(mission) {
  if (mission.needsAttention) return 'Needs attention';
  if (mission.status === 'accepted_preview') return 'Preview accepted';
  if (mission.status === 'cancelled') return 'Cancelled';
  if (mission.status === 'running') return 'Working';
  if (mission.status === 'ready') return 'Ready or queued';
  return 'Status unavailable';
}

function statusDescription(mission) {
  if (mission.needsAttention) return mission.attentionReason || 'The worker reported an error or the mission needs reconciliation. Check CLI status for details.';
  if (mission.status === 'accepted_preview') return 'Design and functional checks passed, and Susie reviewed the rendered preview.';
  if (mission.status === 'cancelled') return 'The mission was cancelled at a safe checkpoint.';
  if (mission.status === 'running') return `Current stage: ${mission.currentStage.replaceAll('_', ' ')}.`;
  if (mission.status === 'ready') return 'Accepted and waiting for a worker or safe resume.';
  return `Mission status: ${mission.status}.`;
}

function renderMission(mission) {
  const item = missionNode('li', 'local-mission-card');
  const heading = missionNode('div', 'local-mission-card-heading');
  heading.append(missionNode('h3', '', mission.goal || `Mission ${mission.id}`));
  heading.append(missionNode('span', `local-mission-badge${mission.needsAttention ? ' is-error' : ''}`, localMissionStatusLabel(mission)));
  item.append(heading);
  item.append(missionNode('p', 'local-mission-description', statusDescription(mission)));
  const timestamp = Date.parse(mission.updatedAt);
  const timeLabel = Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
    : 'Time unavailable';
  const time = missionNode('p', 'local-mission-time', `Updated ${timeLabel}`);
  item.append(time);
  if (mission.status === 'accepted_preview' && typeof mission.previewUrl === 'string') {
    try {
      const preview = new URL(mission.previewUrl);
      if (['http:', 'https:'].includes(preview.protocol) && !preview.username && !preview.password) {
        const link = missionNode('a', 'local-mission-preview', 'Open reviewed preview');
        link.href = preview.href;
        link.rel = 'noopener noreferrer';
        link.target = '_blank';
        item.append(link);
      }
    } catch {}
  }
  return item;
}

async function loadLocalMissions() {
  if (!missionStatus || !missionList) return;
  if (refreshMissionsButton) refreshMissionsButton.disabled = true;
  missionStatus.textContent = 'Checking local mission status.';
  try {
    const response = await fetch('/api/missions', { cache: 'no-store' });
    if (response.status === 404) {
      missionList.replaceChildren();
      missionStatus.textContent = 'Local mission status is available only when this page is served by the desktop Office server.';
      return;
    }
    if (!response.ok) throw new Error('Local mission status is unavailable.');
    const data = await response.json();
    if (data.status !== 'ok' || !Array.isArray(data.items)) throw new Error('Local mission status is unavailable.');
    missionList.replaceChildren(...data.items.map(renderMission));
    missionStatus.textContent = data.items.length
      ? `${data.items.length} local mission${data.items.length === 1 ? '' : 's'} found.`
      : 'No local mission runs yet.';
  } catch {
    missionList.replaceChildren();
    missionStatus.textContent = 'Local mission status could not be loaded. The local worker and Office server must use the same mission store.';
  } finally {
    if (refreshMissionsButton) refreshMissionsButton.disabled = false;
  }
}

refreshMissionsButton?.addEventListener('click', loadLocalMissions);
loadLocalMissions();
