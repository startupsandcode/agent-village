import { createHash } from 'node:crypto';
import { capturePreparedProject, createDeliverySnapshot } from './delivery.mjs';

const inflight = new Set();
const shaPattern = /^[0-9a-f]{40}$/i;

function requiredName(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('..')) throw new Error(`Invalid ${label}`);
  return value;
}

function checkedSha(value, label) {
  if (typeof value !== 'string' || !shaPattern.test(value)) throw new Error(`Invalid GitHub ${label}`);
  return value;
}

function gitBlobSha(content) {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

async function github(fetchImpl, token, signal, path, method = 'GET', body) {
  if (signal.aborted) throw new Error('Publishing cancelled or timed out');
  let response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    if (signal.aborted) throw new Error('Publishing cancelled or timed out; check the branch before retrying');
    throw new Error('GitHub request failed; check the target and retry');
  }
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}); check repository access, branch, or conflict`);
  try { return await response.json(); }
  catch { throw new Error('GitHub returned an invalid response'); }
}

/**
 * Publish a reviewed, receipt-checked local site to an existing private GitHub
 * repository and existing non-default branch. Call only after an explicit user
 * action. The caller must keep token server-side and never put it in a response.
 * A fine-grained token needs Contents: write on this one repository.
 */
export async function publishReviewedSite({ engine, id, snapshot, owner, repo, branch, token, fetchImpl = fetch, signal, onBeforeRefUpdate = async () => {} }) {
  if (snapshot === undefined) {
    if (!engine || typeof engine.checkedWorkspace !== 'function' || typeof engine.get !== 'function') throw new Error('Invalid project engine');
    requiredName(id, /^[0-9a-f-]{36}$/i, 'project ID');
  } else if (engine !== undefined || id !== undefined) {
    throw new Error('Choose one reviewed project source');
  }
  requiredName(owner, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'GitHub owner');
  requiredName(repo, /^[A-Za-z0-9._-]{1,100}$/, 'GitHub repository');
  requiredName(branch, /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'GitHub branch');
  if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) throw new Error('GitHub publishing credential is missing');
  if (typeof fetchImpl !== 'function') throw new Error('Invalid GitHub transport');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid cancellation signal');

  const deadline = AbortSignal.timeout(90_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;

  const target = `${owner.toLowerCase()}/${repo.toLowerCase()}:${branch}`;
  if (inflight.has(target)) throw new Error('Publishing to this branch is already in progress');
  inflight.add(target);
  try {
    if (requestSignal.aborted) throw new Error('Publishing cancelled or timed out');
    const prepared = snapshot === undefined ? await capturePreparedProject(engine, id) : createDeliverySnapshot(snapshot);
    if (requestSignal.aborted) throw new Error('Publishing cancelled or timed out');
    const files = new Map([...prepared.files].map(([name, content]) => {
      if (content.length > 512_000) throw new Error('Prepared file is too large to publish');
      return [name, { content, sha: gitBlobSha(content) }];
    }));
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const repository = await github(fetchImpl, token, requestSignal, base);
    if (repository.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
        repository.owner?.login?.toLowerCase() !== owner.toLowerCase() ||
        repository.private !== true || repository.archived || repository.disabled || repository.has_pages !== false ||
        repository.permissions?.push !== true) {
      throw new Error('GitHub target must be the requested writable private repository');
    }
    if (repository.default_branch === branch) throw new Error('Publishing requires a non-default branch');

    const branchInfo = await github(fetchImpl, token, requestSignal, `${base}/branches/${encodeURIComponent(branch)}`);
    if (branchInfo.name !== branch || branchInfo.protected === true) throw new Error('GitHub target branch must exist and be unprotected');
    const parent = checkedSha(branchInfo.commit?.sha, 'branch commit');
    const parentCommit = await github(fetchImpl, token, requestSignal, `${base}/git/commits/${parent}`);
    const baseTree = checkedSha(parentCommit.tree?.sha, 'tree');
    const treeInfo = await github(fetchImpl, token, requestSignal, `${base}/git/trees/${baseTree}`);
    if (treeInfo.truncated || !Array.isArray(treeInfo.tree)) throw new Error('Could not inspect complete GitHub tree');
    if (treeInfo.tree.some(item => item.path === '.github')) throw new Error('GitHub target contains automation configuration; use a dedicated inert repository');
    const existing = treeInfo.tree.filter(item => files.has(item.path));
    if (existing.length) {
      if (existing.length === files.size && existing.every(item => item.type === 'blob' && item.mode === '100644' && item.sha === files.get(item.path).sha)) {
        return { repository: repository.full_name, branch, commitSha: parent, artifactSha256: prepared.sha256,
          url: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(branch)}`, idempotent: true };
      }
      throw new Error('GitHub branch already contains delivery files; choose a clean branch');
    }

    const blobs = [];
    for (const [name, { content, sha }] of files) {
      const created = await github(fetchImpl, token, requestSignal, `${base}/git/blobs`, 'POST', { content: content.toString('base64'), encoding: 'base64' });
      if (checkedSha(created.sha, 'blob') !== sha) throw new Error('GitHub blob receipt did not match reviewed file');
      blobs.push({ path: name, mode: '100644', type: 'blob', sha });
    }
    const createdTree = await github(fetchImpl, token, requestSignal, `${base}/git/trees`, 'POST', { base_tree: baseTree, tree: blobs });
    const treeSha = checkedSha(createdTree.sha, 'created tree');
    const createdCommit = await github(fetchImpl, token, requestSignal, `${base}/git/commits`, 'POST', {
      message: `Publish Agent Village reviewed site ${prepared.sha256}`,
      tree: treeSha,
      parents: [parent],
    });
    const commitSha = checkedSha(createdCommit.sha, 'created commit');
    await onBeforeRefUpdate();
    const updatedRef = await github(fetchImpl, token, requestSignal, `${base}/git/refs/heads/${encodeURIComponent(branch)}`, 'PATCH', { sha: commitSha, force: false });
    if (checkedSha(updatedRef.object?.sha, 'updated ref') !== commitSha ||
        updatedRef.ref !== `refs/heads/${branch}`) throw new Error('GitHub ref receipt did not match published commit; inspect branch before retrying');
    return { repository: repository.full_name, branch, commitSha, artifactSha256: prepared.sha256,
      url: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(branch)}`, idempotent: false };
  } finally {
    inflight.delete(target);
  }
}
