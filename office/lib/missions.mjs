import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MissionStore } from '../../village/mission-runner.mjs';
import { MissionNotificationFeed } from '../../village/mission-background.mjs';

const terminal = new Set(['accepted_preview', 'blocked', 'cancelled', 'failed']);

function quinnReviewReason(state) {
  const event = state.events?.at(-1);
  if (state.status !== 'blocked' || event?.stage !== 'quinn_functional' || event.status !== 'failed' ||
      typeof event.error !== 'string' || !/^Quinn review did not approve \(status=(?:blocked|needs_revision)\)/.test(event.error)) {
    return null;
  }
  return event.error.slice(0, 500)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|pk|ghp|gho|github_pat|vercel)_[A-Za-z0-9_-]{8,}\b/gi, '[token]')
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/https?:\/\/[^\s,;]+/gi, '[url]')
    .replace(/\b[A-Za-z]:\\[^\s,;]+/g, '[path]')
    .replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function createMissionLoader({ root = process.env.VILLAGE_MISSION_ROOT ||
  join(resolve(process.env.VILLAGE_MISSION_HOME || join(homedir(), '.agent-village')), 'missions'),
  notificationsRoot = process.env.VILLAGE_MISSION_NOTIFICATIONS_ROOT || join(resolve(root), '.notifications'),
  store = new MissionStore(root), now = Date.now } = {}) {
  return async function getMissions() {
    const states = await store.list();
    const workerErrors = (await new MissionNotificationFeed(notificationsRoot).list())
      .filter(event => event.kind === 'worker_error');
    return {
      status: 'ok',
      updatedAt: new Date(now()).toISOString(),
      items: states.map(state => {
        const attentionReason = quinnReviewReason(state);
        const visual = state.status === 'accepted_preview' &&
          state.events.findLast(event => event.stage === 'susie_visual' && event.status === 'done');
        return {
          id: state.id,
          goal: state.goal,
          status: state.status,
          currentStage: state.currentStage,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          terminal: terminal.has(state.status),
          needsAttention: ['blocked', 'failed'].includes(state.status) || workerErrors.some(event =>
            event.missionId === state.id && Date.parse(event.createdAt) > Date.parse(state.updatedAt)),
          ...(attentionReason ? { attentionReason } : {}),
          ...(visual?.rendered?.previewUrl ? { previewUrl: visual.rendered.previewUrl } : {}),
        };
      }),
    };
  };
}
