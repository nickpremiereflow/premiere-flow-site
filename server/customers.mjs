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

export function customerService(database,bridge,{applicationData=false}={}) {
  const customerSelect='SELECT c.account_id AS "accountId",c.user_id AS "userId",u.email,u.name,c.stripe_customer_id AS "stripeCustomerId",c.baseline_total AS "baselineTotal",c.baseline_tier AS "baselineTier" FROM pf_customer c JOIN pf_user u ON u.id=c.user_id';
  async function find(email,connection=database) {
    const {rows}=await connection.query(customerSelect+' WHERE lower(u.email)=$1',[email]);
    return rows[0]||null;
  }
  async function legacy(email) {
    return validateLegacyAccount(await bridge('services',{action:'lookup',email}),email);
  }
  async function insert(connection,account) {
    const userId=randomUUID();
    await connection.query('INSERT INTO pf_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',[userId,account.name,account.email]);
    await connection.query('INSERT INTO pf_customer(account_id,user_id,baseline_total,baseline_tier) VALUES($1,$2,$3,$4)',[account.accountId,userId,account.baselineTotal,account.baselineTier]);
    if (applicationData) {
      await connection.query("INSERT INTO pf_membership(account_id,user_id,role) VALUES($1,$2,'owner')",[account.accountId,userId]);
      await connection.query("INSERT INTO pf_audit_event(account_id,actor_user_id,action,details) VALUES($1,$2,'account.created',$3)",[account.accountId,userId,{source:'verified_provisioning'}]);
    }
    return {...account,userId};
  }
  async function ensureExisting(value) {
    const email=normalizeEmail(value);
    const current=await find(email);
    if (current) return current;
    if (applicationData) return null;
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
  // A signed-in purchase uses the server's owner identity and one stable Stripe
  // customer. The idempotency key also survives a crash after Stripe creation.
  async function checkoutCustomer(account,create) {
    return transaction(database,async connection=>{
      const {rows:[current]}=await connection.query(customerSelect+" WHERE c.account_id=$1 AND c.user_id=$2 AND c.status='active' FOR UPDATE OF c",[account.accountId,account.userId]);
      if (!current) throw new HttpError(403,'This account is not available.');
      if (current.stripeCustomerId) return current.stripeCustomerId;
      const created=await create(current,'pf-customer:'+current.accountId);
      if (!/^cus_[A-Za-z0-9]+$/.test(created?.id||'')) throw new Error('Billing customer was not confirmed');
      await connection.query('UPDATE pf_customer SET stripe_customer_id=$2 WHERE account_id=$1',[current.accountId,created.id]);
      await connection.query('INSERT INTO pf_billing_customer(stripe_customer_id,account_id) VALUES($1,$2)',[created.id,current.accountId]);
      return created.id;
    });
  }
  // Prefer a durable Stripe relationship over the payer's editable billing email.
  // An anonymous repeat purchase can add credits to the existing email account,
  // but cannot replace its login, owner, or canonical billing customer.
  async function resolvePaidPurchase(purchase) {
    if (!/^cus_[A-Za-z0-9]+$/.test(purchase.customerId||'')) throw new Error('Payment customer missing');
    if (!applicationData) await ensureExisting(purchase.email);
    return transaction(database,async connection=>{
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['billing-customer:'+purchase.customerId]);
      const {rows:linked}=await connection.query(customerSelect+' WHERE c.stripe_customer_id=$1 OR EXISTS(SELECT 1 FROM pf_billing_customer b WHERE b.account_id=c.account_id AND b.stripe_customer_id=$1)',[purchase.customerId]);
      if (linked.length>1) throw new Error('Billing customer has conflicting account relationships');
      if (linked[0]) {
        if (purchase.accountId && linked[0].accountId!==purchase.accountId) throw new Error('Payment account ownership conflict');
        return linked[0];
      }
      // Account metadata is set only by our authenticated Checkout API. A paid
      // event cannot name an account without its previously bound Stripe customer.
      if (purchase.accountId) throw new Error('Payment account relationship was not confirmed');
      const email=normalizeEmail(purchase.email);
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['customer:'+email]);
      const current=await find(email,connection)||await insert(connection,{accountId:'PF-'+randomUUID(),email,name:String(purchase.name||'Customer').slice(0,100),baselineTotal:0,baselineTier:'Upgrade'});
      await connection.query('UPDATE pf_customer SET stripe_customer_id=COALESCE(stripe_customer_id,$2) WHERE account_id=$1',[current.accountId,purchase.customerId]);
      await connection.query('INSERT INTO pf_billing_customer(stripe_customer_id,account_id) VALUES($1,$2)',[purchase.customerId,current.accountId]);
      return current;
    });
  }
  return {find,ensureExisting,ensurePaid,checkoutCustomer,resolvePaidPurchase};
}
