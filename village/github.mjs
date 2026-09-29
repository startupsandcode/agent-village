import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  async listComments(number) {
    return (await this.getIssue(number)).comments;
  }

  async getPr(number) {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('invalid PR number');
    let pr;
    try {
      pr = await this._json(['pr', 'view', String(number), '--repo', REPO,
        '--json', 'number,isDraft,headRefOid,body,url']);
    } catch (error) {
      if (error.message === 'GitHub operation failed') return null;
      throw error;
    }
    if (pr?.number !== number || typeof pr.isDraft !== 'boolean' ||
        typeof pr.headRefOid !== 'string' || !/^[0-9a-f]{3,40}$/.test(pr.headRefOid)) {
      throw new Error('GitHub PR data malformed');
    }
    const linked = typeof pr.body === 'string' ? pr.body.match(/(?:Closes|Fixes)\s+#([1-9]\d*)/i) : null;
    return { ...pr, issue: linked ? Number(linked[1]) : null };
  }

  async comment(number, body) {
    if (!Number.isSafeInteger(number) || number <= 0 || typeof body !== 'string') {
      throw new Error('invalid issue comment');
    }
    const directory = await mkdtemp(join(tmpdir(), 'village-comment-'));
    try {
      const path = join(directory, 'body.md');
      await writeFile(path, body, { mode: 0o600 });
      let result;
      try { result = await this.run(['issue', 'comment', String(number), '--repo', REPO,
        '--body-file', path]); } catch { throw new Error('GitHub comment failed'); }
      const prefix = `https://github.com/${REPO}/issues/${number}#issuecomment-`;
      if (result?.status !== 0 || !result.stdout?.trim().startsWith(prefix) ||
          !/^\d+$/.test(result.stdout.trim().slice(prefix.length))) {
        throw new Error('GitHub comment identity invalid');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
