import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const firstId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const secondId = '6ba7b811-9dad-41d1-80b4-00c04fd430c8';
const createdId = '6ba7b812-9dad-41d1-80b4-00c04fd430c8';
const reply = value => ({ ok: true, json: async () => value });
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

function page({ hash = '', failList = false, delayedStart = false, failDetail = null, summaryOverrides = null, delayedArchive = false, delayedBuild = false, firstReady = false, archivedSecond = false } = {}) {
  const elements = new Map();
  const requests = [];
  const location = { hash };
  const windowListeners = new Map();
  let releaseStart, releaseArchive, releaseBuild;
  let requestNumber = 0;
  function element(name) {
    return { name, hidden: ['#hosted-chat', '#project-create', '#project-detail'].includes(name), disabled: false,
      value: '', textContent: '', children: [], listeners: new Map(), attributes: {},
      addEventListener(type, callback) { this.listeners.set(type, callback); },
      querySelector(selector) { return get(`${name} ${selector}`); },
      setAttribute(key, value) { this.attributes[key] = value; },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      focus() { this.focused = true; } };
  }
  const get = name => { if (!elements.has(name)) elements.set(name, element(name)); return elements.get(name); };
  const summaries = summaryOverrides ?? [
    { id: firstId, goal: 'Build the current garden site', status: 'building', latestAgent: 'Sam',
      latestMessage: 'Creating the site', updatedAt: '2026-10-12T01:00:00Z' },
    { id: secondId, goal: 'Finished welcome site', status: 'reviewed', latestAgent: 'Quinn',
      latestMessage: 'Reviewed the files', updatedAt: '2026-10-12T02:00:00Z' },
  ];
  const details = {
    [firstId]: { id: firstId, version: 2, archiveAvailable: true, goal: summaries[0].goal, status: firstReady ? 'ready' : 'building', createdAt: '2026-10-11T20:00:00Z',
      plan: { summary: 'A small accessible garden site' }, events: [{ agent: 'Sam', type: 'start', message: 'Creating the site' }], artifact: null },
    [secondId]: { id: secondId, version: 4, archivedAt: archivedSecond ? '2026-10-23T00:00:00Z' : null, archiveAvailable: true, goal: summaries[1].goal, status: 'reviewed', createdAt: '2026-10-11T19:00:00Z',
      plan: { summary: 'A welcome site' }, events: [{ agent: 'Quinn', type: 'review', message: 'Reviewed the files' }], artifact: null },
  };
  const fetch = async (url, options = {}) => {
    if (url === '/api/maya-status') return reply({ runAvailable: true });
    if (url === '/api/maya-domain') return reply({ audience: '', expertise: '', rules: '' });
    if (url.startsWith('/api/maya-usage')) return reply({});
    if (url.startsWith('/api/maya-projects?offset=')) {
      requests.push(['list', url]);
      if (failList) return { ok: false, json: async () => ({ error: 'Unavailable' }) };
      return reply({ projects: summaries, hasMore: false, nextOffset: null });
    }
    if (url.startsWith('/api/maya-projects?id=')) {
      requests.push(['detail', url]);
      const id = new URL(url, 'https://office.example').searchParams.get('id');
      if (id === failDetail) return { ok: false, json: async () => ({ error: 'Project unavailable' }) };
      return reply(details[id]);
    }
    if (url === '/api/maya-projects' && options.method === 'POST') {
      const body = JSON.parse(options.body); requests.push([body.action, body]);
      if (body.action === 'restore') return reply({ ...details[body.id], version: details[body.id].version + 1, archivedAt: null });
      if (body.action === 'archive') {
        if (delayedArchive) await new Promise(resolve => { releaseArchive = resolve; });
        return reply({ ...details[body.id], version: details[body.id].version + 1, archivedAt: '2026-10-23T00:00:00Z' });
      }
      if (body.action === 'build') {
        if (delayedBuild) await new Promise(resolve => { releaseBuild = resolve; });
        return reply({ ...details[body.id], version: details[body.id].version + 1, status: 'awaiting_review' });
      }
      if (body.action === 'start' && delayedStart) await new Promise(resolve => { releaseStart = resolve; });
      if (body.action === 'start') return reply({ id: createdId, version: 0, goal: body.goal, status: 'clarifying',
        createdAt: '2026-10-12T02:00:00Z', events: [{ agent: 'Maya', type: 'start', message: 'Reading the goal' }], artifact: null });
      if (body.action === 'clarify') return reply({ id: createdId, version: 1, goal: 'A new project', status: 'needs_answer',
        createdAt: '2026-10-12T02:00:00Z', events: [{ agent: 'Maya', type: 'question', message: 'Who is it for?' }], artifact: null });
      if (body.action === 'publishStatus') return reply({ targets: { github: { available: false }, vercel: { available: false } },
        receipts: { github: null, vercel: null }, artifactSha256: null });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  return { get, requests, location, fetch, releaseStart: () => releaseStart?.(), releaseArchive: () => releaseArchive?.(), releaseBuild: () => releaseBuild?.(), hashchange: () => windowListeners.get('hashchange')?.(), async run() {
    const source = await readFile(new URL('../public/office-assets/hosted-chat.js', import.meta.url), 'utf8');
    runInNewContext(source, { document: { querySelector: get, createElement: name => element(name),
      createTextNode: value => ({ textContent: value }) }, fetch, location,
    sessionStorage: { getItem: () => firstId, setItem() {}, removeItem() {} },
    crypto: { randomUUID: () => `request-${++requestNumber}` }, setInterval: () => 1, clearInterval() {},
    addEventListener: (name, callback) => windowListeners.set(name, callback) });
    await flush();
  } };
}

test('dashboard is the default and orders visible project cards before the Village room', async () => {
  const ui = page(); await ui.run();
  assert.equal(ui.get('#project-dashboard').hidden, false);
  assert.equal(ui.get('#global-office').hidden, false);
  assert.equal(ui.get('#project-detail').hidden, true);
  const cards = ui.get('#project-list').children;
  assert.equal(cards.length, 2);
  assert.equal(cards[0].href, `#project/${firstId}`);
  assert.match(cards[0].attributes['aria-label'], /current garden site/);
  assert.equal(cards[1].href, `#project/${secondId}`);
  assert.deepEqual(ui.requests.map(([type]) => type), ['list']);
});

test('blocked projects show a clear reason and action; reviewed means review passed', async () => {
  const ui = page({ summaryOverrides: [
    { id: firstId, goal: 'Broken garden site', status: 'blocked', latestAgent: 'Maya',
      latestMessage: 'Project requires intervention', updatedAt: '2026-10-12T01:00:00Z' },
    { id: secondId, goal: 'Finished welcome site', status: 'reviewed', latestAgent: 'Quinn',
      latestMessage: 'Reviewed the files', updatedAt: '2026-10-12T02:00:00Z' },
  ] });
  await ui.run();
  const [blocked, reviewed] = ui.get('#project-list').children;
  assert.match(blocked.className, /is-blocked/);
  assert.match(blocked.children[0].children[1].textContent, /⚠ Blocked/);
  assert.match(blocked.children[1].textContent, /Project requires intervention/);
  assert.match(blocked.children[2].textContent, /inspect and resolve/);
  assert.match(blocked.attributes['aria-label'], /Blocked/);
  assert.match(blocked.attributes['aria-label'], /Project requires intervention/);
  assert.equal(reviewed.children[0].children[1].textContent, 'Review passed');
  assert.match(reviewed.children[2].textContent, /check publication status/);
  const css = await readFile(new URL('../public/office-assets/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.project-card\.is-blocked \{ border: 2px solid/);
  assert.match(css, /\.project-badge\.is-blocked \{ background:/);
});

test('question failures and interruptions use warning cards; a requested answer stays distinct', async () => {
  const ui = page({ summaryOverrides: [
    { id: firstId, goal: 'Failed question', status: 'question_error', latestAgent: 'Maya',
      latestMessage: 'Maya could not ask a valid question', updatedAt: '2026-10-12T01:00:00Z' },
    { id: secondId, goal: 'Interrupted build', status: 'interrupted', latestMessage: '', updatedAt: '2026-10-12T02:00:00Z' },
    { id: createdId, goal: 'Awaiting answer', status: 'needs_answer', latestAgent: 'Maya',
      latestMessage: 'Who is it for?', updatedAt: '2026-10-12T03:00:00Z' },
  ] });
  await ui.run();
  const [failed, interrupted, needsAnswer] = ui.get('#project-list').children;
  assert.match(failed.className, /is-blocked/);
  assert.match(failed.children[0].children[1].textContent, /Maya question failed/);
  assert.match(interrupted.className, /is-blocked/);
  assert.equal(interrupted.children[1].textContent, 'Reason not recorded.');
  assert.doesNotMatch(needsAnswer.className, /is-blocked/);
  assert.equal(needsAnswer.children[0].children[1].textContent, 'Maya needs your answer');
});

test('legacy invalid Maya question stays visibly blocked with retry as its next action', async () => {
  const ui = page({ summaryOverrides: [
    { id: firstId, goal: 'Garden site', status: 'blocked', latestAgent: 'Maya',
      latestMessage: 'Maya returned an invalid question', updatedAt: '2026-10-12T01:00:00Z' },
    { id: secondId, goal: 'Reviewed site', status: 'reviewed', latestAgent: 'Quinn',
      latestMessage: 'Review passed', updatedAt: '2026-10-12T02:00:00Z' },
  ] });
  await ui.run();
  const card = ui.get('#project-list').children[0];
  assert.match(card.className, /is-blocked/);
  assert.equal(card.children[0].children[1].textContent, '⚠ Blocked');
  assert.match(card.children[1].textContent, /invalid question/);
  assert.equal(card.children[2].textContent, 'Open project to retry Maya question.');
  assert.match(card.attributes['aria-label'], /Blocked/);
  assert.match(card.attributes['aria-label'], /Maya returned an invalid question/);
});

test('a project opens its real detail and the back control restores the dashboard', async () => {
  const ui = page(); await ui.run();
  await ui.get('#project-list').children[0].listeners.get('click')({ preventDefault() {} });
  await flush();
  assert.equal(ui.location.hash, `#project/${firstId}`);
  assert.equal(ui.get('#project-detail').hidden, false);
  assert.equal(ui.get('#global-office').hidden, true);
  assert.equal(ui.get('#project-detail-title').textContent, 'Build the current garden site');
  assert.match(ui.get('#project-team').children[1].textContent, /Sam: last recorded start/);
  ui.get('#project-detail-back').listeners.get('click')();
  await flush();
  assert.equal(ui.get('#project-dashboard').hidden, false);
  assert.equal(ui.location.hash, '');
});

test('creation can be opened and cancelled without a run, then creates a project and opens it', async () => {
  const ui = page(); await ui.run();
  ui.get('#project-create-open').listeners.get('click')();
  assert.equal(ui.get('#project-create').hidden, false);
  ui.get('#project-create-back').listeners.get('click')();
  await flush();
  assert.equal(ui.requests.some(([type]) => type === 'start'), false);
  ui.get('#project-create-open').listeners.get('click')();
  ui.get('#hosted-create-goal').value = 'A new project';
  await ui.get('#hosted-create-form').listeners.get('submit')({ preventDefault() {} });
  assert.deepEqual(ui.requests.filter(([type]) => ['start', 'clarify'].includes(type)).map(([type]) => type), ['start', 'clarify']);
  assert.equal(ui.location.hash, `#project/${createdId}`);
  assert.equal(ui.get('#project-detail').hidden, false);
  assert.equal(ui.get('#hosted-message').disabled, false);
});

test('a deep link restores the project, while an ordinary reload still opens the dashboard', async () => {
  const linked = page({ hash: `#project/${firstId}` }); await linked.run();
  assert.equal(linked.get('#project-detail').hidden, false);
  assert.equal(linked.get('#project-detail-title').textContent, 'Build the current garden site');
  assert.deepEqual(linked.requests.map(([type]) => type), ['detail']);
  const ordinary = page(); await ordinary.run();
  assert.equal(ordinary.get('#project-dashboard').hidden, false);
  assert.deepEqual(ordinary.requests.map(([type]) => type), ['list']);
});

test('dashboard errors offer retry and mobile cards use a single-column layout', async () => {
  const ui = page({ failList: true }); await ui.run();
  assert.match(ui.get('#project-list-status').textContent, /could not be loaded/);
  assert.equal(ui.get('#project-load-more').hidden, false);
  const css = await readFile(new URL('../public/office-assets/styles.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.project-team \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.project-list \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 320px\), 1fr\)\)/);
});

test('browser navigation during a pending start keeps one request and exposes its saved result', async () => {
  const ui = page({ delayedStart: true }); await ui.run();
  ui.get('#project-create-open').listeners.get('click')();
  ui.get('#hosted-create-goal').value = 'A new project';
  const first = ui.get('#hosted-create-form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  ui.location.hash = ''; ui.hashchange(); await flush();
  ui.get('#project-create-open').listeners.get('click')();
  ui.get('#hosted-create-goal').value = 'A new project';
  const retry = ui.get('#hosted-create-form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  assert.equal(ui.requests.filter(([type]) => type === 'start').length, 1);
  ui.releaseStart(); await Promise.all([first, retry]); await flush();
  assert.equal(ui.requests.filter(([type]) => type === 'start').length, 1);
  assert.equal(ui.location.hash, `#project/${createdId}`);
});

test('a completed project does not consume a later same-goal create request', async () => {
  const ui = page(); await ui.run();
  ui.get('#project-create-open').listeners.get('click')();
  ui.get('#hosted-create-goal').value = 'A new project';
  await ui.get('#hosted-create-form').listeners.get('submit')({ preventDefault() {} });
  ui.get('#hosted-new').listeners.get('click')();
  ui.get('#hosted-create-goal').value = 'A new project';
  await ui.get('#hosted-create-form').listeners.get('submit')({ preventDefault() {} });
  const starts = ui.requests.filter(([type]) => type === 'start').map(([, body]) => body.requestId);
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0], starts[1]);
});

test('a late start result leaves a different new draft in place', async () => {
  const ui = page({ delayedStart: true }); await ui.run();
  ui.get('#project-create-open').listeners.get('click')();
  ui.get('#hosted-create-goal').value = 'Original project';
  const first = ui.get('#hosted-create-form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  ui.get('#hosted-create-goal').value = 'Different project draft';
  ui.releaseStart(); await first;
  assert.equal(ui.get('#project-create').hidden, false);
  assert.equal(ui.get('#hosted-create-goal').value, 'Different project draft');
  assert.match(ui.get('#hosted-create-state').textContent, /Previous project was created/);
});

test('a failed detail lookup clears the previous project and its controls', async () => {
  const ui = page({ failDetail: secondId }); await ui.run();
  ui.get('#project-list').children[0].listeners.get('click')({ preventDefault() {} }); await flush();
  assert.match(ui.get('#project-plan').children[1].textContent, /accessible garden/);
  ui.location.hash = `#project/${secondId}`; ui.hashchange(); await flush();
  assert.match(ui.get('#hosted-request-state').textContent, /Project unavailable/);
  assert.equal(ui.get('#project-plan').children.length, 0);
  assert.equal(ui.get('#project-team').children.length, 0);
  assert.equal(ui.get('#hosted-events').children.length, 0);
  assert.equal(ui.get('#hosted-artifact').children.length, 0);
  assert.equal(ui.get('#hosted-publish').hidden, true);
  assert.equal(ui.get('#hosted-chat-form button').disabled, true);
});

test('dashboard precedes the room in DOM and visual reading order', async () => {
  const html = await readFile(new URL('../private/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('<section class="hosted-maya"') < html.indexOf('<div id="global-office"'));
});


test('Archive and Restore views use persistent API actions with the displayed project version', async () => {
  const ui = page(); await ui.run();
  ui.get('#project-view-archived').listeners.get('click')(); await flush();
  assert.ok(ui.requests.some(([kind, url]) => kind === 'list' && url.includes('archived=true')));
  assert.equal(ui.get('#project-view-archived').attributes['aria-pressed'], 'true');
  await ui.get('#project-list').children[1].listeners.get('click')({ preventDefault() {} }); await flush();
  assert.equal(ui.get('#project-archive').disabled, false);
  await ui.get('#project-archive').listeners.get('click')(); await flush();
  const archive = ui.requests.find(([kind]) => kind === 'archive')[1];
  assert.equal(archive.id, secondId); assert.equal(archive.expectedVersion, 4);
  assert.equal(ui.get('#project-dashboard').hidden, false);
});

test('late archive completion cannot clear the busy state of a different project action', async () => {
  const ui = page({ delayedArchive: true, delayedBuild: true, firstReady: true }); await ui.run();
  await ui.get('#project-list').children[1].listeners.get('click')({ preventDefault() {} }); await flush();
  const archive = ui.get('#project-archive').listeners.get('click')(); await flush();
  ui.get('#project-detail-back').listeners.get('click')(); await flush();
  await ui.get('#project-list').children[0].listeners.get('click')({ preventDefault() {} }); await flush();
  const build = ui.get('#hosted-build').listeners.get('click')(); await flush();
  assert.equal(ui.requests.filter(([kind]) => kind === 'build').length, 1);
  ui.releaseArchive(); await archive; await flush();
  await ui.get('#project-archive').listeners.get('click')();
  assert.equal(ui.requests.filter(([kind]) => kind === 'archive').length, 1);
  assert.equal(ui.get('#project-detail-title').textContent, 'Build the current garden site');
  ui.releaseBuild(); await build;
});

test('archived detail offers Restore and disables provider and publishing actions', async () => {
  const ui = page({ archivedSecond: true }); await ui.run();
  await ui.get('#project-list').children[1].listeners.get('click')({ preventDefault() {} }); await flush();
  assert.equal(ui.get('#project-archive').hidden, true);
  assert.equal(ui.get('#project-restore').hidden, false);
  assert.equal(ui.get('#hosted-publish').hidden, true);
  assert.equal(ui.get('#hosted-build').hidden, true);
  assert.equal(ui.get('#hosted-message').disabled, true);
  assert.match(ui.get('#hosted-request-state').textContent, /Archived project/);
  await ui.get('#project-restore').listeners.get('click')();
  const restore = ui.requests.find(([kind]) => kind === 'restore')[1];
  assert.equal(restore.id, secondId); assert.equal(restore.expectedVersion, 4);
});