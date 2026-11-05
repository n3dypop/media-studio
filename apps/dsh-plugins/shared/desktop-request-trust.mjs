import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// This is request-shape protection, not authentication or an authorization
// policy. Both the challenge and mutation MUST be reached through DSH's
// owner-authenticated connection.fetch route and its Host/rebinding fence.
// A caller with a forged cookie can otherwise obtain its own valid proof.
// Proofs remain reusable within their lifetime for the same route; operation
// authorization, confirmation and idempotency must be enforced separately.

function checkedAudience(audience) {
  if (!audience || typeof audience !== 'object' || Array.isArray(audience) ||
      Object.keys(audience).some(key => !['method', 'path'].includes(key)) ||
      audience.method !== 'POST' || typeof audience.path !== 'string' ||
      !/^\/api\/local-studio\/(?!desktop-proof(?:\/|$))[a-z0-9-]+$/.test(audience.path)) {
    throw new TypeError('Invalid proof audience');
  }
  // Never retain a mutable object supplied by the registration caller.
  return Object.freeze({ method: audience.method, path: audience.path });
}

export function createDesktopRequestTrust({ origin, ttlMs = 300_000, now = Date.now } = {}) {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError('Expected an exact HTTP(S) Host origin');
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000 || typeof now !== 'function') {
    throw new TypeError('Invalid proof lifetime or clock');
  }
  const key = randomBytes(32);
  const browserShape = request => {
    const source = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
    return (source === null || source === origin) && (site === null || site === 'same-origin');
  };
  const sessionCookie = request => {
    const cookie = request.headers.get('cookie');
    // This only bounds and identifies a cookie; DSH must authenticate it first.
    return cookie && cookie.length <= 16_384 && /(?:^|;\s*)dsh-auth-[A-Za-z0-9_-]+=/.test(cookie) ? cookie : null;
  };
  const signature = (cookie, issued, audience) => createHmac('sha256', key)
    .update('desktop-request-proof-v2\0').update(audience.method).update('\0').update(audience.path)
    .update('\0').update(issued).update('\0').update(cookie).digest('base64url');
  const denied = () => new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });

  function challenge(request, audience) {
    if (request.method !== 'GET' || new URL(request.url).search || !browserShape(request) ||
        request.headers.get('x-local-studio-proof-request') !== '1') return denied();
    let target;
    try { target = checkedAudience(audience); } catch { return denied(); }
    const cookie = sessionCookie(request), time = now();
    if (!cookie || !Number.isSafeInteger(time) || time < 0) return denied();
    const issued = String(time);
    return new Response(JSON.stringify({ proof: `${issued}.${signature(cookie, issued, target)}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  function mutationAllowed(request, { marker } = {}) {
    if (request.method !== 'POST' || typeof marker !== 'string' || !marker || request.headers.get(marker) !== '1' ||
        !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || !browserShape(request)) return false;
    if (request.headers.get('origin') === origin) return true; // Existing authenticated Web behavior.
    let target;
    try { target = checkedAudience({ method: request.method, path: new URL(request.url).pathname }); } catch { return false; }
    const cookie = sessionCookie(request), proof = request.headers.get('x-local-studio-desktop-proof');
    if (!cookie || !proof || proof.length > 128) return false;
    const match = /^(0|[1-9]\d{0,15})\.([A-Za-z0-9_-]{43})$/.exec(proof);
    if (!match) return false;
    const issued = Number(match[1]), time = now();
    if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(time) || issued > time || time - issued > ttlMs) return false;
    const supplied = Buffer.from(match[2]), expected = Buffer.from(signature(cookie, match[1], target));
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  return Object.freeze({ challenge, mutationAllowed });
}

// Intentionally unregistered by default. Do not expose this on a separate web
// route or enable it until the calling Host and operation are qualified.
export function registerDesktopProof(ctx, path, trust, audience) {
  if (!/^\/api\/local-studio\/desktop-proof\/[a-z-]+$/.test(path) || typeof trust?.challenge !== 'function' ||
      typeof ctx?.connection?.fetch?.register !== 'function') throw new TypeError('Invalid authenticated proof route');
  const target = checkedAudience(audience);
  return ctx.connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered', fetch: request => trust.challenge(request, target) });
}

// The Host listener may become available only after plugins have started.
// Never accept request-supplied listener data, and bind a proof to one instance.
export function createHostDesktopRequestTrust(hostOrigin) {
  let trust, boundOrigin;
  const current = () => {
    const origin = hostOrigin();
    if (!origin || (boundOrigin && origin !== boundOrigin)) return null;
    if (!trust) { trust = createDesktopRequestTrust({origin}); boundOrigin = origin; }
    return trust;
  };
  return Object.freeze({
    challenge(request, audience) { return current()?.challenge(request, audience) ?? new Response(null,{status:403}); },
    mutationAllowed(request, options) { return current()?.mutationAllowed(request, options) ?? false; },
  });
}
