import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { getMigrations } from 'better-auth/db/migration';
import { createAuth, authOptions, isPublicAuthRoute } from '../server/auth.mjs';

export const origin = 'https://premiereflow.test';
export const password = 'Controlled acceptance password 2026!';
export async function fixture({failDelivery=false}={}) {
  const database = new DatabaseSync(':memory:');
  const mail = [];
  const config = {database, baseURL:origin, secret:randomBytes(48).toString('base64url'), sendPasswordReset: async message => {if(failDelivery)throw new Error('Controlled email outage');mail.push(message);} };
  await (await getMigrations(authOptions(config))).runMigrations();
  const auth = createAuth(config);
  for (const [id,email] of [['user-a','account-a@example.test'],['user-b','account-b@example.test']]) {
    database.prepare('INSERT INTO pf_user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)').run(id,id,email,Date.now(),Date.now());
  }
  async function call(path, body, cookie, customOrigin = origin) {
    const headers = new Headers({'x-real-ip':'192.0.2.10'});
    if (cookie) headers.set('cookie',cookie);
    if (body) {headers.set('content-type','application/json');headers.set('origin',customOrigin);}
    return auth.handler(new Request(origin+'/api/auth'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined}));
  }
  async function setup(email='account-a@example.test') {
    assert.equal((await call('/request-password-reset',{email})).status,200);
    const token = new URL(mail.at(-1).url).searchParams.get('token');
    const response = await call('/reset-password',{token,newPassword:password});
    assert.equal(response.status,200);
    return token;
  }
  async function signIn(email='account-a@example.test') {
    const response = await call('/sign-in/email',{email,password});
    assert.equal(response.status,200);
    const cookie = response.headers.getSetCookie().find(value=>value.startsWith('__Secure-pf.session_token='));
    assert.ok(cookie);
    assert.match(cookie,/HttpOnly/i);
    assert.match(cookie,/Secure/i);
    assert.match(cookie,/SameSite=Lax/i);
    return cookie.split(';')[0];
  }
  return {auth,database,mail,call,setup,signIn};
}
