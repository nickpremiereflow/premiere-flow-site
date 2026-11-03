import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortal } from '../server/portal.mjs';
import { HttpError } from '../server/http.mjs';
import { canonical, digest } from '../server/repository.mjs';
import { makeBridge } from '../server/make.mjs';
import { fixture, origin } from './auth-fixture.mjs';

const jobA='ee40b0c3-edb7-481a-8dae-003e51c40d33';
const jobB='be40b0c3-edb7-481a-8dae-003e51c40d33';
const freshJob='ce40b0c3-edb7-481a-8dae-003e51c40d33';
async function portalFixture({applicationMode=false,payments}={}) {
  const f=await fixture();
  await f.setup(); await f.setup('account-b@example.test');
  const cookies={a:await f.signIn(),b:await f.signIn('account-b@example.test')};
  const calls=[];const jobs=new Map();const tickets=new Map();
  const accounts={
    'user-a':{accountId:'PF-A',email:'account-a@example.test'},
    'user-b':{accountId:'PF-B',email:'account-b@example.test'}
  };
  const data={
    'PF-A':{success:true,accountId:'PF-A',credits:9,listings:[{jobId:jobA,status:'FAILED',attemptCount:1}]},
    'PF-B':{success:true,accountId:'PF-B',credits:10,listings:[{jobId:jobB,status:'COMPLETED',attemptCount:1}]}
  };
  const repository={
    findByUserId:async id=>accounts[id],rateLimit:async()=>{},
    findOwned:async(accountId,id)=>jobs.get(id)?.accountId===accountId?jobs.get(id):null,
    registerJob:async(accountId,id,payload)=>{
      const fingerprint=digest(canonical(payload));
      if (jobs.has(id) && (jobs.get(id).fingerprint!==fingerprint || jobs.get(id).accountId!==accountId)) throw new HttpError(409,'Job conflict');
      jobs.set(id,{accountId,fingerprint,payload});
    },
    consumeTicket:async(ticket,audience,payload)=>{
      const record=tickets.get(ticket);
      if (!record || record.audience!==audience || canonical(record.payload)!==canonical(payload)) return false;
      tickets.delete(ticket);return true;
    }
  };
  const bridge=async(audience,payload)=>{
    calls.push({audience,payload});
    if (audience==='account' && payload.action==='read') return data[payload.accountId];
    return {success:true,status:audience==='engine'?'queued':undefined,jobId:payload.jobId};
  };
  const applicationData=applicationMode?{read:async account=>data[account.accountId],write:async(account,action,payload)=>{calls.push({audience:'neon',payload:{...payload,action,accountId:account.accountId}});return {success:true};}}:undefined;
  const handler=createPortal({auth:f.auth,repository,bridge,baseURL:origin,ensureExistingAccount:async()=>{},applicationData,payments,submissionsEnabled:true});
  const call=(path,{body,cookie=cookies.a,method=body?'POST':'GET',requestOrigin=origin}={})=>handler(new Request(origin+path,{
    method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json',origin:requestOrigin}:{}),'x-real-ip':'192.0.2.14'},body:body?JSON.stringify(body):undefined
  }));
  return {...f,cookies,calls,data,jobs,tickets,call};
}

test('real sessions return only their own dashboard and never expose a session token',async()=>{
  const f=await portalFixture();
  for(const key of ['a','b']){
    const response=await f.call('/api/account',{cookie:f.cookies[key]});
    assert.equal(response.status,200);
    const account=await response.json();
    assert.equal(account.accountId,key==='a'?'PF-A':'PF-B');
    assert.equal(account.listings[0].jobId,key==='a'?jobA:jobB);
    const session=await (await f.call('/api/auth/get-session',{cookie:f.cookies[key]})).json();
    assert.deepEqual(Object.keys(session),['user']);
    assert.equal('token' in session.user,false);
  }
  assert.equal((await f.call('/api/account',{cookie:''})).status,401);
  assert.equal((await f.call('/api/account',{cookie:'__Secure-pf.session_token=forged'})).status,401);
  f.database.close();
});

test('cross-account identity and foreign job mutations are rejected before any write',async()=>{
  const f=await portalFixture();
  for(const query of ['email=account-b%40example.test','accountId=PF-B','accountID=PF-B','row=3','rowId=3']) assert.equal((await f.call('/api/account?'+query)).status,query.startsWith('row')?400:403);
  for(const body of [{action:'update_name',newName:'Attack',email:'account-b@example.test'},{action:'update_name',newName:'Attack',accountId:'PF-B'},{action:'rename_listing',newName:'Attack',row:3}]) assert.equal((await f.call('/api/account',{body})).status,'row' in body?400:403);
  assert.equal((await f.call('/api/account',{body:{action:'rename_listing',newName:'Attack',jobId:jobB}})).status,404);
  assert.equal((await f.call('/api/jobs',{body:{action:'retry',jobId:jobB,expectedAttempt:1}})).status,404);
  assert.equal(f.calls.filter(c=>c.payload.action!=='read').length,0);
  f.database.close();
});

test('own profile and job writes derive identity from the session; CSRF is rejected',async()=>{
  const f=await portalFixture();
  assert.equal((await f.call('/api/account',{body:{action:'update_name',newName:'Updated customer'}})).status,200);
  assert.equal(f.calls.at(-1).payload.accountId,'PF-A');
  assert.equal((await f.call('/api/account',{body:{action:'rename_listing',newName:'Updated car',jobId:jobA}})).status,200);
  assert.equal(f.calls.at(-1).payload.jobId,jobA);
  const writes=f.calls.length;
  assert.equal((await f.call('/api/account',{requestOrigin:'https://attacker.test',body:{action:'update_name',newName:'Attack'}})).status,403);
  assert.equal(f.calls.length,writes);
  f.database.close();
});

test('submission repeats retain one ID; another payload or owner cannot reuse it',async()=>{
  const f=await portalFixture();
  const body={action:'submit',jobId:freshJob,vehicleName:'Controlled test',assetSource:'Upload',showroomColor:'Black',logoPlacement:'No Logo',thumbnail:'',uploadcareUrl:'https://5zzyp2gsg2.ucarecd.net/12bc7a7c-8c17-4643-8e14-dde32b95968e~1/'};
  assert.equal((await f.call('/api/jobs',{body})).status,202);
  assert.equal((await f.call('/api/jobs',{body})).status,202);
  assert.equal(f.jobs.size,1);
  assert.equal((await f.call('/api/jobs',{body:{...body,vehicleName:'Changed'}})).status,409);
  assert.equal((await f.call('/api/jobs',{body,cookie:f.cookies.b})).status,409);
  assert.equal(f.jobs.size,1);
  assert.equal(f.calls.filter(c=>c.audience==='engine').length,2);
  f.database.close();
});

test('retry is bounded, waits for provider timing and reuses the owned job',async()=>{
  const f=await portalFixture();
  const body={action:'retry',jobId:jobA,expectedAttempt:1};
  f.data['PF-A'].listings[0].nextRetryAt=new Date(Date.now()+60000).toISOString();
  assert.equal((await f.call('/api/jobs',{body})).status,409);
  f.data['PF-A'].listings[0].nextRetryAt='';
  assert.equal((await f.call('/api/jobs',{body})).status,202);
  assert.deepEqual(f.calls.at(-1).payload,{email:'account-a@example.test',accountId:'PF-A',action:'retry',jobId:jobA,expectedAttempt:'1'});
  assert.equal(f.jobs.size,0);
  f.data['PF-A'].listings[0].attemptCount=3;
  assert.equal((await f.call('/api/jobs',{body:{...body,expectedAttempt:3}})).status,409);
  assert.equal((await f.call('/api/jobs',{body})).status,409);
  f.database.close();
});

test('backend outage, malformed credits and mismatched account return failure, not empty data',async()=>{
  const f=await portalFixture();
  for(const value of [{success:false},{success:true,accountId:'PF-B',credits:0,listings:[]},{success:true,accountId:'PF-A',credits:'',listings:[]}]) {
    f.data['PF-A']=value;
    const response=await f.call('/api/account');assert.equal(response.status,503);
    const result=await response.json();assert.equal(result.success,false);assert.equal('credits' in result,false);
  }
  assert.equal((await f.call('/api/support',{body:{requestId:freshJob,subject:'Help',message:'A controlled test'}})).status,503);
  f.database.close();
});

test('Make authorization binds the entire payload and rejects replay',async()=>{
  const f=await portalFixture();
  const body={ticket:'controlled-ticket',audience:'account',payload:{accountId:'PF-A',action:'read'}};
  f.tickets.set(body.ticket,{audience:body.audience,payload:body.payload});
  assert.equal((await f.call('/api/internal/make/authorize',{cookie:'',body:{...body,payload:{accountId:'PF-B',action:'read'}}})).status,403);
  assert.equal((await f.call('/api/internal/make/authorize',{cookie:'',body})).status,200);
  assert.equal((await f.call('/api/internal/make/authorize',{cookie:'',body})).status,403);
  f.database.close();
});

test('Make transport refuses an unconfirmed write or a failed HTTP response',async()=>{
  const repo={issueTicket:async()=> 'controlled-ticket'};
  for(const response of [new Response('Accepted'),Response.json({success:false}),new Response('failed',{status:500})]){
    const bridge=makeBridge(repo,{account:'https://hook.us2.make.com/controlled'},async()=>response);
    await assert.rejects(bridge('account',{action:'update_name'}),error=>error.status===503);
  }
});

test('sequential account services wait for a confirmed result and reuse a delivered email',async()=>{
  let calls=0;
  const sent={status:200,body:{success:true,delivery:'sent'}};
  const repo={issueTicket:async()=>({hash:'controlled-hash',send:false}),ticketResult:async()=>sent};
  const bridge=makeBridge(repo,{services:'https://hook.us2.make.com/controlled'},async()=>{calls++;return new Response('Accepted');});
  assert.equal((await bridge('services',{action:'email',commandId:'same-message'})).delivery,'sent');
  assert.equal(calls,0);
  repo.ticketResult=async()=>({status:503,body:{success:false}});
  await assert.rejects(bridge('services',{action:'email',commandId:'failed-message'}),error=>error.status===503);
});

test('a lost Make acknowledgement can still confirm delivery through the durable callback',async()=>{
  const repo={issueTicket:async()=>({token:'controlled',hash:'controlled-hash',send:true}),ticketResult:async()=>({status:200,body:{success:true,delivery:'sent'}})};
  const bridge=makeBridge(repo,{services:'https://hook.us2.make.com/controlled'},async()=>{throw new Error('Connection lost after acceptance');});
  assert.equal((await bridge('services',{action:'email',commandId:'same-message'})).delivery,'sent');
});

test('protected Preview callback identity stays out of durable tickets and other workflows',async()=>{
  const token='synthetic-short-lived-oidc-identity-for-tests';
  let stored,wire,identityRequests=0;
  const repo={issueTicket:async(a,p)=>{stored=p;return {token:'one-use-ticket',hash:'hash',send:true};},ticketResult:async()=>({status:200,body:{success:true,delivery:'sent'}})};
  const bridge=makeBridge(repo,{services:'https://hook.us2.make.com/controlled',account:'https://hook.us2.make.com/controlled'},async(url,request)=>{wire=JSON.parse(request.body);return Response.json({success:true});},{callbackAuthorization:async()=>{identityRequests++;return token;}});
  await bridge('services',{action:'email',commandId:'preview-identity'});
  assert.equal(wire.callbackOidcToken,token);
  assert.equal(JSON.stringify(stored).includes(token),false);
  await bridge('account',{action:'read'});
  assert.equal('callbackOidcToken' in wire,false);
  assert.equal(identityRequests,1);
  repo.issueTicket=async()=>({hash:'hash',send:false});
  await bridge('services',{action:'email',commandId:'preview-identity'});
  assert.equal(identityRequests,1);
});

test('missing protected callback identity fails before sending an email request',async()=>{
  let sends=0;
  const repo={issueTicket:async()=>({token:'one-use-ticket',hash:'hash',send:true})};
  const bridge=makeBridge(repo,{services:'https://hook.us2.make.com/controlled'},async()=>{sends++;},{callbackAuthorization:async()=>undefined});
  await assert.rejects(bridge('services',{action:'email'}),error=>error.status===503);
  assert.equal(sends,0);
});


test('Neon account path keeps session ownership, preserves empty accounts, and never calls the legacy bridge',async()=>{
  const f=await portalFixture({applicationMode:true});
  f.data['PF-B'].listings=[];
  for (const key of ['a','b']) {
    const response=await f.call('/api/account',{cookie:f.cookies[key]});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.accountId,key==='a'?'PF-A':'PF-B');
    assert.equal(body.listings.length,key==='a'?1:0);
  }
  assert.equal(f.calls.length,0);
  assert.equal((await f.call('/api/account?accountId=PF-B')).status,403);
  assert.equal((await f.call('/api/account',{body:{action:'rename_listing',newName:'Foreign',jobId:jobB}})).status,404);
  assert.equal((await f.call('/api/account',{body:{action:'update_name',newName:'Verified owner'}})).status,200);
  assert.deepEqual(f.calls,[{audience:'neon',payload:{newName:'Verified owner',action:'update_name',accountId:'PF-A'}}]);
  f.data['PF-A']={success:false};
  assert.equal((await f.call('/api/account')).status,503);
  f.database.close();
});


test('Checkout owner comes from the session and rejects a caller-supplied account',async()=>{
  const received=[];
  const f=await portalFixture({payments:{checkout:async(offer,account)=>{received.push({offer,account});return Response.json({success:true});}}});
  assert.equal((await f.call('/api/checkout',{body:{offer:'partner'}})).status,200);
  assert.equal(received[0].account.accountId,'PF-A');
  assert.equal((await f.call('/api/checkout',{body:{offer:'partner',accountId:'PF-B'}})).status,400);
  assert.equal(received.length,1);
  assert.equal((await f.call('/api/checkout',{cookie:'',body:{offer:'upgrade'}})).status,200);
  assert.equal(received[1].account,null);
  f.database.close();
});
