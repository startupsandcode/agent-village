import { createHash } from 'node:crypto';

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
  if (!data || typeof data !== 'object' || !Array.isArray(data.features) || data.features.length < 2 || data.features.length > 4) throw new Error('Invalid artifact structure');
  const title = escape(required(data.title, 80));
  const headline = escape(required(data.headline, 120));
  const summary = escape(required(data.summary, 360));
  const cta = escape(required(data.cta, 60));
  const features = data.features.map(item => `<li><h2>${escape(required(item.title, 60))}</h2><p>${escape(required(item.description, 220))}</p></li>`).join('\n');
  const html = `<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="styles.css"><main><p class="eyebrow">${title}</p><section class="hero"><h1>${headline}</h1><p>${summary}</p><a href="#details">${cta}</a></section><section id="details"><h2>What it offers</h2><ul>${features}</ul></section></main></html>\n`;
  const css = `:root{font-family:system-ui,sans-serif;color:#142a34;background:#f8f7f2}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:3rem 1.5rem}.eyebrow{font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#176a66}.hero{padding:5rem 0 4rem;border-bottom:2px solid #b6d6d0}.hero h1{font-size:clamp(2.6rem,7vw,5.5rem);line-height:1.04;max-width:850px;margin:0}.hero p{font-size:1.3rem;line-height:1.6;max-width:680px}.hero a{display:inline-block;background:#176a66;color:white;padding:.9rem 1.3rem;border-radius:.5rem;text-decoration:none;font-weight:700}section#details{padding:3rem 0}ul{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1.2rem;list-style:none;padding:0}li{border:1px solid #b6d6d0;border-radius:.7rem;padding:1.5rem;background:white}li h2{font-size:1.2rem}li p{line-height:1.6}`;
  return { html, css, checks: verifyStaticSite(html, css), sha256: createHash('sha256').update(html).update(css).digest('hex') };
}
