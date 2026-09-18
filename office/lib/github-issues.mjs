const ISSUES_URL = 'https://api.github.com/repos/startupsandcode/agent-village/issues?state=open&per_page=100';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const ERROR = { status: 'error', updatedAt: null, items: [] };

function issueFromGitHub(item) {
  if (!item || !Number.isSafeInteger(item.number) || item.number <= 0 ||
      typeof item.title !== 'string' || !item.title.trim() ||
      typeof item.html_url !== 'string' ||
      typeof item.updated_at !== 'string' || !Number.isFinite(Date.parse(item.updated_at))) {
    throw new Error('Invalid GitHub issue data');
  }
  const url = new URL(item.html_url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' ||
      url.pathname !== `/startupsandcode/agent-village/issues/${item.number}` ||
      url.search || url.hash || url.username || url.password) {
    throw new Error('Invalid GitHub issue URL');
  }
  return { number: item.number, title: item.title, url: item.html_url, updatedAt: item.updated_at };
}

export function createGitHubIssuesLoader({ token, fetchImpl = fetch, now = Date.now } = {}) {
  return async function getTasks() {
    if (!token) return { ...ERROR };
    try {
      const items = [];
      const signal = AbortSignal.timeout(10_000);
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = page === 1 ? ISSUES_URL : `${ISSUES_URL}&page=${page}`;
        const response = await fetchImpl(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal,
        });
        if (!response.ok) return { ...ERROR };
        const issues = await response.json();
        if (!Array.isArray(issues) || issues.length > PAGE_SIZE) return { ...ERROR };
        items.push(...issues.filter(item => !item?.pull_request).map(issueFromGitHub));
        if (issues.length < PAGE_SIZE) return { status: 'ok', updatedAt: new Date(now()).toISOString(), items };
      }
      return { ...ERROR };
    } catch {
      return { ...ERROR };
    }
  };
}
