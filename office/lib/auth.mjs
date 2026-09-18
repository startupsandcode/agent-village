import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

const DEFAULT_HOST = 'agent-village-six.vercel.app';
const OFFICE_ORIGINS = new Map([
  [DEFAULT_HOST, 'https://agent-village-six.vercel.app'],
  ['agent-village.startupsandcode.com', 'https://agent-village.startupsandcode.com'],
]);
const AUTH_URL = 'https://vercel.com/oauth/authorize';
const TOKEN_URL = 'https://api.vercel.com/login/oauth/token';
const USERINFO_URL = 'https://api.vercel.com/login/oauth/userinfo';
const JWKS_URL = 'https://vercel.com/.well-known/jwks';
const FLOW_COOKIE = '__Host-office_oauth';
const SESSION_COOKIE = '__Host-office_session';
const FLOW_MS = 10 * 60_000;
const SESSION_MS = 60 * 60_000;

export function officeOriginForHost(host) {
  const origin = typeof host === 'string' ? OFFICE_ORIGINS.get(host.toLowerCase()) : null;
  if (!origin) throw new Error('Unregistered office host');
  return origin;
}

function callbackForHost(host) {
  return `${officeOriginForHost(host)}/api/auth/callback`;
}

function getCookie(header, name) {
  if (typeof header !== 'string') return null;
  const pair = header.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return pair?.slice(name.length + 1) || null;
}

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function config(env) {
  const clientId = env.VERCEL_APP_CLIENT_ID?.trim();
  const clientSecret = env.VERCEL_APP_CLIENT_SECRET?.trim();
  const signingSecret = env.OFFICE_SESSION_SECRET;
  const emails = env.OFFICE_ALLOWED_EMAILS?.split(',').map(email => email.trim().toLowerCase()).filter(Boolean) || [];
  if (!clientId || !clientSecret || !signingSecret || Buffer.byteLength(signingSecret) < 32 || !emails.length) throw new Error('Office authentication configuration is missing');
  return { clientId, clientSecret, signingSecret, emails };
}

function seal(value, secret) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function unseal(value, secret, now) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!equal(signature, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isFinite(data.exp) || now >= data.exp) return null;
    return data;
  } catch { return null; }
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearAuthCookies() {
  return [cookie(FLOW_COOKIE, '', 0), cookie(SESSION_COOKIE, '', 0)];
}

async function verifyIdToken(token, expected, fetchImpl, now) {
  if (typeof token !== 'string' || token.length > 16_384) throw new Error('Invalid identity token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid identity token');
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw new Error('Invalid identity token'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid ||
      claims.iss !== 'https://vercel.com' || claims.aud !== expected.clientId ||
      !equal(claims.nonce, expected.nonce) || typeof claims.sub !== 'string' || !claims.sub ||
      !Number.isFinite(claims.exp) || claims.exp <= Math.floor(now / 1000) ||
      !Number.isFinite(claims.iat) || claims.iat > Math.floor(now / 1000) + 60 ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > Math.floor(now / 1000)))) throw new Error('Invalid identity token');
  const jwksResponse = await fetchImpl(JWKS_URL, { method: 'GET' });
  if (!jwksResponse.ok) throw new Error('Invalid identity token');
  const jwks = await jwksResponse.json();
  const key = Array.isArray(jwks.keys) && jwks.keys.find(candidate => candidate.kid === header.kid && candidate.kty === 'RSA' && candidate.alg === 'RS256' && candidate.use === 'sig');
  if (!key) throw new Error('Invalid identity token');
  let valid = false;
  try { valid = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url')); } catch { /* fail closed */ }
  if (!valid) throw new Error('Invalid identity token');
  return claims;
}

export function createAuth({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  function begin(host = DEFAULT_HOST) {
    const settings = config(env);
    const callback = callbackForHost(host);
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(AUTH_URL);
    for (const [key, value] of Object.entries({ client_id: settings.clientId, redirect_uri: callback, response_type: 'code', scope: 'openid email', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
    return { url: url.toString(), cookie: cookie(FLOW_COOKIE, seal({ state, nonce, verifier, callback, exp: now() + FLOW_MS }, settings.signingSecret), 600) };
  }

  function readFlow(header) {
    const settings = config(env);
    const flow = unseal(getCookie(header, FLOW_COOKIE), settings.signingSecret, now());
    if (!flow || typeof flow.state !== 'string' || typeof flow.nonce !== 'string' || typeof flow.verifier !== 'string') throw new Error('Invalid OAuth state');
    return flow;
  }

  async function complete({ code, state, cookie: cookieHeader, host = DEFAULT_HOST }) {
    const settings = config(env);
    const flow = readFlow(cookieHeader);
    if (typeof code !== 'string' || !code || !equal(state, flow.state)) throw new Error('Invalid OAuth state');
    const callback = callbackForHost(host);
    if (flow.callback !== callback) throw new Error('Invalid OAuth callback host');
    const tokenResponse = await fetchImpl(TOKEN_URL, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: settings.clientId, client_secret: settings.clientSecret, code, code_verifier: flow.verifier, redirect_uri: callback }) });
    if (!tokenResponse.ok) throw new Error('Invalid authorization code');
    const tokens = await tokenResponse.json();
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new Error('Invalid access token');
    const claims = await verifyIdToken(tokens.id_token, { clientId: settings.clientId, nonce: flow.nonce }, fetchImpl, now());
    const userResponse = await fetchImpl(USERINFO_URL, { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!userResponse.ok) throw new Error('Identity denied');
    const user = await userResponse.json();
    const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
    if (user.sub !== claims.sub || user.email_verified !== true || !settings.emails.includes(email)) throw new Error('Identity denied');
    return { email, sessionCookie: cookie(SESSION_COOKIE, seal({ sub: claims.sub, email, exp: now() + SESSION_MS }, settings.signingSecret), 3600) };
  }

  function authorize(cookieHeader) {
    let settings;
    try { settings = config(env); } catch { return { status: 503 }; }
    const session = unseal(getCookie(cookieHeader, SESSION_COOKIE), settings.signingSecret, now());
    if (!session || typeof session.sub !== 'string' || !session.sub || typeof session.email !== 'string') return { status: 401 };
    if (!settings.emails.includes(session.email.toLowerCase())) return { status: 403 };
    return { status: 200, email: session.email, sub: session.sub };
  }

  return { begin, readFlow, complete, authorize };
}
