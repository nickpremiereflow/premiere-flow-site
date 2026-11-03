import test from 'node:test';
import assert from 'node:assert/strict';
import { authAudit } from '../server/auth-audit.mjs';
import { fixture, password } from './auth-fixture.mjs';

test('real auth events identify only the affected account and contain no credentials',async()=>{
  const events=[];
  const f=await fixture({audit:async event=>events.push(event)});
  const token=await f.setup();
  assert.deepEqual(events,[
    {action:'auth.reset_email_sent',userId:'user-a'},
    {action:'auth.password_changed',userId:'user-a'}
  ]);
  await f.setup('account-b@example.test');
  events.length=0;
  const cookieA=await f.signIn();
  const cookieB=await f.signIn('account-b@example.test');
  assert.deepEqual(events,[{action:'auth.session_created',userId:'user-a'},{action:'auth.session_created',userId:'user-b'}]);
  assert.equal((await f.call('/sign-out',{},cookieA)).status,200);
  assert.deepEqual(events.at(-1),{action:'auth.session_revoked',userId:'user-a'});
  const count=events.length;
  assert.equal((await f.call('/sign-in/email',{email:'account-a@example.test',password:'wrong-password'})).status,401);
  assert.equal((await f.call('/reset-password',{token,newPassword:password})).status,400);
  assert.equal(events.length,count,'Rejected sign-in/reset cannot emit a successful event');
  await f.call('/request-password-reset',{email:'account-b@example.test'});
  const reset=new URL(f.mail.at(-1).url).searchParams.get('token');
  assert.equal((await f.call('/reset-password',{token:reset,newPassword:password})).status,200);
  assert.equal(await (await f.call('/get-session',null,cookieB)).json(),null);
  assert.ok(events.some(e=>e.action==='auth.session_revoked'&&e.userId==='user-b'));
  assert.deepEqual(events.at(-1),{action:'auth.password_changed',userId:'user-b'});
  const serialized=JSON.stringify(events);
  for(const value of [password,token,reset,cookieA,cookieB,'account-a@example.test']) assert.equal(serialized.includes(value),false);
  assert.ok(events.every(e=>Object.keys(e).sort().join(',')==='action,userId'));
  f.database.close();
});

test('audit persistence derives ownership in SQL and discards all extra fields',async()=>{
  const queries=[];
  const write=authAudit({query:async(sql,params)=>{queries.push({sql,params});return {rowCount:1};}});
  assert.equal(await write({action:'auth.session_created',userId:'user-a',accountId:'FOREIGN',password:'never-record',token:'never-record'}),true);
  assert.match(queries[0].sql,/LEFT JOIN pf_customer c ON c.user_id=u.id WHERE u.id=\$4/);
  assert.deepEqual(queries[0].params.slice(2),['auth.session_created','user-a']);
  assert.equal(JSON.stringify(queries).includes('never-record'),false);
  assert.equal(JSON.stringify(queries).includes('FOREIGN'),false);
  await assert.rejects(write({action:'untrusted.action',userId:'user-a'}));
  await assert.rejects(write({action:'auth.session_created',userId:'not an ID'}));
  assert.equal(queries.length,1);
});

test('audit outage remains visible without breaking logout or password reset',async()=>{
  const logs=[];
  const write=authAudit({query:async()=>{throw new Error('secret=do-not-log-this-provider-error');}},{fallback:value=>logs.push(JSON.parse(value))});
  const f=await fixture({audit:write});
  await f.setup();
  const cookie=await f.signIn();
  assert.equal((await f.call('/sign-out',{},cookie)).status,200);
  assert.equal(await (await f.call('/get-session',null,cookie)).json(),null);
  assert.equal(logs.length,4);
  assert.ok(logs.every(e=>e.code==='AUTH_AUDIT_UNAVAILABLE'&&e.persisted===false&&e.userId==='user-a'));
  assert.equal(JSON.stringify(logs).includes('do-not-log'),false);
  f.database.close();
});
