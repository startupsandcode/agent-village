#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCheckin, finishCheckin } from './lib/checkins.mjs';

const dir = resolve(fileURLToPath(new URL('.', import.meta.url)), '.local', 'checkins');
const [command, agent, summary, issue, ...extra] = process.argv.slice(2);

try {
  if (command === 'start' && agent && summary && !extra.length) {
    const report = await createCheckin(dir, agent, summary, issue);
    console.log(`${agent} checked in until ${report.expiresAt}`);
  } else if (command === 'finish' && agent && summary === undefined) {
    await finishCheckin(dir, agent);
    console.log(`${agent} checked out`);
  } else {
    throw new Error('Usage: node office/checkin.mjs start <agent> <summary> [issue-number] | finish <agent>');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
