#!/usr/bin/env node
// Synthetic worker rehearsal. All GitHub, Codex, and worktree operations are in memory.
import { pathToFileURL } from 'node:url';
import { Worker } from './worker.mjs';

export async function rehearse(dispatch) {
  const priorHost = process.env.EMMA_HOST_ID;
  try {
    process.env.EMMA_HOST_ID = 'synthetic-host';
    return await runRehearsal(dispatch);
  } finally {
    if (priorHost === undefined) delete process.env.EMMA_HOST_ID;
    else process.env.EMMA_HOST_ID = priorHost;
  }
}

async function runRehearsal(dispatch) {
  let nextComment = 1;
  const comment = body => ({ body, author: { login: 'startupsandcode' },
    url: `https://github.com/startupsandcode/astra-lab/issues/${dispatch.parent_issue}#issuecomment-${nextComment++}` });
  const dispatchBody = `<!-- dispatch-ready:${dispatch.request_id} -->\n\`\`\`json\n${JSON.stringify(dispatch)}\n\`\`\``;
  const comments = [comment(dispatchBody)];
  const issue = dispatch.first_actionable_issue;
  const sha = 'abcdef123456'.padEnd(40, '0');
  const answerId = 'q-rehearsal';
  const reply = (stage, status, extra = {}) => ({ request_id: dispatch.request_id,
    stage, status, issue, pr: null, question_id: null, question: null,
    category: 'routine', evidence: [], reviewed_sha: null, ...extra });
  const replies = [
    reply('maya', 'needs_emma', { question_id: answerId,
      question: 'Which approved buyer copy?', category: 'routine' }),
    reply('maya', 'done'),
    reply('sam', 'ready_for_review', { pr: 44 }),
    reply('quinn', 'blocked', { pr: 44, evidence: ['Synthetic edge case failed'] }),
    reply('sam', 'ready_for_review', { pr: 44 }),
    reply('quinn', 'done', { pr: 44, reviewed_sha: sha,
      evidence: ['Synthetic review passed'] }),
  ];
  const gh = {
    getIssue: async number => number === dispatch.parent_issue ? { number,
      body: `<!-- emma-ticket:${dispatch.request_id}:parent -->\nSynthetic approved parent` } : { number,
      title: `Build smallest release for #${dispatch.parent_issue}`,
      body: `<!-- emma-ticket:${dispatch.request_id}:build -->\n` +
        `Parent #${dispatch.parent_issue}; opportunity #${dispatch.request_id.split(':')[1]}.\n\nSynthetic implementation` },
    listComments: async () => [...comments],
    comment: async (_number, body) => { comments.push(comment(body)); },
    getPr: async number => number === 44 ?
      { number, isDraft: true, headRefOid: sha, issue } : null,
  };
  const codex = { runRole: async () => replies.shift() };
  const workspaces = { ensure: async () => '/synthetic/astra', dirty: async () => false,
    head: async () => sha };
  const worker = new Worker({ gh, codex, workspaces });
  const statuses = [];
  statuses.push((await worker.advance(dispatch)).status);
  statuses.push((await worker.advance(dispatch)).status); // no duplicate while awaiting Emma
  comments.push(comment(`<!-- emma-answer:${answerId} -->\n${JSON.stringify({
    request_id: dispatch.request_id, issue, category: 'routine', brief_basis: 'Small team',
    question_id: answerId, status: 'answered', answer: 'Approved buyer copy' })}`));
  for (let i = 0; i < 5; i += 1) statuses.push((await worker.advance(dispatch)).status);
  const review = comments.find(item => item.body.includes('village-stage-result:') &&
    item.body.includes('"stage":"quinn"') && item.body.includes('"status":"done"'));
  const reviewed = review ? JSON.parse(review.body.split('\n', 2)[1]) : null;
  const interruptedComments = [comment(dispatchBody)];
  const interrupted = new Worker({ gh: {
    ...gh, listComments: async () => [...interruptedComments],
    comment: async (_number, body) => interruptedComments.push(comment(body)) },
    codex: { runRole: async () => { throw new Error('interrupted'); } }, workspaces });
  const interruption = await interrupted.advance(dispatch);
  return { statuses, reviewed_sha: reviewed?.reviewed_sha ?? null,
    duplicate_question_count: comments.filter(item => item.body.startsWith('<!-- village-question:')).length,
    interrupted_state: interruption.status,
    comments: comments.map(item => ({ body: item.body, author: { ...item.author }, url: item.url })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let source = '';
  for await (const chunk of process.stdin) source += chunk;
  try {
    const result = await rehearse(JSON.parse(source));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
