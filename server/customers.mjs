import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { HttpError } from './http.mjs';

export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new HttpError(400,'Enter a valid email address.');
  const email=value.trim().toLowerCase();
  if (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400,'Enter a valid email address.');
  return email;
}

export function validateLegacyAccount(result,email) {
  if (result?.success!==true || typeof result.found!=='boolean') throw new Error('Account lookup was not confirmed');
  if (!result.found) return null;
  if (result.count!==1 || normalizeEmail(result.email)!==email || typeof result.accountId!=='string' || !/^PF-[A-Za-z0-9-]{3,100}$/.test(result.accountId)) throw new Error('Existing account requires review');
  const unlimited=String(result.totalCredits).toLowerCase()==='unlimited';
  const total=Number(result.totalCredits);
  if (!unlimited && (!String(result.totalCredits).trim() || !Number.isSafeInteger(total) || total<0)) throw new Error('Existing credit total requires review');
  if (typeof result.tier!=='string' || !result.tier.trim()) throw new Error('Existing tier requires review');
  return {accountId:result.accountId,email,name:String(result.name||'Customer').slice(0,100),baselineTotal:unlimited?0:total,baselineTier:unlimited?'Unlimited':result.tier};
}

export function customerService(database,bridge) {
  async function find(email,connection=database) {
    const {rows}=await connection.query('SELECT c.account_id AS "accountId",c.user_id AS "userId",u.email,u.name,c.baseline_total AS "baselineTotal",c.baseline_tier AS "baselineTier" FROM pf_customer c JOIN pf_user u ON u.id=c.user_id WHERE lower(u.email)=$1',[email]);
    return rows[0]||null;
  }
  async function legacy(email) {
    return validateLegacyAccount(await bridge('services',{action:'lookup',email}),email);
  }
  async function insert(connection,account) {
    const userId=randomUUID();
    await connection.query('INSERT INTO pf_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',[userId,account.name,account.email]);
    await connection.query('INSERT INTO pf_customer(account_id,user_id,baseline_total,baseline_tier) VALUES($1,$2,$3,$4)',[account.accountId,userId,account.baselineTotal,account.baselineTier]);
    return {...account,userId};
  }
  async function ensureExisting(value) {
    const email=normalizeEmail(value);
    const current=await find(email);
    if (current) return current;
    const account=await legacy(email);
    if (!account) return null;
    return transaction(database,async connection=>{
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['customer:'+email]);
      return await find(email,connection)||await insert(connection,account);
    });
  }
  // Called only after a verified paid event. A public reset request cannot create
  // a customer that does not already exist in the trusted account database.
  async function ensurePaid(value,name) {
    const email=normalizeEmail(value);
    return await ensureExisting(email)||await transaction(database,async connection=>{
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['customer:'+email]);
      return await find(email,connection)||await insert(connection,{accountId:'PF-'+randomUUID(),email,name:String(name||'Customer').slice(0,100),baselineTotal:0,baselineTier:'Upgrade'});
    });
  }
  return {find,ensureExisting,ensurePaid};
}
