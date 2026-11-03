import test from 'node:test';
import assert from 'node:assert/strict';
import {engineRequest,engineDispatch} from '../server/engine-dispatch.mjs';
import {digest} from '../server/repository.mjs';

const account={userId:'fixture-owner',accountId:'PF-ACCEPTANCE-A-20261103',email:'nick+pf-auth-a@premiereflow.com'};
const input={action:'submit',jobId:'C0000000-0000-4000-8000-000000000008',vehicleName:'Controlled vehicle',assetSource:'Upload',showroomColor:'White (default)',logoPlacement:'No Logo',thumbnail:'',uploadcareUrl:'https://5zzyp2gsg2.ucarecd.net/c0000000-0000-4000-8000-000000000008~1/'};

test('engine intake uses session identity and rejects forged identity or storage URLs',()=>{
 const request=engineRequest(account,input);
 assert.equal(request.accountId,account.accountId);
 assert.equal(request.jobId,input.jobId.toLowerCase());
 assert.equal(request.expectedAttempt,'');
 assert.equal(request.sendEmail,'true');
 for(const changed of [{accountId:'PF-OTHER'},{email:'other@example.com'},{userId:'other'},{row:2},{sendEmail:'false'},{uploadcareUrl:'https://attacker.example/a~1/'}]) {
   assert.throws(()=>engineRequest(account,{...input,...changed}),e=>e.status===400);
 }
 assert.throws(()=>engineRequest({...account,userId:''},input),e=>e.status===403);
});

test('same-job retry cannot replace original assets or start an unbounded attempt',()=>{
 const retry={action:'retry',jobId:input.jobId,expectedAttempt:1};
 const request=engineRequest(account,retry);
 assert.equal(request.expectedAttempt,'1');
 assert.equal(request.uploadcareUrl,'');
 assert.throws(()=>engineRequest(account,{...retry,uploadcareUrl:input.uploadcareUrl}),e=>e.status===400);
 for(const expectedAttempt of [0,3,4,-1,1.5,'1']) assert.throws(()=>engineRequest(account,{...retry,expectedAttempt}),e=>e.status===409);
});

test('enqueue calls one atomic database operation; SQL failures do not imply accepted work',async()=>{
 const calls=[];
 const db={query:async(sql,args)=>{calls.push({sql,args});return {rows:[{result:{jobId:input.jobId.toLowerCase(),attempt:1,status:'ACCEPTED',created:true}}]};}};
 const result=await engineDispatch(db).enqueue(account,input);
 assert.equal(result.created,true);
 assert.equal(calls.length,1);
 assert.equal(calls[0].args[0],account.accountId);
 assert.equal(calls[0].args[1],account.userId);
 assert.match(calls[0].args[3],/^[0-9a-f]{64}$/);
 for(const [message,status] of [['NO_CREDITS',409],['ACCOUNT_UNAVAILABLE',403],['JOB_CONFLICT',409],['JOB_NOT_FOUND',404]]) {
   db.query=async()=>{throw new Error(message);};
   await assert.rejects(engineDispatch(db).enqueue(account,input),e=>e.status===status);
 }
});

test('engine claim sends only a token hash to storage and rejects malformed tokens',async()=>{
 let calls=0;
 const token='a'.repeat(43);const payload=engineRequest(account,input);
 const db={query:async(sql,args)=>{calls++;assert.equal(args[0],digest(token));assert.equal(JSON.stringify(args).includes(token),false);return {rows:[{result:{authorized:true,attempt:1}}]};}};
 const store=engineDispatch(db);
 for(const malformed of ['',null,'x'.repeat(42),' '.repeat(43)]) assert.equal(await store.claim(malformed,payload),null);
 assert.equal(calls,0);
 assert.equal((await store.claim(token,payload)).authorized,true);
 db.query=async()=>({rows:[{result:null}]});
 assert.equal(await store.claim(token,payload),null);
});
