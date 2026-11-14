import {successfulRenderContent} from './render-events.mjs';

export const VIDEO_PATH = '/api/local-studio/video';
export const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const BASE_HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'video/mp4' };

export function recordedVideo(events, attachmentId) {
  for (const content of successfulRenderContent(events)) {
    for (const part of content) {
      const ref = part?.type === 'file' ? part.attachment : null;
      if (ref?.attachmentId !== attachmentId || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId) || typeof ref.name !== 'string' || !/\.mp4$/i.test(ref.name)
        || /[\\/\x00-\x1f\x7f]/.test(ref.name) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_VIDEO_BYTES) continue;
      return ref;
    }
  }
  return null;
}

export function byteRange(value, size) {
  if (value === null) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count) || count <= 0) return null;
    start = Math.max(0, size - count); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end, partial: true };
}

/** Connection.fetch authenticates first. Only exact durable output membership
 * grants a read; callers cannot supply paths, arbitrary refs or source URLs. */
export function videoHandler({ sessionQuery, attachments }) {
  return async request => {
    const fail = (status, message, headers = {}) => new Response(request.method === 'HEAD' ? null : message, { status, headers: { ...BASE_HEADERS, ...headers } });
    if (!['GET', 'HEAD'].includes(request.method)) return fail(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    const query = new URL(request.url).searchParams;
    const sessionId = query.get('sessionId'); const id = query.get('attachmentId');
    if ([...query.keys()].some(key => !['sessionId', 'attachmentId'].includes(key)) || query.getAll('sessionId').length !== 1 || query.getAll('attachmentId').length !== 1
      || !sessionId || sessionId.length > 256 || /[\x00-\x1f\x7f]/.test(sessionId) || !/^sha256:[a-f0-9]{64}$/.test(id ?? '')) return fail(400, 'Invalid video identity');
    let observation;
    let ref;
    try {
      observation = await sessionQuery.observeSession(sessionId, { signal: request.signal, projectionMode: 'none' });
      ref = recordedVideo(observation.events, id);
    } catch { return fail(404, 'Video not recorded in this session'); }
    finally { observation?.[Symbol.dispose](); }
    if (!ref) return fail(404, 'Video not recorded in this session');
    const range = byteRange(request.headers.get('range'), ref.bytes);
    if (!range) return fail(416, 'Invalid byte range', { 'Content-Range': `bytes */${ref.bytes}` });
    const headers = { ...BASE_HEADERS, 'Accept-Ranges': 'bytes', 'Content-Length': String(range.end - range.start + 1),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(ref.name)}`,
      ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${ref.bytes}` } : {}) };
    if (request.method === 'HEAD') return new Response(null, { status: range.partial ? 206 : 200, headers });
    let iterator;
    try { iterator = attachments.readFileStream(ref, request.signal)[Symbol.asyncIterator](); }
    catch { return fail(503, 'Video not available'); }
    let offset = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            request.signal.throwIfAborted();
            const next = await iterator.next();
            if (next.done) {
              if (offset !== ref.bytes) throw new Error('Stored video size differs.');
              controller.close(); return;
            }
            const chunk = next.value; const begin = offset; offset += chunk.byteLength;
            if (offset > ref.bytes) throw new Error('Stored video exceeds its recorded size.');
            const from = Math.max(0, range.start - begin); const until = Math.min(chunk.byteLength, range.end + 1 - begin);
            // DSH verifies the stored length and digest at EOF. Keep reading
            // the authorized stream even when only a byte range is returned.
            if (until > from) { controller.enqueue(chunk.slice(from, until)); return; }
          }
        } catch (error) { try { await iterator.return?.(); } finally { controller.error(error); } }
      },
      async cancel() { await iterator.return?.(); },
    });
    return new Response(stream, { status: range.partial ? 206 : 200, headers });
  };
}
