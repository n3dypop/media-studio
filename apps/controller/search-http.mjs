import {ApiError} from './store.mjs';
import {validateSession} from './productions.mjs';
import {createHash} from 'node:crypto';

export async function searchRoute({req,res,path,url,role,productions,search,body,json,backgroundSearch}){
  if(!path.startsWith('/api/search-proposals'))return false;
  if(!search||!productions)throw new ApiError(503,'資料検索の準備が完了していません。');
  const own=(productionId,{mutable=false}={})=>{
    const owner=productions.ownerOf(productionId);
    if(!owner)throw new ApiError(404,'制作記録がありません。');
    const session=validateSession(role==='dsh'?req.headers['x-dsh-session']:owner);
    if(owner!==session)throw new ApiError(404,'この会話の制作記録がありません。');
    const production=productions.get(productionId,session);
    if(mutable&&(production.cancelRequested||production.phase==='cancelled'||production.phase==='cancelling'))throw new ApiError(409,'停止した制作から外部への送信は行えません。');
    return session;
  };
  const ownProposal=(proposal,{mutable=false}={})=>{
    if(proposal.productionId!==null && proposal.productionId!==undefined)return own(proposal.productionId,{mutable});
    const session=role==='dsh'?validateSession(req.headers['x-dsh-session']):validateSession(proposal.sessionId);
    if(proposal.sessionId!==session)throw new ApiError(404,'この会話の検索提案はありません。');
    return session;
  };
  if(path==='/api/search-proposals/cancel-session'&&req.method==='POST'){
    if(role!=='admin')throw new ApiError(403,'会話の検索停止は本人画面だけが使用できます。');
    const input=await body(req),sessionId=validateSession(input.sessionId);
    const proposals=search.cancelSession(sessionId,input.searchTurn);
    json(res,200,{sessionId,proposals});return true;
  }
  if(path==='/api/search-proposals/user-turn'&&req.method==='POST'){
    if(role!=='dsh')throw new ApiError(403,'会話のターン登録はDSHだけが使用できます。');
    const sessionId=validateSession(req.headers['x-dsh-session']),input=await body(req);
    await search.registerUserTurn(sessionId,input.turn,input.hostId);json(res,200,{sessionId,turn:input.turn,...(input.hostId!==undefined?{hostId:input.hostId}:{})});return true;
  }
  if(path==='/api/search-proposals/gateway-register'&&req.method==='POST'){
    if(role!=='dsh')throw new ApiError(403,'検索gateway登録はDSHだけが使用できます。');const sessionId=validateSession(req.headers['x-dsh-session']),input=await body(req);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='hostId,port')throw new ApiError(400,'検索gateway情報が不正です。');json(res,200,await search.registerGateway({sessionId,hostId:input.hostId,port:input.port}));return true;
  }
  if(path==='/api/search-proposals/turn-owner-recovery'&&req.method==='GET'){
    if(role!=='admin')throw new ApiError(403,'検索ターンの復旧は保守担当だけが使用できます。');
    if([...url.searchParams.keys()].some(key=>!['sessionId','turn'].includes(key))||url.searchParams.getAll('sessionId').length!==1||url.searchParams.getAll('turn').length!==1||!/^\d+$/.test(url.searchParams.get('turn')))throw new ApiError(400,'会話とターンを指定してください。');
    json(res,200,search.inspectTurnOwner(validateSession(url.searchParams.get('sessionId')),Number(url.searchParams.get('turn'))));return true;
  }
  if(path==='/api/search-proposals/turn-owner-recovery'&&req.method==='POST'){
    if(role!=='admin')throw new ApiError(403,'検索ターンの復旧は保守担当だけが使用できます。');
    json(res,200,search.abandonTurnOwner(await body(req)));return true;
  }
  if(path==='/api/search-proposals/legacy-turn-migration'&&req.method==='GET'){
    if(role!=='admin')throw new ApiError(403,'既存会話の移行は保守担当だけが使用できます。');
    if([...url.searchParams.keys()].some(key=>!['sessionId','turn'].includes(key))||url.searchParams.getAll('sessionId').length!==1||url.searchParams.getAll('turn').length!==1||!/^\d+$/.test(url.searchParams.get('turn')))throw new ApiError(400,'会話とターンを指定してください。');
    json(res,200,search.inspectLegacyTurn(validateSession(url.searchParams.get('sessionId')),Number(url.searchParams.get('turn'))));return true;
  }
  if(path==='/api/search-proposals/legacy-turn-migration'&&req.method==='POST'){
    if(role!=='admin')throw new ApiError(403,'既存会話の移行は保守担当だけが使用できます。');
    json(res,200,search.migrateLegacyTurn(await body(req)));return true;
  }
  if(path==='/api/search-proposals/cancel-turn'&&req.method==='POST'){
    if(role!=='dsh')throw new ApiError(403,'会話ターンの停止はDSHだけが使用できます。');
    const sessionId=validateSession(req.headers['x-dsh-session']),input=await body(req);
    const proposals=search.cancelTurn(sessionId,input.turn);json(res,200,{sessionId,turn:input.turn,cancelled:proposals.length});return true;
  }
  if(path==='/api/search-proposals/by-request'&&req.method==='GET'){
    if([...url.searchParams.keys()].some(key=>key!=='requestId')||url.searchParams.getAll('requestId').length!==1)throw new ApiError(400,'検索要求IDを一つ指定してください。');
    const sessionId=validateSession(req.headers['x-dsh-session']),result=search.findProposalByRequest(sessionId,url.searchParams.get('requestId'));
    if(result.proposal){if(result.proposal.productionId!=null&&productions.ownerOf(result.proposal.productionId)!==sessionId)throw new ApiError(404,'この会話の検索提案はありません。');ownProposal(result.proposal);}
    json(res,200,result);return true;
  }
  if(path==='/api/search-proposals/recovery'&&req.method==='POST'){
    if(role!=='admin')throw new ApiError(403,'検索受付の復旧は保守担当だけが使用できます。');
    json(res,200,search.abandonProposal(await body(req)));return true;
  }
  if(path==='/api/search-proposals'&&req.method==='GET'){
    const productionId=url.searchParams.get('productionId')??undefined;
    if(productionId)own(productionId);
    const sessionId=role==='dsh'?validateSession(req.headers['x-dsh-session']):undefined;
    const proposals=search.list({productionId,sessionId}).filter(p=>p.productionId==null||productions.ownerOf(p.productionId)===p.sessionId);
    json(res,200,{proposals,enabled:search.enabled!==false});return true;
  }
  if(path==='/api/search-proposals'&&req.method==='POST'){
    const input=await body(req);
    const fencedSession=role==='dsh'?validateSession(req.headers['x-dsh-session']):null;
    const canFence=fencedSession!==null&&typeof input?.requestId==='string'&&/^[-a-zA-Z0-9_]{16,100}$/.test(input.requestId);
    const payloadHash=canFence?createHash('sha256').update(JSON.stringify(input)).digest('hex'):null;
    let proposal,sessionId;
    try{
    if(input.productionId===undefined||input.productionId===null){
      if(role!=='dsh')throw new ApiError(403,'会話単位の検索提案は会話から作成してください。');
    }
    sessionId=input.productionId==null?validateSession(req.headers['x-dsh-session']):own(input.productionId,{mutable:true});
    if(input.sessionId!==undefined&&input.sessionId!==sessionId)throw new ApiError(400,'会話識別子が一致しません。');
    if(role==='dsh'){if(search.requireTurnOwner)search.ensureTurnNumber(sessionId,input.turn);else search.ensureCurrentTurn(sessionId,input.turn);}
    const receiptInput=input.requestId===undefined?{}:{requestId:input.requestId,requestPayloadHash:createHash('sha256').update(JSON.stringify(input)).digest('hex')};
    if(input.kind==='pages'){
      const source=search.status(input.sourceProposalId);
      if(source.sessionId!==sessionId)throw new ApiError(404,'この会話の検索提案はありません。');
      proposal=await search.proposePageReads({productionId:input.productionId??null,sessionId,sourceProposalId:input.sourceProposalId,urls:input.urls,purpose:input.purpose,turn:input.turn,...receiptInput});
    }
    else if(input.kind===undefined||input.kind==='queries')proposal=await search.propose({productionId:input.productionId??null,sessionId,queries:input.queries,engine:input.engine,purpose:input.purpose,turn:input.turn,...receiptInput});
    else throw new ApiError(400,'検索提案の種類が不正です。');
    }catch(error){
      if(canFence&&Number.isInteger(error?.status)&&error.status>=400&&error.status<500){
        let receipt;try{receipt=search.rejectUnadmittedProposal(fencedSession,input.requestId,payloadHash,error.status);}catch{throw new ApiError(503,'検索提案の受付状態を確認できません。再送せず同じ要求を照合してください。');}
        json(res,receipt.httpStatus,{error:'検索提案は受付前に拒否されました。',receipt});return true;
      }
      throw error;
    }
    try{
      const result=input.requestId===undefined?{proposal}:search.findProposalByRequest(sessionId,input.requestId);
      json(res,201,result);return true;
    }catch{
      // The file and receipt may already have committed, even if a following
      // read or response write fails. This is never a definite refusal.
      throw new ApiError(503,'検索提案の受付後の結果を確認できません。再送せず同じ要求を照合してください。');
    }
  }
  const match=path.match(/^\/api\/search-proposals\/([a-f0-9-]{36})(?:\/(approve|run|cancel))?$/);
  if(!match)throw new ApiError(404,'検索APIがありません。');
  const [,id,action]=match,proposal=search.status(id);
  ownProposal(proposal,{mutable:action==='approve'||action==='run'});
  if(!action&&req.method==='GET'){json(res,200,{proposal,enabled:search.enabled!==false});return true;}
  if(action==='cancel'&&req.method==='POST'){await body(req);json(res,200,{proposal:search.cancel(id)});return true;}
  if((action==='approve'||action==='run')&&req.method==='POST'){
    if(role!=='admin')throw new ApiError(403,'検索語・取得先の承認と送信開始は本人画面だけが使用できます。');
    if(search.enabled===false)throw new ApiError(503,'資料検索は無効です。画像生成は利用できます。');
    const input=await body(req);
    ownProposal(proposal,{mutable:true});
    if(typeof input.proposalHash!=='string'||input.proposalHash!==proposal.proposalHash)throw new ApiError(409,'表示した検索提案が一致しません。');
    if(action==='approve'){
      await search.approve(id,{queries:input.queries,urls:input.urls,engine:input.engine,proposalHash:input.proposalHash,actor:'user'});
    }else{
      if(search.status(id).phase!=='approved')throw new ApiError(409,'承認済みで未送信の提案だけを開始できます。');
      const values=proposal.kind==='pages'?'urls':'queries';
      if(input.engine!==proposal.engine||JSON.stringify(input[values])!==JSON.stringify(proposal[values]))throw new ApiError(409,'表示した送信先・検索語が承認内容と一致しません。');
    }
    backgroundSearch(id,proposal.sessionId);
    json(res,202,{proposal:search.status(id)});return true;
  }
  throw new ApiError(405,'この検索操作は対応していません。');
}
