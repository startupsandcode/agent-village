export const roster = [
  { name: 'Maya', role: 'Engineering lead', object: 'lamp', tone: 'coral' },
  { name: 'Sam', role: 'Implementation', object: 'code', tone: 'teal' },
  { name: 'Quinn', role: 'Independent review', object: 'paper', tone: 'gold' },
  { name: 'Theo', role: 'Architecture', object: 'plan', tone: 'blue' },
  { name: 'Susie', role: 'Product design', object: 'swatch', tone: 'pink' },
];

export function officeData(project) {
  const stages = [
    ['Maya', 'Clarify the goal', 'question'],
    ['Maya', 'Agree on a plan', 'plan'],
    ['Sam', 'Build the website', 'result'],
    ['Quinn', 'Review the exact files', 'review'],
  ];
  const events = project?.events ?? [];
  const active = { clarifying: 'Maya', planning: 'Maya', building: 'Sam', reviewing: 'Quinn' }[project?.status];
  const agents = roster.map(profile => {
    const own = events.filter(event => event.agent === profile.name);
    const last = own.at(-1);
    return { ...profile, status: active === profile.name ? 'working' : own.length ? 'reported' : 'idle',
      summary: last?.message ?? 'No work assigned in this project.', updatedAt: last?.at ?? null };
  });
  const tasks = stages.map(([owner, title, receipt], index) => {
    const matching = events.find(event => event.agent === owner && event.type === receipt &&
      (receipt !== 'review' || project?.status === 'reviewed' && project?.artifact?.sha256 === event.reviewedSha256));
    const started = ['clarifying', 'planning', 'building', 'reviewing'][index] === project?.status;
    return { owner, title, status: matching ? 'done' : started ? 'working' : 'waiting',
      receipt: matching?.message ?? null, at: matching?.at ?? null };
  });
  if (project?.status === 'changes_requested') tasks[3].status = 'changes requested';
  if (project?.status === 'cancelled' || project?.status === 'interrupted' || project?.status === 'blocked') {
    const lastStart = [...events].reverse().find(event => event.type === 'start');
    const index = lastStart?.agent === 'Quinn' ? 3 : lastStart?.agent === 'Sam' ? 2 : events.some(event => event.type === 'answer') ? 1 : 0;
    if (tasks[index].status !== 'done') tasks[index].status = project.status;
  }
  return { agents, tasks, activeCount: agents.filter(agent => agent.status === 'working').length };
}
