import { createHash } from 'node:crypto';
import { realpath, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';

const MAX_SESSION_LOG_BYTES = 4 * 1024 * 1024;

function requireValue(value, message) {
  if (!value) throw new Error(message);
}

function inside(root, target) {
  const path = relative(root, target);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function messagesFor(record) {
  return record?.type === 'response_item' && record.payload?.type === 'message' ?
    { role: record.payload.role, content: JSON.stringify(record.payload.content ?? []) } : null;
}

export async function verifyCodexSchemaRejection({ sessionPath, mission, workspacePath,
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex') } = {}) {
  requireValue(typeof sessionPath === 'string' && sessionPath.trim() && mission?.id && mission?.artifactId && workspacePath,
    'mission, workspace, and Codex session evidence are required');
  const sessionsRoot = await realpath(join(codexHome, 'sessions'));
  const evidencePath = await realpath(resolve(sessionPath));
  requireValue(inside(sessionsRoot, evidencePath) && evidencePath.toLowerCase().endsWith('.jsonl'),
    'recovery evidence must be a Codex session log in the local sessions directory');
  const info = await stat(evidencePath);
  requireValue(info.isFile() && info.size > 0 && info.size <= MAX_SESSION_LOG_BYTES,
    'Codex session log is not a bounded regular file');
  const source = await readFile(evidencePath, 'utf8');
  let records;
  try { records = source.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch { throw new Error('Codex session log is not valid JSONL'); }
  const metadata = records.find(record => record.type === 'session_meta')?.payload;
  requireValue(metadata && /^[0-9a-f-]{36}$/i.test(metadata.session_id ?? '') &&
    evidencePath.endsWith(`${metadata.session_id}.jsonl`), 'Codex session identity does not match its log filename');
  const actualWorkspace = await realpath(workspacePath);
  requireValue(await realpath(metadata.cwd) === actualWorkspace,
    'Codex session was not launched from the approved mission workspace');
  const messages = records.map(messagesFor).filter(Boolean);
  const expectedPrompt = messages.some(message => message.role === 'user' &&
    message.content.includes(`You are Susie, the product designer`) && message.content.includes(mission.id) &&
    message.content.includes(mission.artifactId));
  requireValue(expectedPrompt, 'Codex session does not contain the failed Susie prompt for this exact mission');
  requireValue(!messages.some(message => message.role === 'assistant'),
    'Codex session contains assistant output; execution is not proven to have stopped before role execution');
  requireValue(!records.some(record => record.type === 'response_item' && record.payload?.type !== 'message' &&
    !(record.payload?.type === 'additional_tools' && record.payload?.role === 'developer')),
    'Codex session contains a tool or non-message response; execution is not proven to be side-effect free');
  const completion = records.findLast(record => record.type === 'event_msg' && record.payload?.type === 'task_complete')?.payload;
  let providerError;
  try { providerError = JSON.parse(completion?.error?.message ?? ''); }
  catch { throw new Error('Codex session does not contain a parseable provider rejection'); }
  requireValue(providerError.status === 400 && providerError.error?.code === 'invalid_json_schema' &&
    providerError.error?.param === 'text.format.schema' &&
    /schema\.required.*include every key.*Missing 'artifactPath'/i.test(providerError.error?.message ?? ''),
  'Codex session does not prove the known pre-execution artifactPath schema rejection');
  return { sessionId: metadata.session_id,
    evidenceSha256: createHash('sha256').update(source).digest('hex'),
    errorCode: 'invalid_json_schema', missingField: 'artifactPath', stage: 'susie_design' };
}
