import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './http.mjs';
import { transaction } from './database.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',') + '}';
}

export function repository(database,{applicationData=false}={}) {
  return {
    async findByUserId(userId) {
      const {rows} = await database.query('SELECT c.user_id AS "userId", c.account_id AS "accountId", u.email, u.name, c.baseline_total AS "baselineTotal", c.baseline_tier AS "baselineTier", c.stripe_customer_id AS "stripeCustomerId" FROM pf_customer c JOIN pf_user u ON u.id=c.user_id WHERE c.user_id=$1'+(applicationData?" AND c.status='active' AND EXISTS(SELECT 1 FROM pf_membership m WHERE m.account_id=c.account_id AND m.user_id=c.user_id AND m.active AND m.role='owner')":''), [userId]);
      return rows[0] || null;
    },
    async findOwned(accountId, jobId) {
      const {rows} = await database.query('SELECT job_id AS "jobId", payload FROM pf_job WHERE account_id=$1 AND job_id=$2', [accountId,jobId]);
      return rows[0] || null;
    },
    async registerJob(accountId, jobId, payload) {
      const fingerprint = digest(canonical(payload));
      await database.query('INSERT INTO pf_job(job_id, account_id, fingerprint, payload) VALUES($1,$2,$3,$4) ON CONFLICT(job_id) DO NOTHING',[jobId,accountId,fingerprint,payload]);
      const {rows} = await database.query('SELECT account_id,fingerprint FROM pf_job WHERE job_id=$1',[jobId]);
      if (!rows[0] || rows[0].account_id !== accountId || rows[0].fingerprint !== fingerprint) throw new HttpError(409,'This Job ID is already in use. Refresh your dashboard before submitting.','JOB_CONFLICT');
    },
    async issueTicket(audience, payload) {
      const token = randomBytes(32).toString('base64url');
      const hash=digest(token);
      const commandKey=audience==='services'&&payload.action==='email'&&payload.commandId?'email:'+payload.commandId:null;
      return transaction(database,async connection=>{
        await connection.query("DELETE FROM pf_make_ticket WHERE (command_key IS NULL AND expires_at < now()-interval '1 hour') OR created_at < now()-interval '30 days'");
        if (commandKey) {
          await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[commandKey]);
          const {rows:[existing]}=await connection.query('SELECT token_hash,payload,state,result FROM pf_make_ticket WHERE command_key=$1',[commandKey]);
          if (existing) {
            if (canonical(existing.payload)!==canonical(payload)) throw new HttpError(409,'This message ID is already in use.');
            if (!(existing.state==='completed' && existing.result?.status>=400)) return {hash:existing.token_hash,send:false};
            await connection.query('DELETE FROM pf_make_ticket WHERE command_key=$1',[commandKey]);
          }
        }
        await connection.query("INSERT INTO pf_make_ticket(token_hash,audience,command_key,payload,expires_at) VALUES($1,$2,$3,$4,now()+interval '15 minutes')",[hash,audience,commandKey,payload]);
        return {token,hash,send:true};
      });
    },
    async consumeTicket(token, audience, payload) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
      const result = await database.query("UPDATE pf_make_ticket SET state='claimed' WHERE token_hash=$1 AND audience=$2 AND payload=$3::jsonb AND expires_at>now() AND state='pending' RETURNING token_hash",[digest(token),audience,JSON.stringify(payload)]);
      return result.rowCount === 1;
    },
    async completeTicket(token,status,body) {
      if (typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !Number.isInteger(status) || status<200 || status>599 || !body || typeof body!=='object' || Array.isArray(body)) return false;
      const result=await database.query("UPDATE pf_make_ticket SET state='completed',result=$2 WHERE token_hash=$1 AND audience='services' AND state='claimed' AND expires_at>now()-interval '15 minutes' RETURNING token_hash",[digest(token),{status,body}]);
      return result.rowCount===1;
    },
    async ticketResult(hash) {
      const {rows:[record]}=await database.query('SELECT state,result FROM pf_make_ticket WHERE token_hash=$1',[hash]);
      return record?.state==='completed'?record.result:null;
    },
    async rateLimit(bucket, max, seconds) {
      const key = digest(bucket);
      const {rows} = await database.query(`INSERT INTO pf_request_limit(bucket,window_start,hits) VALUES($1,now(),1)
        ON CONFLICT(bucket) DO UPDATE SET hits=CASE WHEN pf_request_limit.window_start < now()-($2 * interval '1 second') THEN 1 ELSE pf_request_limit.hits+1 END,
        window_start=CASE WHEN pf_request_limit.window_start < now()-($2 * interval '1 second') THEN now() ELSE pf_request_limit.window_start END RETURNING hits`,[key,seconds]);
      if (rows[0].hits > max) throw new HttpError(429,'Too many requests. Please wait and try again.','RATE_LIMITED');
    }
  };
}
