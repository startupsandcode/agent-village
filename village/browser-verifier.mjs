import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium as playwrightChromium } from '@playwright/test';

const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'narrow', width: 390, height: 844 },
];

function requireValue(value, message) {
  if (!value) throw new Error(message);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalDestination(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function safeId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(value)) {
    throw new Error('invalid mission id for browser evidence');
  }
  return value;
}

export class BrowserPreviewVerifier {
  constructor({ evidenceRoot, chromium = playwrightChromium, timeoutMs = 15000 } = {}) {
    if (!evidenceRoot) throw new Error('browser evidence path required');
    this.evidenceRoot = resolve(evidenceRoot);
    this.chromium = chromium;
    this.timeoutMs = timeoutMs;
  }

  async capture({ mission, previewUrl }) {
    requireValue(mission && typeof mission === 'object', 'mission identity required');
    const id = safeId(mission.id);
    requireValue(typeof mission.artifactId === 'string' && mission.artifactId.trim(), 'artifact identity required');
    let destination;
    let target;
    try {
      destination = new URL(mission.destination);
      target = new URL(previewUrl);
    } catch {
      throw new Error('preview destination and URL must be absolute HTTP URLs');
    }
    requireValue(['http:', 'https:'].includes(destination.protocol) &&
      ['http:', 'https:'].includes(target.protocol), 'preview destination and URL must use HTTP(S)');
    requireValue(destination.username === '' && destination.password === '' &&
      destination.search === '' && destination.hash === '' && target.search === '' && target.hash === '',
    'preview destination and URL must not contain credentials, query parameters, or fragments');
    requireValue(target.username === '' && target.password === '', 'preview URL must not contain credentials');
    requireValue(canonicalDestination(destination.href) === canonicalDestination(target.href),
      'preview URL does not match the approved destination');

    const evidenceDir = join(this.evidenceRoot, id, `revision-${mission.revisions ?? 0}`);
    await mkdir(evidenceDir, { recursive: true });
    const browser = await this.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const blockedRequests = [];
    await context.route('**/*', async route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin === destination.origin) return route.continue();
      blockedRequests.push(requestUrl.origin);
      return route.abort();
    });
    try {
      const page = await context.newPage();
      const response = await page.goto(target.href, { waitUntil: 'networkidle', timeout: this.timeoutMs });
      requireValue(response && response.status() >= 200 && response.status() < 400, 'preview returned an unsuccessful HTTP status');
      requireValue(canonicalDestination(page.url()) === canonicalDestination(destination.href),
        'preview redirected away from the approved destination');
      await page.evaluate(() => document.fonts?.ready);
      const pageIdentity = await page.locator('meta[name="village-artifact-id"]').getAttribute('content');
      requireValue(pageIdentity === mission.artifactId, 'rendered page artifact identity does not match the approved mission');
      const captures = {};
      for (const viewport of viewports) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const metrics = await page.evaluate(() => ({
          width: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          heading: Boolean(document.querySelector('h1')?.getClientRects().length),
          title: document.title.trim(),
          imagesMissingAlt: [...document.images].filter(image => !image.hasAttribute('alt')).length,
          fontStatus: document.fonts?.status ?? 'unknown',
        }));
        requireValue(metrics.width === viewport.width && metrics.documentWidth <= viewport.width,
          `${viewport.name} preview has horizontal overflow`);
        requireValue(metrics.documentHeight <= 6000, `${viewport.name} preview exceeds the 6000px capture limit`);
        requireValue(metrics.heading && metrics.title && metrics.fontStatus === 'loaded',
          `${viewport.name} preview is missing a rendered heading, title, or loaded fonts`);
        requireValue(metrics.imagesMissingAlt === 0, `${viewport.name} preview has images without alt text`);
        const screenshotPath = join(evidenceDir, `${viewport.name}.png`);
        const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
        requireValue(screenshot.byteLength <= 8 * 1024 * 1024,
          `${viewport.name} screenshot exceeds the 8 MiB evidence limit`);
        captures[viewport.name] = { passed: true, evidenceRef: `sha256:${digest(screenshot)}`,
          screenshotPath, metrics };
      }
      const desktop = captures.desktop;
      const narrow = captures.narrow;
      const rendered = {
        artifactId: mission.artifactId,
        destination: destination.href.replace(/\/$/, ''),
        previewUrl: target.href,
        desktop: { passed: true, evidenceRef: desktop.evidenceRef },
        narrow: { passed: true, evidenceRef: narrow.evidenceRef },
        screenshotRef: desktop.screenshotPath,
        screenshotSha256: desktop.evidenceRef.slice('sha256:'.length),
        blockedExternalOrigins: [...new Set(blockedRequests)].sort(),
      };
      await writeFile(join(evidenceDir, 'render-evidence.json'), `${JSON.stringify({ rendered, captures }, null, 2)}\n`);
      return { rendered, captures };
    } finally {
      await context.close();
      await browser.close();
    }
  }

  async verifyRenderedEvidence({ mission, rendered }) {
    try {
      requireValue(rendered && rendered.artifactId === mission.artifactId, 'render evidence artifact mismatch');
      const destination = new URL(mission.destination);
      const preview = new URL(rendered.previewUrl);
      requireValue(preview.username === '' && preview.password === '' && preview.search === '' && preview.hash === '',
        'render evidence URL must not contain credentials, query parameters, or fragments');
      requireValue(rendered.destination === destination.href.replace(/\/$/, '') &&
        canonicalDestination(preview.href) === canonicalDestination(destination.href), 'render evidence destination mismatch');
      requireValue(rendered.desktop?.passed === true && rendered.narrow?.passed === true,
        'desktop and narrow browser evidence are required');
      const expectedScreenshot = join(this.evidenceRoot, safeId(mission.id), `revision-${mission.revisions ?? 0}`, 'desktop.png');
      requireValue(resolve(rendered.screenshotRef) === resolve(expectedScreenshot), 'screenshot path is outside the mission evidence directory');
      const screenshot = await readFile(rendered.screenshotRef);
      const narrowScreenshot = await readFile(join(this.evidenceRoot, safeId(mission.id),
        `revision-${mission.revisions ?? 0}`, 'narrow.png'));
      requireValue(digest(screenshot) === rendered.screenshotSha256 &&
        rendered.desktop.evidenceRef === `sha256:${rendered.screenshotSha256}` &&
        rendered.narrow.evidenceRef === `sha256:${digest(narrowScreenshot)}`,
      'desktop or narrow screenshot evidence digest mismatch');
      return { verified: true, artifactId: mission.artifactId,
        destination: rendered.destination, previewUrl: rendered.previewUrl,
        screenshotRef: rendered.screenshotRef };
    } catch {
      return { verified: false };
    }
  }
}
