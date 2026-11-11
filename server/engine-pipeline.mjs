import {engineDispatch,engineRequest} from './engine-dispatch.mjs';
import {engineResults} from './engine-results.mjs';
import {engineRecovery} from './engine-recovery.mjs';
import {transaction} from './database.mjs';
import {digest} from './repository.mjs';
import {HttpError} from './http.mjs';
import {escapeHtml} from './delivery.mjs';

export function enginePipeline({database,accounts,bridge,uploads,baseURL,acceptanceAccount}) {
  const dispatch=engineDispatch(database),finish=engineResults(database),recover=engineRecovery(database,{accountId:acceptanceAccount});
  const allowed=account=>{
    if(acceptanceAccount&&account.accountId!==acceptanceAccount) throw new HttpError(503,'Submissions are temporarily paused. Your credits are safe.','SUBMISSIONS_PAUSED');
  };
  async function send(payload) {
    try {await bridge('engine',payload,{acceptedOnly:true});return true;}
    catch {
      // Durable acceptance is not undone by a missing network acknowledgement.
      // A bounded worker can resend; pf_claim_engine admits only one delivery.
      await database.query(`INSERT INTO pf_audit_event(event_key,account_id,job_id,action,details)
        VALUES($1,$2,$3,'engine.awaiting_claim',$4) ON CONFLICT(event_key) DO NOTHING`,
        ['dispatch-pending:'+payload.jobId+':'+(payload.expectedAttempt||'0'),payload.accountId,payload.jobId,{reason:'Transport did not confirm acceptance'}]);
      return false;
    }
  }
  async function submit(account,input) {
    allowed(account);
    const payload=engineRequest(account,input);
    if(input.action==='submit'&&!await accounts.findOwned(account.accountId,payload.jobId)) {
      await uploads.group(account,payload.uploadcareUrl,payload.thumbnail);
    }
    const accepted=await dispatch.enqueue(account,input);
    if(['ACCEPTED','RETRYING'].includes(accepted.status)) await send(payload);
    return {success:true,jobId:accepted.jobId,status:accepted.status,attempt:accepted.attempt};
  }
  async function notify(commandId) {
    // Use a short transaction to obtain a lease, not a DB lock during email I/O.
    const command=await transaction(database,async client=>{
      const {rows:[row]}=await client.query(`UPDATE pf_command SET state='running',lease_until=now()+interval '2 minutes',attempt_count=attempt_count+1
        WHERE command_id=$1 AND kind='job_notification' AND state<>'done' AND retry_at<=now()
          AND (state='pending' OR lease_until<now()) AND attempt_count<3
          AND ($2::text IS NULL OR account_id=$2) RETURNING *`,[commandId,acceptanceAccount||null]);
      return row;
    });
    if(!command) return {delivered:false};
    try {
      const {rows:[job]}=await database.query(`SELECT j.*,u.email FROM pf_job j JOIN pf_customer c ON c.account_id=j.account_id JOIN pf_user u ON u.id=c.user_id
        WHERE j.job_id=$1 AND j.account_id=$2`,[command.payload.jobId,command.account_id]);
      if(!job||job.attempt_count!==command.payload.attempt||job.status!==command.payload.status) {
        await database.query("UPDATE pf_command SET state='done',result=$2,finished_at=now() WHERE command_id=$1",[commandId,{skipped:true,reason:'Superseded attempt'}]);
        return {delivered:false,superseded:true};
      }
      const completed=job.status==='COMPLETED';
      const result=await bridge('services',{action:'email',commandId,email:job.email,
        subject:completed?'Your showroom images are ready — '+job.vehicle_name:'Your PremiereFlow listing needs attention',
        html:`<p>${completed?'Your showroom images for <strong>'+escapeHtml(job.vehicle_name)+'</strong> are ready.':'We could not finish <strong>'+escapeHtml(job.vehicle_name)+'</strong>. Your listing credit has been released.'}</p><p><a href="${escapeHtml(baseURL)}/dashboard/">${completed?'View images and download your package':'Open your listing for details and retry instructions'}</a></p><p>PremiereFlow<br>info@premiereflow.com</p>`});
      if(result.delivery!=='sent') throw new Error('Unconfirmed delivery');
      await database.query("UPDATE pf_command SET state='done',result=$2,finished_at=now(),lease_until=NULL,last_error=NULL WHERE command_id=$1",[commandId,{delivery:'sent',messageId:result.messageId||null}]);
      return {delivered:true};
    } catch {
      await database.query("UPDATE pf_command SET state='pending',lease_until=NULL,retry_at=now()+interval '5 minutes',last_error='Email delivery not confirmed; listing result and credits unchanged' WHERE command_id=$1",[commandId]);
      return {delivered:false,pending:true};
    }
  }
  async function notifyResult(token,jobId,attempt) {
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(403,'Request authorization failed.');
    const {rows:[result]}=await database.query('SELECT pf_engine_result_context($1,$2,$3) AS result',[digest(token),jobId,attempt]);
    if(!result?.result?.resultFingerprint) throw new HttpError(403,'Request authorization failed.');
    return notify('job-result:'+jobId+':'+attempt);
  }
  async function maintenance() {
    const recovered=await recover();
    // One pending delivery per tick bounds workload and avoids generation bursts.
    const {rows:[pending]}=await database.query(`UPDATE pf_engine_dispatch SET updated_at=now()
      WHERE (job_id,attempt) IN (SELECT job_id,attempt FROM pf_engine_dispatch WHERE state='pending'
        AND updated_at<now()-interval '1 minute' AND ($1::text IS NULL OR account_id=$1)
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING payload`,[acceptanceAccount||null]);
    if(pending) await send(pending.payload);
    const {rows:[email]}=await database.query(`SELECT command_id FROM pf_command WHERE kind='job_notification' AND state<>'done'
      AND retry_at<=now() AND (state='pending' OR lease_until<now()) AND attempt_count<3
      AND ($1::text IS NULL OR account_id=$1) ORDER BY created_at LIMIT 1`,[acceptanceAccount||null]);
    const delivery=email?await notify(email.command_id):null;
    return {...recovered,dispatched:!!pending,delivery};
  }
  async function claim(token,payload) {
    if(acceptanceAccount&&payload?.accountId!==acceptanceAccount) return null;
    return dispatch.claim(token,payload);
  }
  return {submit,claim,finish,notifyResult,maintenance};
}
