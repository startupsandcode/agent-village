import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const EXPIRY_MS = 90 * 60 * 1000;
export const ROSTER = Object.freeze([
  { name: 'Emma', role: 'Engineering lead' },
  { name: 'Sam', role: 'Implementation' },
  { name: 'Quinn', role: 'Independent review' },
  { name: 'Theo', role: 'Architecture' },
  { name: 'Susie', role: 'Product design' },
]);

function agentName(value) {
  const agent = ROSTER.find(item => item.name.toLowerCase() === String(value).toLowerCase());
  if (!agent) throw new Error('Agent must be Emma, Sam, Quinn, Theo, or Susie.');
  return agent.name;
}

function issueNumber(value) {
  if (value === undefined || value === null) return null;
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error('Issue number must be a positive integer.');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Issue number must be a safe integer.');
  return number;
}

function summaryText(value) {
  if (typeof value !== 'string') throw new Error('Summary is required.');
  const summary = value.trim();
  if (!summary || summary.length > 240 || /[<>\x00-\x1f\x7f]/.test(summary)) {
    throw new Error('Summary must be 1–240 plain-text characters on one line.');
  }
  return summary;
}

function validateStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid check-in file.');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const name = agentName(key);
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid check-in file.');
    const updatedAt = Date.parse(item.updatedAt);
    const expiresAt = Date.parse(item.expiresAt);
    if (!Number.isFinite(updatedAt) || !Number.isFinite(expiresAt) || expiresAt !== updatedAt + EXPIRY_MS) {
      throw new Error('Invalid check-in file.');
    }
    result[name] = { summary: summaryText(item.summary), issueNumber: issueNumber(item.issueNumber), updatedAt: new Date(updatedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
  }
  return result;
}

function reportPath(dir, name) {
  return join(dir, `${name.toLowerCase()}.json`);
}

export async function loadCheckins(dir) {
  const reports = {};
  await Promise.all(ROSTER.map(async ({ name }) => {
    try {
      reports[name] = validateStore({ [name]: JSON.parse(await readFile(reportPath(dir, name), 'utf8')) })[name];
    } catch (error) {
      if (error.code !== 'ENOENT') reports[name] = { error: true };
    }
  }));
  return reports;
}

async function saveCheckin(dir, name, value) {
  await mkdir(dir, { recursive: true });
  const file = reportPath(dir, name);
  const temporary = join(dir, `.${name.toLowerCase()}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function createCheckin(dir, agent, summary, issue, now = Date.now()) {
  const name = agentName(agent);
  const cleanSummary = summaryText(summary);
  const cleanIssue = issueNumber(issue);
  if (!Number.isFinite(now)) throw new Error('Invalid check-in time.');
  const report = {
    summary: cleanSummary,
    issueNumber: cleanIssue,
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + EXPIRY_MS).toISOString(),
  };
  await saveCheckin(dir, name, report);
  return report;
}

export async function finishCheckin(dir, agent) {
  const name = agentName(agent);
  await rm(reportPath(dir, name), { force: true });
}

export function readAgents(reports, now = Date.now()) {
  return ROSTER.map(({ name, role }) => {
    const item = reports[name];
    if (!item) return { name, role, status: 'unknown', summary: null, issueNumber: null, updatedAt: null, expiresAt: null };
    if (item.error) return { name, role, status: 'unavailable', summary: null, issueNumber: null, updatedAt: null, expiresAt: null };
    return { name, role, status: Date.parse(item.expiresAt) > now ? 'working' : 'stale', ...item };
  });
}
