const DEFAULT_REPO = 'startupsandcode/agent-village';
export function validRepository(repo) { return typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.split('/').some(part => part === '.' || part === '..'); }
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const ERROR = { status: 'error', updatedAt: null, items: [] };
const failure = (diagnostics, category, extra = {}) => diagnostics ? { ...ERROR, diagnostic: { category, ...extra } } : { ...ERROR };
const safeStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
function header(response, name) {
  try { return response.headers?.get?.(name) ?? null; } catch { return null; }
}
function backoffSeconds(response, now) {
  const retryHeader = header(response, 'retry-after');
  const retryAfter = Number(retryHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.max(60, Math.min(604800, Math.ceil(retryAfter)));
  const retryDate = typeof retryHeader === 'string' ? Date.parse(retryHeader) : NaN;
  if (Number.isFinite(retryDate) && retryDate > now) return Math.max(60, Math.min(604800, Math.ceil((retryDate - now) / 1000)));
  const reset = Number(header(response, 'x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(60, Math.min(604800, Math.ceil((reset * 1000 - now) / 1000)));
  return 60;
}

function issueFromGitHub(item, repo) {
  if (!item || !Number.isSafeInteger(item.number) || item.number <= 0 ||
      typeof item.title !== 'string' || !item.title.trim() ||
      typeof item.html_url !== 'string' ||
      typeof item.updated_at !== 'string' || !Number.isFinite(Date.parse(item.updated_at))) {
    throw new Error('Invalid GitHub issue data');
  }
  const url = new URL(item.html_url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' ||
      url.pathname !== `/${repo}/issues/${item.number}` ||
      url.search || url.hash || url.username || url.password) {
    throw new Error('Invalid GitHub issue URL');
  }
  return { number: item.number, title: item.title, url: item.html_url, updatedAt: item.updated_at };
}

export function createGitHubIssuesLoader({ token, repo = process.env.VILLAGE_GITHUB_REPO || DEFAULT_REPO, fetchImpl = fetch, now = Date.now, diagnostics = false } = {}) {
  let rateLimitUntil = 0;
  let rateLimitStatus = 429;
  return async function getTasks() {
    if (!token) return failure(diagnostics, 'missing_token');
    if (!repo) return failure(diagnostics, 'missing_repository');
    if (!validRepository(repo)) return failure(diagnostics, 'invalid_repository');
    if (now() < rateLimitUntil) return failure(diagnostics, 'rate_limited', {
      upstreamStatus: rateLimitStatus, retryAfterSeconds: Math.ceil((rateLimitUntil - now()) / 1000),
    });
    try {
      const items = [];
      const signal = AbortSignal.timeout(10_000);
      for (let page = 1; page <= MAX_PAGES; page++) {
        const baseUrl = `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`;
        const url = page === 1 ? baseUrl : `${baseUrl}&page=${page}`;
        const response = await fetchImpl(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal,
        });
        if (!response.ok) {
          const status = safeStatus(response.status);
          const rateLimited = status === 429 || (status === 403 && (header(response, 'retry-after') !== null || header(response, 'x-ratelimit-remaining') === '0'));
          if (rateLimited) {
            const seconds = backoffSeconds(response, now());
            rateLimitUntil = now() + seconds * 1000;
            rateLimitStatus = status;
            return failure(diagnostics, 'rate_limited', { upstreamStatus: status, retryAfterSeconds: seconds });
          }
          return failure(diagnostics, status === 401 || status === 403 ? 'upstream_denied' : 'upstream_http',
            status ? { upstreamStatus: status } : {});
        }
        let issues;
        try { issues = await response.json(); } catch { return failure(diagnostics, 'malformed_response'); }
        if (!Array.isArray(issues) || issues.length > PAGE_SIZE) return failure(diagnostics, 'malformed_response');
        try { items.push(...issues.filter(item => !item?.pull_request).map(item => issueFromGitHub(item, repo))); }
        catch { return failure(diagnostics, 'invalid_issue_data'); }
        if (issues.length < PAGE_SIZE) return { status: 'ok', updatedAt: new Date(now()).toISOString(), items };
      }
      return failure(diagnostics, 'pagination_limit');
    } catch {
      return failure(diagnostics, 'network_error');
    }
  };
}
