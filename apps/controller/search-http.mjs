import {ApiError} from './store.mjs';
import {validateSession} from './productions.mjs';

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
    search.registerUserTurn(sessionId,input.turn);json(res,200,{sessionId,turn:input.turn});return true;
  }
  if(path==='/api/search-proposals/cancel-turn'&&req.method==='POST'){
    if(role!=='dsh')throw new ApiError(403,'会話ターンの停止はDSHだけが使用できます。');
    const sessionId=validateSession(req.headers['x-dsh-session']),input=await body(req);
    const proposals=search.cancelTurn(sessionId,input.turn);json(res,200,{sessionId,turn:input.turn,cancelled:proposals.length});return true;
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
    if(input.productionId===undefined||input.productionId===null){
      if(role!=='dsh')throw new ApiError(403,'会話単位の検索提案は会話から作成してください。');
    }
    const sessionId=input.productionId==null?validateSession(req.headers['x-dsh-session']):own(input.productionId,{mutable:true});
    if(input.sessionId!==undefined&&input.sessionId!==sessionId)throw new ApiError(400,'会話識別子が一致しません。');
    if(role==='dsh')search.ensureCurrentTurn(sessionId,input.turn);
    let proposal;
    if(input.kind==='pages'){
      const source=search.status(input.sourceProposalId);
      if(source.sessionId!==sessionId)throw new ApiError(404,'この会話の検索提案はありません。');
      proposal=search.proposePageReads({productionId:input.productionId??null,sessionId,sourceProposalId:input.sourceProposalId,urls:input.urls,purpose:input.purpose,turn:input.turn});
    }
    else if(input.kind===undefined||input.kind==='queries')proposal=search.propose({productionId:input.productionId??null,sessionId,queries:input.queries,engine:input.engine,purpose:input.purpose,turn:input.turn});
    else throw new ApiError(400,'検索提案の種類が不正です。');
    json(res,201,{proposal});return true;
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
      search.approve(id,{queries:input.queries,urls:input.urls,engine:input.engine,proposalHash:input.proposalHash,actor:'user'});
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
