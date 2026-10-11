import { createHash } from 'node:crypto';

export function artifactDigest(html, css) {
  const part = value => createHash('sha256').update(value).digest();
  return createHash('sha256').update(part(html)).update(part(css)).digest('hex');
}

function required(value, max = 240) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid artifact content');
  return value.trim();
}
function escape(value) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }

export function verifyStaticSite(html, css) {
  const checks = [
    ['HTML document', /^<!doctype html>/i.test(html) && /<html\s+lang="en">/.test(html)],
    ['Page title and heading', /<title>[^<]+<\/title>/.test(html) && /<h1>[^<]+<\/h1>/.test(html)],
    ['Local stylesheet', /<link rel="stylesheet" href="styles\.css">/.test(html) && css.length > 100],
    ['No executable markup', !/<\s*(?:script|iframe|object|embed|form|base)\b/i.test(html) && !/\son[a-z]+\s*=/i.test(html)],
    ['No remote resources', !/(?:https?:)?\/\//i.test(html + css) && !/@import\b|url\s*\(/i.test(css)],
  ];
  if (checks.some(([, passed]) => !passed)) throw new Error(`Static site validation failed: ${checks.filter(([, passed]) => !passed).map(([name]) => name).join(', ')}`);
  return checks.map(([name]) => name);
}

export function renderArtifact(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.sections) || data.sections.length < 2 || data.sections.length > 6) throw new Error('Invalid artifact structure');
  const palettes = {
    forest: ['#173b35', '#eaf1e6', '#23705d', '#ffffff'],
    ocean: ['#163b52', '#e9f3f7', '#116f8a', '#ffffff'],
    sunrise: ['#4c2d36', '#fff0e8', '#ae4c48', '#ffffff'],
    slate: ['#253445', '#eef1f4', '#465f78', '#ffffff'],
  };
  const palette = Object.hasOwn(palettes, data.theme) ? palettes[data.theme] : null;
  if (!palette || data.sections[0]?.type !== 'hero') throw new Error('Invalid artifact structure');
  const title = escape(required(data.title, 80));
  const sections = data.sections.map((section, index) => {
    if (!section || typeof section !== 'object') throw new Error('Invalid artifact structure');
    const heading = escape(required(section.heading, 120));
    if (index === 0) return `<section class="hero"><h1>${heading}</h1><p>${escape(required(section.body, 360))}</p><a href="#section-1">${escape(required(section.actionText, 60))}</a></section>`;
    if (section.type === 'text' || section.type === 'cta') return `<section id="section-${index}" class="section-${section.type}"><h2>${heading}</h2><p>${escape(required(section.body, 600))}</p></section>`;
    if (!['cards', 'faq'].includes(section.type) || !Array.isArray(section.items) || section.items.length < 2 || section.items.length > 4) throw new Error('Invalid artifact structure');
    const items = section.items.map(item => {
      if (!item || typeof item !== 'object') throw new Error('Invalid artifact structure');
      return section.type === 'cards'
        ? `<li><h3>${escape(required(item.title, 80))}</h3><p>${escape(required(item.body, 240))}</p></li>`
        : `<li><details><summary>${escape(required(item.question, 120))}</summary><p>${escape(required(item.answer, 300))}</p></details></li>`;
    }).join('');
    return `<section id="section-${index}" class="section-${section.type}"><h2>${heading}</h2><ul>${items}</ul></section>`;
  });
  const html = `<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="styles.css"><main><p class="eyebrow">${title}</p>${sections.join('\n')}</main></html>\n`;
  const css = `:root{font-family:system-ui,sans-serif;color:${palette[0]};background:${palette[1]};--accent:${palette[2]};--card:${palette[3]}}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:3rem 1.5rem}.eyebrow{font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}section{padding:3rem 0;border-bottom:1px solid var(--accent)}.hero{padding:5rem 0 4rem}.hero h1{font-size:clamp(2.6rem,7vw,5.5rem);line-height:1.04;max-width:850px;margin:0}h2{font-size:clamp(2rem,4vw,3rem)}h3{font-size:1.2rem}p{font-size:1.15rem;line-height:1.6;max-width:760px}.hero a{display:inline-block;background:var(--accent);color:white;padding:.9rem 1.3rem;border-radius:.5rem;text-decoration:none;font-weight:700}ul{list-style:none;padding:0}.section-cards ul{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1.2rem}.section-cards li,.section-faq li{padding:1.4rem;margin:.8rem 0;background:var(--card);border-radius:.7rem}.section-faq summary{cursor:pointer;font-weight:700}.section-cta{padding:3rem;border:2px solid var(--accent);border-radius:1rem;margin:3rem 0}`;
  return { html, css, checks: verifyStaticSite(html, css), sha256: artifactDigest(html, css) };
}
