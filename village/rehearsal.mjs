#!/usr/bin/env node
// Synthetic worker rehearsal. All GitHub, Codex, and worktree operations are in memory.
import { pathToFileURL } from 'node:url';
import { Worker } from './worker.mjs';

export async function rehearse(dispatch) {
  const comments = [];
  const issue = dispatch.first_actionable_issue;
  const answerId = 'q-rehearsal';
  const reply = (stage, status, extra = {}) => ({ request_id: dispatch.request_id,
    stage, status, issue, pr: null, question_id: null, question: null,
    category: 'routine', evidence: [], ...extra });
  const replies = [
    reply('maya', 'needs_emma', { question_id: answerId,
      question: 'Which approved buyer copy?', category: 'routine' }),
    reply('maya', 'done'),
    reply('sam', 'ready_for_review', { pr: 44 }),
    reply('quinn', 'blocked', { pr: 44, evidence: ['Synthetic edge case failed'] }),
    reply('sam', 'ready_for_review', { pr: 44 }),
    reply('quinn', 'done', { pr: 44, reviewed_sha: 'abcdef123456',
      evidence: ['Synthetic review passed'] }),
  ];
  const gh = {
    getIssue: async number => ({ number, body: 'Synthetic approved implementation issue' }),
    listComments: async () => [...comments],
    comment: async (_number, body) => { comments.push({ body }); },
    getPr: async number => number === 44 ?
      { number, isDraft: true, headRefOid: 'abcdef123456', issue } : null,
  };
  const codex = { runRole: async () => replies.shift() };
  const workspaces = { ensure: async () => '/synthetic/astra', dirty: async () => false,
    head: async () => 'abcdef123456' };
  const worker = new Worker({ gh, codex, workspaces });
  const statuses = [];
  statuses.push((await worker.advance(dispatch)).status);
  statuses.push((await worker.advance(dispatch)).status); // no duplicate while awaiting Emma
  comments.push({ body: `<!-- emma-answer:${answerId} -->\n${JSON.stringify({
    question_id: answerId, status: 'answered', answer: 'Approved buyer copy' })}` });
  for (let i = 0; i < 5; i += 1) statuses.push((await worker.advance(dispatch)).status);
  const review = comments.find(item => item.body.includes('village-stage-result:') &&
    item.body.includes('"stage":"quinn"') && item.body.includes('"status":"done"'));
  const reviewed = review ? JSON.parse(review.body.split('\n', 2)[1]) : null;
  const interrupted = new Worker({ gh: {
    ...gh, listComments: async () => [], comment: async () => {} },
    codex: { runRole: async () => { throw new Error('interrupted'); } }, workspaces });
  const interruption = await interrupted.advance(dispatch);
  return { statuses, reviewed_sha: reviewed?.reviewed_sha ?? null,
    duplicate_question_count: comments.filter(item => item.body.startsWith('<!-- village-question:')).length,
    interrupted_state: interruption.status };
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
