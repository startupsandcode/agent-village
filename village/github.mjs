import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO = 'startupsandcode/astra-lab';

async function defaultRun(args) {
  const { stdout } = await execFileAsync('gh', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  return { status: 0, stdout };
}

export class VillageGh {
  constructor({ run = defaultRun } = {}) {
    this.run = run;
    this.repo = REPO;
  }

  async _json(args) {
    let result;
    try { result = await this.run(args); } catch { throw new Error('GitHub operation failed'); }
    if (result?.status !== 0) throw new Error('GitHub operation failed');
    try { return JSON.parse(result.stdout); } catch { throw new Error('GitHub returned invalid JSON'); }
  }

  async getIssue(number) {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('invalid issue number');
    const issue = await this._json(['issue', 'view', String(number), '--repo', REPO,
      '--json', 'number,body,comments,url']);
    if (issue?.number !== number) throw new Error('GitHub issue number mismatch');
    if (typeof issue.body !== 'string' || !Array.isArray(issue.comments) ||
        issue.comments.some(comment => typeof comment?.body !== 'string')) {
      throw new Error('GitHub issue data malformed');
    }
    if (issue.url && issue.url !== `https://github.com/${REPO}/issues/${number}`) {
      throw new Error('GitHub issue URL mismatch');
    }
    return issue;
  }
}
