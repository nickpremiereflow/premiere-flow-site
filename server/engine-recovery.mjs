// Server-only, bounded recovery. The scheduler and Make adapter must be accepted
// before enabling this service. No generation or email is sent by this worker.
export function engineRecovery(database) {
  return async function recover() {
    const {rows}=await database.query(`SELECT account_id,job_id,attempt FROM pf_engine_dispatch
      WHERE (state='pending' AND created_at<=now()-interval '30 minutes')
         OR (state='claimed' AND claimed_at<=now()-interval '2 hours')
      ORDER BY account_id,job_id,attempt LIMIT 10`);
    let recovered=0;
    for(const row of rows) {
      // Recheck under the account/job/attempt locks: completion or another
      // recovery worker may have won after the candidate query.
      const {rows:[result]}=await database.query('SELECT pf_expire_engine($1,$2,$3) AS expired',[row.account_id,row.job_id,row.attempt]);
      if(result?.expired===true) recovered++;
    }
    return {checked:rows.length,recovered};
  };
}
