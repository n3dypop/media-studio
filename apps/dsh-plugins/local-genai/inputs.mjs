import { createHash } from 'node:crypto';

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function currentUserRequest(session) {
  const events = session?.snapshotEvents?.();
  if (!Array.isArray(events)) return null;
  const start = events.findLastIndex(event => event.type === 'turn/start');
  if (start < 0) return null;
  const messages = events.slice(start + 1).filter(event =>
    event.type === 'user/message' && event.data?.source?.kind === 'user');
  if (messages.length !== 1 || !Array.isArray(messages[0].data?.content)) return null;
  const text = messages[0].data.content.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').trim();
  return text && text.length <= 8000 ? text : null;
}

// DSH records a question reply as an owned tool result within the original
// turn. Bind the answer to the actual question and its displayed options.
export function currentUserChoices(session) {
  const events = session?.snapshotEvents?.();
  if (!Array.isArray(events)) return [];
  const start = events.findLastIndex(event => event.type === 'turn/start');
  if (start < 0) return [];
  const calls = new Map(), choices = [];
  for (const event of events.slice(start + 1)) {
    const data = event.data, message = data?.message;
    if (event.type === 'tool/call' && data?.name === 'ask_user_question') {
      calls.set(data.callId, event);
    } else if (event.type === 'tool/result' && message?.isError === false && message.role === 'tool' &&
        message.source?.kind === 'tool' && message.source.callId === message.toolCallId) {
      const call = calls.get(message.toolCallId);
      if (!call || event.sourceEventSeqs?.length !== 1 || event.sourceEventSeqs[0] !== call.seq ||
          data.turn !== call.data.turn || data.step !== call.data.step || message.content?.length !== 1 ||
          message.content[0]?.type !== 'text') continue;
      try {
        const args = typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments;
        const result = JSON.parse(message.content[0].text);
        if (!Array.isArray(result.answers) || !Array.isArray(args?.questions)) continue;
        for (const answer of result.answers) {
          const questions = args.questions.filter(question => question.id === answer.id);
          if (questions.length !== 1 || !Array.isArray(answer.selected)) continue;
          const labels = (questions[0].options ?? []).map(option => option.label);
          if (answer.selected.length === 1 && answer.custom === undefined && labels.includes(answer.selected[0])) {
            choices.push({ text: answer.selected[0], fromOption: true });
          } else if (answer.selected.length === 0 && typeof answer.custom === 'string' && answer.custom.trim()) {
            choices.push({ text: answer.custom.trim(), fromOption: false });
          }
        }
      } catch { /* An incomplete or malformed result does not select an option. */ }
    }
  }
  return choices.reverse();
}

// A single explicit PNG size can be enforced without guessing which of
// several dimensions or formats the user intends to generate.
export function requestedPngSize(request) {
  if (typeof request !== 'string') return null;
  const dimensions = [...request.matchAll(/\b(\d{2,5})\s*[x×]\s*(\d{2,5})\b/giu)];
  if (dimensions.length !== 1) return null;
  const [size, width, height] = dimensions[0];
  const suffix = request.slice(dimensions[0].index + size.length);
  const output = /^\s*(?:px\s*)?(?:の\s*)?PNG(?:\s+output\b|\s*を\s*(?:\d+\s*枚\s*)?(?:生成|作成|出力))/iu;
  return output.test(suffix) ? { width: Number(width), height: Number(height) } : null;
}

export function userImages(session) {
  if (typeof session?.deriveMessages !== 'function') throw new Error('The current DSH session cannot supply admitted image references.');
  const images = new Map();
  for (const message of session.deriveMessages()) {
    if (message.role !== 'user' || message.source?.kind !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const ref = block?.type === 'image' ? block.attachment : undefined;
      if (!ref || typeof ref.attachmentId !== 'string' || !ref.attachmentId || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0
        || !Number.isSafeInteger(ref.width) || ref.width <= 0 || !Number.isSafeInteger(ref.height) || ref.height <= 0) continue;
      images.delete(ref.attachmentId);
      images.set(ref.attachmentId, { ref, messageId: message.id });
    }
  }
  return [...images.values()].reverse();
}

export function listUserImages(session) {
  const images = userImages(session);
  return { inputImages: images.slice(0, 32).map(({ ref, messageId }) => ({
    attachmentId: ref.attachmentId, messageId, name: ref.name ?? 'uploaded image',
    mime: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height,
    importable: SUPPORTED.has(ref.mediaType) && ref.bytes <= MAX_INPUT_BYTES && ref.width <= 4096 && ref.height <= 4096 && ref.width * ref.height <= 12000000,
  })), olderImagesOmitted: Math.max(0, images.length - 32),
  source: 'admitted-user-images-in-current-context',
  note: 'Only actual user images are listed. Select the intended input or reference. If an old upload was compacted, upload it again; saved production artifacts can be reused by run id and hash.' };
}

export async function imageImportBody(args, { session, attachments, signal }) {
  if (!['input', 'reference'].includes(args.purpose)) throw new Error('Image purpose must be input or reference.');
  if (args.attachmentId !== undefined) {
    if (args.sourceRunId !== undefined || args.artifactSha256 !== undefined) throw new Error('Choose a user attachment or a saved artifact, not both.');
    const entry = userImages(session).find(({ ref }) => ref.attachmentId === args.attachmentId);
    if (!entry) throw new Error('This image was not admitted as user content in the current conversation.');
    const ref = entry.ref;
    if (!SUPPORTED.has(ref.mediaType) || ref.bytes > MAX_INPUT_BYTES || ref.width > 4096 || ref.height > 4096 || ref.width * ref.height > 12000000) throw new Error('Input image exceeds supported format, byte or dimension limits.');
    const stored = await attachments.readImage(ref, signal);
    signal.throwIfAborted();
    if (!stored?.data || stored.data.byteLength !== ref.bytes || stored.data.byteLength > MAX_INPUT_BYTES
      || stored.ref?.attachmentId !== ref.attachmentId) throw new Error('Admitted image integrity verification failed.');
    return { purpose: args.purpose, mime: ref.mediaType, dataBase64: Buffer.from(stored.data).toString('base64'), ...(ref.name ? { filename: ref.name } : {}) };
  }
  if (typeof args.sourceRunId !== 'string' || !/^[a-f0-9-]{36}$/.test(args.sourceRunId) || !/^[a-f0-9]{64}$/.test(args.artifactSha256 ?? '')) throw new Error('An actual user attachment or an owned saved run and artifact hash are required.');
  return { purpose: args.purpose, sourceRunId: args.sourceRunId, artifactSha256: args.artifactSha256 };
}

export function assetReceipt(result, purpose, originalBytes) {
  const asset = result?.asset;
  if (!asset || typeof asset.id !== 'string' || !/^[a-f0-9-]{36}$/.test(asset.id) || asset.purpose !== purpose
    || asset.mime !== 'image/png' || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(asset.originalSha256 ?? '')
    || !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width < 1 || asset.height < 1
    || asset.width > 4096 || asset.height > 4096 || asset.width * asset.height > 12000000
    || (originalBytes && createHash('sha256').update(originalBytes).digest('hex') !== asset.originalSha256)) throw new Error('Controller returned an invalid asset receipt.');
  return asset;
}
