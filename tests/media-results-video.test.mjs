import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedVideo,videoHandler} from '../apps/dsh-plugins/media-results/video.mjs';

const ref={attachmentId:`sha256:${'a'.repeat(64)}`,name:'fixture.mp4',bytes:12};
const result=message=>[
  {type:'tool/call',data:{name:'local_prepared_render',callId:'render'}},
  {type:'tool/result',surfaceOp:'append',data:{message:{source:{callId:'render'},content:[{type:'file',attachment:ref}],...message}}},
];

test('prepared render authorizes its video only after a successful result',()=>{
  assert.equal(recordedVideo(result(),ref.attachmentId),ref);
  assert.equal(recordedVideo(result({isError:true}),ref.attachmentId),null);
  const failed=result();failed[1].data.isError=true;
  assert.equal(recordedVideo(failed,ref.attachmentId),null);
});

test('a failed storage integrity check also rejects a bounded video range',async()=>{
  const handler=videoHandler({
    sessionQuery:{async observeSession(){return {events:result(),[Symbol.dispose](){}};}},
    attachments:{async *readFileStream(){
      for(const chunk of ['0123','4567','89ab'])yield Buffer.from(chunk);
      throw Error('Stored file attachment failed integrity verification.');
    }},
  });
  const response=await handler(new Request(`http://127.0.0.1/api/local-studio/video?sessionId=fixture&attachmentId=${ref.attachmentId}`,{headers:{range:'bytes=1-2'}}));
  assert.equal(response.status,206);
  await assert.rejects(response.text(),/failed integrity verification/);
});
