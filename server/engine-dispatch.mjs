import {canonical,digest} from './repository.mjs';
import {makePayload} from './contracts.mjs';
import {HttpError,onlyKeys,shortText} from './http.mjs';
import {JOB_ID_PATTERN} from './access.mjs';
import {validateImageUrl} from './portal.mjs';

const colors=new Set(['White (default)','Black','Gold','Red','Blue','Green']);
const placements=new Set(['No Logo','Bottom Left','Bottom Right','Top Right','Top Left']);
const errors={
  ACCOUNT_UNAVAILABLE:[403,'This account is not accessible.'],
  JOB_NOT_FOUND:[404,'Listing not found.'],
  JOB_CONFLICT:[409,'This Job ID already belongs to a different request.'],
  NO_CREDITS:[409,'There are no available listing credits.'],
  JOB_NOT_RETRYABLE:[409,'This job is not ready to retry. Refresh its status first.'],
  ATTEMPT_INVALID:[409,'The retry limit has been reached or its attempt is invalid.'],
  ATTEMPT_CONFLICT:[409,'This job has already moved to another attempt.'],
  RETRY_CONFLICT:[409,'This job has already moved to another attempt.'],
  PAYLOAD_INVALID:[400,'The listing request is invalid.']
};

export function engineRequest(account,input) {
  if (!account?.userId || !account?.accountId || !account?.email) throw new HttpError(403,'This account is not accessible.');
  if (!JOB_ID_PATTERN.test(input.jobId||'')) throw new HttpError(400,'The Job ID is invalid.');
  const identity={accountId:account.accountId,email:account.email,jobId:input.jobId.toLowerCase()};
  if(input.action==='retry') {
    onlyKeys(input,['action','jobId','expectedAttempt']);
    if(!Number.isInteger(input.expectedAttempt)||input.expectedAttempt<1||input.expectedAttempt>2) throw new HttpError(409,'This job is not ready to retry.');
    return makePayload('engine',{...identity,action:'retry',expectedAttempt:String(input.expectedAttempt)});
  }
  onlyKeys(input,['action','jobId','vehicleName','assetSource','showroomColor','logoPlacement','thumbnail','uploadcareUrl']);
  if(input.action!=='submit'||!colors.has(input.showroomColor)||!placements.has(input.logoPlacement)) throw new HttpError(400,'Choose a valid showroom and logo option.');
  return makePayload('engine',{
    ...identity,action:'submit',vehicleName:shortText(input.vehicleName,160,'Vehicle name'),
    assetSource:typeof input.assetSource==='string'?input.assetSource.slice(0,2000):'',
    showroomColor:input.showroomColor,logoPlacement:input.logoPlacement,
    thumbnail:validateImageUrl(input.thumbnail,{optional:true}),uploadcareUrl:validateImageUrl(input.uploadcareUrl,{group:true})
  });
}

// Intentionally not wired into runtime yet: the callback, recovery and saved
// Make adapter must pass acceptance before the existing cutover guard is removed.
export function engineDispatch(database) {
  return {
    async enqueue(account,input) {
      const payload=engineRequest(account,input);
      try {
        const {rows:[row]}=await database.query('SELECT pf_enqueue_engine($1,$2,$3,$4,$5::jsonb) AS result',
          [account.accountId,account.userId,payload.jobId,digest(canonical(payload)),JSON.stringify(payload)]);
        if(!row?.result) throw new Error('Engine handoff missing');
        return row.result;
      } catch(error) {
        const mapped=errors[error.message];
        if(mapped) throw new HttpError(mapped[0],mapped[1],error.message);
        if(error.code==='23505') throw new HttpError(409,'This Job ID already belongs to a request.','JOB_CONFLICT');
        throw error;
      }
    },
    async claim(token,payload) {
      if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||!payload||typeof payload!=='object'||Array.isArray(payload)) return null;
      const {rows:[row]}=await database.query('SELECT pf_claim_engine($1,$2::jsonb) AS result',[digest(token),JSON.stringify(payload)]);
      return row?.result||null;
    }
  };
}
