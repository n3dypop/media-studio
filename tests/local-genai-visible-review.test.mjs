import assert from 'node:assert/strict';
import test from 'node:test';
import { singleVisibleImageDelivery } from '../apps/dsh-plugins/local-genai/evaluation-evidence.mjs';

test('automatic review binding requires one visible current-turn image', () => {
  const turn = 1;
  const makeBinding = (callId, hash) => ({
    position: { turn, step: 1, callId },
    hashes: new Set([hash]),
    imageAttachments: [{ id: `attachment-${hash}`, hash }],
  });
  const first = makeBinding('render-one', 'first');
  const second = makeBinding('render-two', 'second');
  const results = [first, second].map(({ position: { callId }, imageAttachments: [{ id }] }, index) => ({
    event: { type: 'tool/result', seq: index + 1, data: { turn, step: 1, message: { source: { callId } } } },
    message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'image', attachment: { attachmentId: id } }] },
  }));
  const events = [
    { type: 'turn/start', data: { turn } }, ...results.map(({ event }) => event),
    { type: 'assistant/message', data: { turn, step: 2, message: { source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'review' }] } } },
    { type: 'tool/call', data: { turn, step: 2, callId: 'review' } },
  ];
  const session = {
    snapshotEvents: () => events,
    deriveMessages: () => results.map(({ message }) => message),
    surface: { nodes: [1, 2] },
  };
  assert.equal(singleVisibleImageDelivery(session, 'review', [first]), first);
  assert.equal(singleVisibleImageDelivery(session, 'review', [first, second]), null);
  assert.equal(singleVisibleImageDelivery(session, 'review', [{ ...first, videoHash: 'video' }]), null);
  assert.equal(singleVisibleImageDelivery(session, 'review', [{ ...first, imageAttachments: [...first.imageAttachments, ...first.imageAttachments] }]), null);
  results[1].message.content[0].offloaded = true;
  assert.equal(singleVisibleImageDelivery(session, 'review', [first, second]), first);
  session.surface.nodes = [];
  assert.equal(singleVisibleImageDelivery(session, 'review', [first, second]), null);
});
