#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDispatch } from './contract.mjs';
import { VillageGh } from './github.mjs';
import { CodexRunner } from './codex-runner.mjs';
import { GitWorkspaces, Worker } from './worker.mjs';

export async function authorizeDispatch(gh, dispatch, { env = process.env,
  astraRoot = process.env.ASTRA_LAB_ROOT,
  day = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/New_York' }) } = {}) {
  if (!astraRoot || !env.EMMA_HOST_ID || !env.EMMA_ATTEMPT_ID) {
    throw new Error('active host and attempt identity required');
  }
  try { await access(join(astraRoot, 'PAUSE')); throw new Error('Astra PAUSE is active'); }
  catch (error) { if (error.message === 'Astra PAUSE is active') throw error; }
  let config;
  try { config = JSON.parse(await readFile(join(astraRoot, 'ops', 'runner-config.json'), 'utf8')); }
  catch { throw new Error('Astra run controls unavailable'); }
  if (config?.enabled !== true) throw new Error('Astra worker is paused');
  const control = await gh.getIssue(5);
  const comments = control.comments;
  const hosts = comments.filter(item => item.body?.startsWith('<!-- emma-active-host:'));
  const host = hosts.at(-1)?.body.match(/^<!-- emma-active-host:([A-Za-z0-9_-]+) -->/);
  if (!host || host[1] !== env.EMMA_HOST_ID) throw new Error('active host mismatch');
  const marker = `<!-- emma-attempt:${day}:${env.EMMA_ATTEMPT_ID} -->\n`;
  const attempts = comments.filter(item => item.body?.startsWith(marker));
  if (attempts.length !== 1) throw new Error('matching shared attempt required');
  let claim;
  try { claim = JSON.parse(attempts[0].body.slice(marker.length)); }
  catch { throw new Error('malformed shared attempt'); }
  if (claim.request_id !== dispatch.request_id || claim.host_id !== env.EMMA_HOST_ID ||
      claim.day !== day || claim.attempt_id !== env.EMMA_ATTEMPT_ID) {
    throw new Error('matching shared attempt required');
  }
}

export async function main(argv = process.argv.slice(2), gh = new VillageGh(), worker = null, controls = {}) {
  const [command, ...rest] = argv;
  if (command !== 'run' && command !== 'resume') throw new Error('run or resume required');
  const options = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || !rest[i + 1]) throw new Error('invalid option');
    options.set(rest[i], rest[i + 1]);
  }
  if (options.get('--repo') !== 'startupsandcode/astra-lab') throw new Error('wrong repository');
  const number = Number(options.get('--issue'));
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('invalid issue');
  const issue = await gh.getIssue(number);
  const dispatch = parseDispatch(issue);
  if (dispatch.request_id !== options.get('--request-id')) throw new Error('request ID mismatch');
  await authorizeDispatch(gh, dispatch, controls);
  const activeWorker = worker ?? new Worker({ gh, codex: new CodexRunner(),
    workspaces: new GitWorkspaces({ root: process.env.ASTRA_LAB_ROOT }),
    authorize: current => authorizeDispatch(gh, current, controls) });
  return await activeWorker.advance(dispatch);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
