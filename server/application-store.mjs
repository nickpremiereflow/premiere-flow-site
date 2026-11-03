import {transaction} from './database.mjs';
import {HttpError} from './http.mjs';
import {entitlement} from './ledger.mjs';

// This adapter is opt-in until migration parity and the engine bridge are verified.
// Ownership comes from the authenticated server account, never a Sheet row/email.
export function applicationStore(database,catalog) {
  async function read(account) {
    return transaction(database,async connection=>{
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const {rows:[customer]}=await connection.query(`SELECT c.*,u.email,u.name,b.available,b.reserved,b.consumed
        FROM pf_customer c JOIN pf_user u ON u.id=c.user_id JOIN pf_credit_balance b ON b.account_id=c.account_id
        WHERE c.account_id=$1 AND c.status='active'`,[account.accountId]);
      if (!customer || customer.user_id!==account.userId) throw new HttpError(403,'This account is not accessible.','FORBIDDEN');
      const {rows:purchases}=await connection.query('SELECT * FROM pf_purchase WHERE account_id=$1',[account.accountId]);
      const {rows:subscriptions}=await connection.query('SELECT * FROM pf_subscription WHERE account_id=$1',[account.accountId]);
      const current=entitlement(customer,purchases,subscriptions,catalog);
      const {rows:listings}=await connection.query(`SELECT j.job_id AS "jobId",j.vehicle_name AS vehicle,j.created_at AS date,
        j.status,j.source_url AS originals,CASE WHEN j.status='COMPLETED' THEN j.output_url ELSE '' END AS staged,
        j.thumbnail_url AS thumbnail,j.attempt_count AS "attemptCount",j.next_retry_at AS "nextRetryAt",
        j.error_details AS error,j.error_code AS "errorCode",j.error_stage AS "errorStage",j.updated_at AS "updatedAt",
        j.expected_images AS "expectedImages",j.stored_images AS "storedImages",j.qa_status AS "qaStatus",
        j.showroom_color AS "showroomColor",j.logo_placement AS "logoPlacement",r.state AS "creditState"
        FROM pf_job j LEFT JOIN pf_credit_reservation r ON r.job_id=j.job_id
        WHERE j.account_id=$1 ORDER BY j.created_at,j.job_id`,[account.accountId]);
      if (!Number.isSafeInteger(customer.available) || customer.available<0) throw new HttpError(503,'Your credit balance needs review. Please contact support.','CREDITS_UNAVAILABLE');
      return {success:true,accountId:account.accountId,email:customer.email,name:customer.display_name||customer.name,
        tier:current.tier,credits:current.totalCredits==='Unlimited'?'Unlimited':customer.available,
        reservedCredits:customer.reserved,consumedCredits:customer.consumed,logo:customer.logo_url,listings};
    });
  }
  async function write(account,action,payload) {
    return transaction(database,async connection=>{
      const {rows:[customer]}=await connection.query("SELECT user_id FROM pf_customer WHERE account_id=$1 AND status='active' FOR UPDATE",[account.accountId]);
      if (!customer || customer.user_id!==account.userId) throw new HttpError(403,'This account is not accessible.','FORBIDDEN');
      let jobId=null;
      if (action==='update_name') {
        await connection.query('UPDATE pf_customer SET display_name=$2,updated_at=now() WHERE account_id=$1',[account.accountId,payload.newName]);
        await connection.query('UPDATE pf_user SET name=$2,"updatedAt"=now() WHERE id=$1',[account.userId,payload.newName]);
      } else if (action==='rename_listing') {
        jobId=payload.jobId;
        const result=await connection.query('UPDATE pf_job SET vehicle_name=$3,updated_at=now() WHERE account_id=$1 AND job_id=$2 RETURNING job_id',[account.accountId,jobId,payload.newName]);
        if(result.rowCount!==1)throw new HttpError(404,'Listing not found.','JOB_NOT_FOUND');
      } else if(action==='logo') {
        await connection.query('UPDATE pf_customer SET logo_url=$2,updated_at=now() WHERE account_id=$1',[account.accountId,payload.logoUrl]);
      } else throw new HttpError(400,'Unknown account update.');
      await connection.query('INSERT INTO pf_audit_event(account_id,actor_user_id,job_id,action,details) VALUES($1,$2,$3,$4,$5)',
        [account.accountId,account.userId,jobId,'account.'+action,{source:'authenticated_portal'}]);
      return {success:true};
    });
  }
  return {read,write};
}
