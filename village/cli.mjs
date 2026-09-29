#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseDispatch } from './contract.mjs';
import { VillageGh } from './github.mjs';
import { CodexRunner } from './codex-runner.mjs';
import { GitWorkspaces, Worker } from './worker.mjs';

export async function main(argv = process.argv.slice(2), gh = new VillageGh(), worker = null) {
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
  const activeWorker = worker ?? new Worker({ gh, codex: new CodexRunner(),
    workspaces: new GitWorkspaces({ root: process.env.ASTRA_LAB_ROOT }) });
  return await activeWorker.advance(dispatch);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
