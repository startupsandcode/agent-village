const statuses = new Set(['progress', 'needs_emma', 'needs_john', 'ready_for_review', 'blocked', 'done']);
const categories = new Set(['routine', 'scope', 'spend', 'outreach', 'data', 'access', 'release_blocker']);
const stages = new Set(['maya', 'sam', 'quinn']);
const requestPattern = /^emma:[1-9]\d*:[0-9a-f]{12}$/;
export const REPO = 'startupsandcode/astra-lab';
const resultKeys = ['request_id', 'stage', 'status', 'issue', 'pr', 'question_id',
  'question', 'category', 'evidence', 'reviewed_sha'];

export function exactKeys(data, keys, label) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) {
    throw new Error(`invalid ${label} schema`);
  }
}

export function trustedComment(comment, issue) {
  if (comment?.author?.login !== 'startupsandcode') throw new Error('untrusted record author');
  if (typeof comment.url !== 'string' ||
      !new RegExp(`^https://github\\.com/${REPO}/issues/${issue}#issuecomment-[1-9]\\d*$`).test(comment.url)) {
    throw new Error('record provenance mismatch');
  }
}

function timestamp(value) {
  const parts = typeof value === 'string' && value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, zone] = parts;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day) && Number(hour) < 24 && Number(minute) < 60 &&
    Number(second) < 60 && (zone === 'Z' || Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4)) < 60);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function parseDispatch(issue) {
  if (!positiveInteger(issue?.number) || !Array.isArray(issue?.comments)) {
    throw new Error('dispatch issue and comments required');
  }
  const marked = issue.comments.filter(comment =>
    typeof comment?.body === 'string' && comment.body.includes('<!-- dispatch-ready:'));
  if (marked.length === 0) throw new Error('approved dispatch marker required');
  if (marked.length !== 1) throw new Error('duplicate dispatch markers');
  trustedComment(marked[0], issue.number);
  const body = marked[0].body;
  const match = body.match(/^<!-- dispatch-ready:(emma:[1-9]\d*:[0-9a-f]{12}) -->\n```json\n([^\n]+)\n```\s*$/);
  if (!match) throw new Error('invalid dispatch format or request_id');
  let data;
  try { data = JSON.parse(match[2]); } catch { throw new Error('invalid dispatch JSON'); }
  return validateDispatch(data, { request: match[1], parent: issue.number });
}

export function validateDispatch(data, { request = data?.request_id, parent = data?.parent_issue } = {}) {
  exactKeys(data, ['request_id', 'repo', 'parent_issue', 'first_actionable_issue',
    'brief_id', 'brief_digest', 'candidate_id', 'approved_at'], 'dispatch');
  if (data.repo !== REPO) throw new Error('invalid dispatch repo');
  if (data.request_id !== request || !requestPattern.test(data.request_id)) throw new Error('invalid request_id');
  if (!positiveInteger(data.parent_issue) || data.parent_issue !== parent) throw new Error('parent_issue mismatch');
  if (!positiveInteger(data.first_actionable_issue) || data.first_actionable_issue === data.parent_issue) {
    throw new Error('first_actionable_issue required');
  }
  if (typeof data.brief_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(data.brief_id)) {
    throw new Error('brief_id invalid');
  }
  if (typeof data.brief_digest !== 'string' || !/^[0-9a-f]{64}$/.test(data.brief_digest) ||
      !data.request_id.endsWith(data.brief_digest.slice(0, 12))) throw new Error('brief_digest mismatch');
  if (typeof data.candidate_id !== 'string' || !data.candidate_id.trim()) throw new Error('candidate_id required');
  if (!timestamp(data.approved_at)) {
    throw new Error('approved_at required');
  }
  return { ...data };
}

export function validateResult(data) {
  exactKeys(data, resultKeys, 'role result');
  if (!requestPattern.test(data.request_id)) throw new Error('invalid request_id');
  if (!stages.has(data.stage)) throw new Error('invalid role stage');
  if (!statuses.has(data.status)) throw new Error('invalid role status');
  if (data.stage === 'maya' && data.status === 'ready_for_review' ||
      data.stage === 'sam' && data.status === 'done' ||
      data.stage === 'quinn' && data.status === 'ready_for_review') {
    throw new Error('invalid role status transition');
  }
  if (!positiveInteger(data.issue)) throw new Error('invalid issue');
  if (data.pr !== null && !positiveInteger(data.pr)) throw new Error('invalid pr');
  if (!categories.has(data.category)) throw new Error('invalid category');
  if (!Array.isArray(data.evidence) || data.evidence.some(value => typeof value !== 'string')) {
    throw new Error('invalid evidence');
  }
  if (['needs_emma', 'needs_john'].includes(data.status)) {
    if (typeof data.question_id !== 'string' || !/^[A-Za-z0-9_-]{2,80}$/.test(data.question_id)) {
      throw new Error('question_id required');
    }
    if (typeof data.question !== 'string' || !data.question.trim()) throw new Error('question required');
  } else if (data.question_id !== null || data.question !== null) {
    throw new Error('question only allowed when awaiting an answer');
  }
  if (data.category !== 'routine' && !['needs_john', 'blocked'].includes(data.status)) {
    throw new Error('non-routine category requires needs_john or blocked');
  }
  if (data.stage === 'quinn' && data.status === 'done') {
    if (!positiveInteger(data.pr) || typeof data.reviewed_sha !== 'string' || !/^[0-9a-f]{40}$/.test(data.reviewed_sha)) {
      throw new Error('reviewed_sha required for Quinn approval');
    }
  } else if (data.reviewed_sha !== null) {
    throw new Error('reviewed_sha only allowed for Quinn approval');
  }
  if (data.stage === 'sam' && data.status === 'ready_for_review' && !positiveInteger(data.pr)) {
    throw new Error('PR required for Sam review handoff');
  }
  return { ...data, evidence: [...data.evidence] };
}
