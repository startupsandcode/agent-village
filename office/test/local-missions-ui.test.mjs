import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from '../../village/node_modules/@playwright/test/index.mjs';
import { createOfficeServer } from '../server.mjs';

test('local Office renders running, accepted-preview, and error mission states accessibly at desktop and mobile sizes', async t => {
  const server = createOfficeServer({ getTasks: async () => ({ status: 'ok', updatedAt: null, items: [] }),
    getMissions: async () => ({ status: 'ok', updatedAt: '2026-10-24T12:00:00.000Z', items: [
      { id: 'running-local-46', goal: 'Build a useful local office mission status view.', status: 'running',
        currentStage: 'sam_implementation', createdAt: '2026-10-24T11:00:00.000Z',
        updatedAt: '2026-10-24T11:30:00.000Z', terminal: false, needsAttention: false },
      { id: 'complete-local-46', goal: 'Publish the reviewed local preview.', status: 'accepted_preview',
        currentStage: 'susie_visual', createdAt: '2026-10-24T10:00:00.000Z',
        updatedAt: '2026-10-24T11:00:00.000Z', terminal: true, needsAttention: false,
        previewUrl: 'https://preview.example.test/mission' },
      { id: 'error-local-46', goal: 'Investigate the worker failure safely.', status: 'ready',
        currentStage: 'quinn_functional', createdAt: '2026-10-24T10:00:00.000Z',
        updatedAt: '2026-10-24T11:20:00.000Z', terminal: false, needsAttention: true,
        attentionReason: 'Quinn review did not approve (status=blocked); findings: Retry control stayed enabled after cancel.' },
    ] }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/office`);
  const panel = page.getByRole('region', { name: 'Local mission runs' });
  await panel.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#local-missions-list .local-mission-card').length === 3);
  assert.equal(await page.getByText('Working', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Preview accepted', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Needs attention', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Quinn review did not approve (status=blocked); findings: Retry control stayed enabled after cancel.').count(), 1);
  const preview = page.getByRole('link', { name: 'Open reviewed preview' });
  assert.equal(await preview.getAttribute('href'), 'https://preview.example.test/mission');
  assert.match(await panel.getByRole('status').textContent(), /3 local missions found/);
  const refresh = panel.getByRole('button', { name: 'Refresh missions' });
  await refresh.focus();
  assert.equal(await refresh.evaluate(element => document.activeElement === element), true);

  await page.setViewportSize({ width: 390, height: 844 });
  const dimensions = await panel.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.client, 'mission panel does not overflow the narrow viewport');
});
