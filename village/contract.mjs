const statuses = new Set(['progress', 'needs_emma', 'needs_john', 'ready_for_review', 'blocked', 'done']);
const categories = new Set(['routine', 'scope', 'spend', 'outreach', 'data', 'access', 'release_blocker']);
const stages = new Set(['maya', 'sam', 'quinn']);
const requestPattern = /^emma:[1-9]\d*:[0-9a-f]{12}$/;

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
  const body = marked[0].body;
  const match = body.match(/^<!-- dispatch-ready:(emma:[1-9]\d*:[0-9a-f]{12}) -->\n```json\n([^\n]+)\n```\s*$/);
  if (!match) throw new Error('invalid dispatch format or request_id');
  let data;
  try { data = JSON.parse(match[2]); } catch { throw new Error('invalid dispatch JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid dispatch JSON');
  if (data.repo !== 'startupsandcode/astra-lab') throw new Error('invalid dispatch repo');
  if (data.request_id !== match[1] || !requestPattern.test(data.request_id)) throw new Error('invalid request_id');
  if (!positiveInteger(data.parent_issue) || data.parent_issue !== issue.number) throw new Error('parent_issue mismatch');
  if (!positiveInteger(data.first_actionable_issue)) throw new Error('first_actionable_issue required');
  if (typeof data.brief_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(data.brief_id)) {
    throw new Error('brief_id invalid');
  }
  if (typeof data.brief_digest !== 'string' || !/^[0-9a-f]{64}$/.test(data.brief_digest) ||
      !data.request_id.endsWith(data.brief_digest.slice(0, 12))) throw new Error('brief_digest mismatch');
  if (typeof data.candidate_id !== 'string' || !data.candidate_id.trim()) throw new Error('candidate_id required');
  if (typeof data.approved_at !== 'string' || !Number.isFinite(Date.parse(data.approved_at))) {
    throw new Error('approved_at required');
  }
  return { ...data };
}

export function validateResult(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('role result object required');
  if (!requestPattern.test(data.request_id)) throw new Error('invalid request_id');
  if (!stages.has(data.stage)) throw new Error('invalid role stage');
  if (!statuses.has(data.status)) throw new Error('invalid role status');
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
    if (typeof data.reviewed_sha !== 'string' || !/^[0-9a-f]{3,40}$/.test(data.reviewed_sha)) {
      throw new Error('reviewed_sha required for Quinn approval');
    }
  } else if (data.reviewed_sha != null) {
    throw new Error('reviewed_sha only allowed for Quinn approval');
  }
  return { ...data, evidence: [...data.evidence] };
}
