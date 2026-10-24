import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MissionStore } from '../../village/mission-runner.mjs';

const terminal = new Set(['accepted_preview', 'blocked', 'cancelled', 'failed']);

export function createMissionLoader({ root = process.env.VILLAGE_MISSION_ROOT ||
  join(resolve(process.env.VILLAGE_MISSION_HOME || join(homedir(), '.agent-village')), 'missions'),
  store = new MissionStore(root), now = Date.now } = {}) {
  return async function getMissions() {
    const states = await store.list();
    return {
      status: 'ok',
      updatedAt: new Date(now()).toISOString(),
      items: states.map(state => {
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
          ...(visual?.rendered?.previewUrl ? { previewUrl: visual.rendered.previewUrl } : {}),
        };
      }),
    };
  };
}
