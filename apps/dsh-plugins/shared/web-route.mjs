const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), { status, headers: jsonHeaders });
}

export function isJsonRequest(request) {
  return request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

export function isLocalJsonMutation(request, origin, marker) {
  return Boolean(origin) && request.method === 'POST' && request.headers.get('origin') === origin
    && request.headers.get(marker) === '1' && request.headers.get('sec-fetch-site') !== 'cross-site'
    && isJsonRequest(request);
}

// Read the bound listener at request time. Web and Desktop can use different ports.
export function localHostOrigin(server) {
  try {
    if (server?.host !== '127.0.0.1' || server.protocol !== 'http:' || !Number.isInteger(server.port)
        || server.port < 1 || server.port > 65535) return null;
    const origin = server.getOrigin();
    return origin === `http://127.0.0.1:${server.port}` ? origin : null;
  } catch {
    return null;
  }
}
