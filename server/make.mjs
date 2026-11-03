import { HttpError } from './http.mjs';
import { makePayload } from './contracts.mjs';

export function makeBridge(repository, endpoints, fetcher = fetch) {
  return async function callMake(audience, payload, {acceptedOnly = false} = {}) {
    const deadline=Date.now()+35000;
    const endpoint = endpoints[audience];
    if (!endpoint || new URL(endpoint).hostname !== 'hook.us2.make.com') throw new Error('Workflow connection is not configured');
    payload = makePayload(audience,payload);
    const issued = await repository.issueTicket(audience, payload);
    const ticket = typeof issued==='string'?{token:issued,send:true}:issued;
    let response=null;
    try { response = ticket.send ? await fetcher(endpoint, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...payload, authTicket:ticket.token}), signal:AbortSignal.timeout(25000)
    }) : null; }
    catch {
      // A lost HTTP acknowledgement does not prove that Make rejected the job.
      // Private services confirm their outcome through the durable callback.
      if (audience!=='services') throw new HttpError(503,'The workflow did not confirm the request. Refresh status before retrying.','WORKFLOW_UNAVAILABLE');
    }
    if (response && !response.ok) throw new HttpError(503,'The workflow did not confirm the request. Refresh status before retrying.','WORKFLOW_UNAVAILABLE');
    if (audience==='services') {
      while(Date.now()<deadline) {
        const result=await repository.ticketResult(ticket.hash);
        if (result) {
          if (result.status>=400 || result.body?.success!==true) throw new HttpError(503,'The account service could not confirm the request.','WORKFLOW_UNCONFIRMED');
          return result.body;
        }
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      throw new HttpError(503,'The request is still awaiting confirmation. Please check again before retrying.','WORKFLOW_PENDING');
    }
    const text = await response.text();
    if (acceptedOnly && text.trim() === 'Accepted') return {success:true,status:'queued',jobId:payload.jobId};
    let result;
    try { result=JSON.parse(text); } catch { throw new HttpError(503,'The workflow response was incomplete.','WORKFLOW_UNCONFIRMED'); }
    if (result.success !== true || result.status === 'rejected') throw new HttpError(503,'The workflow did not confirm the request.','WORKFLOW_UNCONFIRMED');
    return result;
  };
}
