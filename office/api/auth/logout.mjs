import { clearAuthCookies, officeOriginForHost } from '../../lib/auth.mjs';

export function createLogoutHandler() {
  return function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'POST') {
      response.statusCode = 405;
      response.setHeader('Allow', 'POST');
      response.end();
      return;
    }
    let officeOrigin;
    try { officeOrigin = officeOriginForHost(request.headers?.host); } catch { /* fail closed */ }
    if (request.headers?.origin !== officeOrigin) {
      response.statusCode = 403;
      response.end();
      return;
    }
    response.setHeader('Set-Cookie', clearAuthCookies());
    response.setHeader('Location', '/');
    response.statusCode = 303;
    response.end();
  };
}

export default createLogoutHandler();
