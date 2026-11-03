import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { getMigrations } from 'better-auth/db/migration';
import { createAuth, authOptions, isPublicAuthRoute, awaitResetDelivery } from '../server/auth.mjs';
import { requireAccount, rejectForeignIdentity, requireOwnedJob } from '../server/access.mjs';
import { requireSameOrigin } from '../server/http.mjs';

import { fixture, origin, password } from './auth-fixture.mjs';

test('first password setup is single-use; cookie grants session and logout revokes it',async()=>{
  const f=await fixture();
  const token=await f.setup();
  assert.equal((await f.call('/reset-password',{token,newPassword:password})).status,400);
  const cookie=await f.signIn();
  const session=await (await f.call('/get-session',null,cookie)).json();
  assert.equal(session.user.id,'user-a');
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM pf_verification WHERE identifier LIKE ?').get('%'+token+'%').count,0);
  assert.equal((await f.call('/sign-out',{},cookie)).status,200);
  assert.equal(await (await f.call('/get-session',null,cookie)).json(),null);
  f.database.close();
});

test('reset expires and cannot be reused; successful reset revokes existing sessions',async()=>{
  const f=await fixture();
  await f.setup();
  const oldCookie=await f.signIn();
  await f.call('/request-password-reset',{email:'account-a@example.test'});
  const expiredToken=new URL(f.mail.at(-1).url).searchParams.get('token');
  f.database.prepare('UPDATE pf_verification SET expiresAt = ?').run(Date.now()-1000);
  assert.equal((await f.call('/reset-password',{token:expiredToken,newPassword:password})).status,400);
  await f.call('/request-password-reset',{email:'account-a@example.test'});
  const token=new URL(f.mail.at(-1).url).searchParams.get('token');
  assert.equal((await f.call('/reset-password',{token,newPassword:password})).status,200);
  assert.equal(await (await f.call('/get-session',null,oldCookie)).json(),null);
  assert.equal((await f.call('/reset-password',{token,newPassword:password})).status,400);
  f.database.close();
});

test('concurrent reset requests can consume a token only once',async()=>{
  const f=await fixture();
  await f.call('/request-password-reset',{email:'account-a@example.test'});
  const token=new URL(f.mail.at(-1).url).searchParams.get('token');
  const responses=await Promise.all([f.call('/reset-password',{token,newPassword:password}),f.call('/reset-password',{token,newPassword:password+'2'})]);
  assert.equal(responses.filter(response=>response.status===200).length,1);
  assert.equal(responses.filter(response=>response.status===400).length,1);
  f.database.close();
});

test('two sessions resolve only their own accounts and reject foreign IDs, emails and rows',async()=>{
  const f=await fixture();
  await f.setup(); await f.setup('account-b@example.test');
  const cookieA=await f.signIn(); const cookieB=await f.signIn('account-b@example.test');
  const accounts={findByUserId:async userId=>({accountId:userId==='user-a'?'PF-A':'PF-B',email:userId==='user-a'?'account-a@example.test':'account-b@example.test'})};
  const a=await requireAccount(f.auth,accounts,new Headers({cookie:cookieA}));
  const b=await requireAccount(f.auth,accounts,new Headers({cookie:cookieB}));
  assert.equal(a.account.accountId,'PF-A');assert.equal(b.account.accountId,'PF-B');
  for(const body of [{accountId:'PF-B'},{accountID:'PF-B'},{email:'account-b@example.test'},{rowId:3},{row:3}]) assert.throws(()=>rejectForeignIdentity(body,a.account));
  const jobId='ee40b0c3-edb7-481a-8dae-003e51c40d33';
  const jobs={findOwned:async(accountId,id)=>accountId==='PF-A'&&id===jobId?{jobId}:null};
  assert.equal((await requireOwnedJob(jobs,a.account,jobId)).jobId,jobId);
  await assert.rejects(requireOwnedJob(jobs,b.account,jobId),error=>error.status===404);
  await assert.rejects(requireAccount(f.auth,accounts,new Headers()),error=>error.status===401);
  f.database.close();
});

test('public signup, forged cookies and cross-origin mutation are denied',async()=>{
  const f=await fixture();
  assert.equal(isPublicAuthRoute('/api/auth/sign-up/email','POST'),false);
  assert.equal((await f.call('/sign-up/email',{name:'Unpaid',email:'unpaid@example.test',password})).status,400);
  assert.equal(await (await f.call('/get-session',null,'__Secure-pf.session_token=forged')).json(),null);
  assert.equal((await f.call('/sign-in/email',{email:'account-a@example.test',password},null,'https://attacker.example')).status,403);
  assert.throws(()=>requireSameOrigin(new Request(origin+'/api/account',{method:'POST',headers:{origin:'https://attacker.example'}}),origin));
  f.database.close();
});

test('unknown reset email has a generic response and sends no invitation',async()=>{
  const f=await fixture();
  const response=await f.call('/request-password-reset',{email:'unknown@example.test'});
  assert.equal(response.status,200);
  assert.equal(f.mail.length,0);
  f.database.close();
});

test('library email failures cannot be reported as delivered by the portal or provisioning',async()=>{
  const f=await fixture({failDelivery:true});
  await assert.rejects(awaitResetDelivery(()=>f.call('/request-password-reset',{email:'account-a@example.test'})),error=>error.status===503);
  await assert.rejects(awaitResetDelivery(()=>f.auth.api.requestPasswordReset({body:{email:'account-a@example.test'}}),{required:true}),error=>error.code==='EMAIL_UNAVAILABLE');
  assert.equal(f.mail.length,0);
  f.database.close();
});
