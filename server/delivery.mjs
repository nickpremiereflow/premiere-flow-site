import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { canonical,digest } from './repository.mjs';
import { HttpError } from './http.mjs';

export const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function deliveryService(database,bridge,baseURL) {
  const origin=new URL(baseURL).origin;
  async function reset({email,name,url}) {
    const link=new URL(url);
    if (link.origin!==origin || link.pathname!=='/setup/' || !link.searchParams.get('token')) throw new Error('Invalid setup destination');
    const result=await bridge('services',{
      action:'email',commandId:randomUUID(),email,subject:'Set your PremiereFlow password',
      html:`<p>Hi ${escapeHtml(name||'there')},</p><p><a href="${escapeHtml(url)}">Set your PremiereFlow password</a></p><p>This link expires in 15 minutes and can be used once. If you did not request it, you can ignore this email.</p><p>PremiereFlow<br>info@premiereflow.com</p>`
    });
    if (result.delivery!=='sent') throw new Error('Email delivery was not confirmed');
  }
  async function support(account,message) {
    const commandId='support:'+message.requestId;
    const payload={...message,accountId:account.accountId,email:account.email};
    return transaction(database,async connection=>{
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[commandId]);
      const {rows}=await connection.query('SELECT account_id,payload,state,result FROM pf_command WHERE command_id=$1',[commandId]);
      const existing=rows[0];
      if (existing && (existing.account_id!==account.accountId || digest(canonical(existing.payload))!==digest(canonical(payload)))) throw new HttpError(409,'This message ID is already in use.');
      if (existing?.state==='done') return existing.result;
      await connection.query("INSERT INTO pf_command(command_id,kind,account_id,payload) VALUES($1,'support',$2,$3) ON CONFLICT DO NOTHING",[commandId,account.accountId,payload]);
      const sent=await bridge('services',{
        action:'email',commandId,email:'info@premiereflow.com',subject:'PremiereFlow support: '+message.subject,
        html:`<p>Account: ${escapeHtml(account.accountId)}<br>Customer: ${escapeHtml(account.email)}</p><p>${escapeHtml(message.message).replace(/\n/g,'<br>')}</p>`
      });
      if (sent.delivery!=='sent') throw new Error('Support delivery was not confirmed');
      const result={success:true,delivery:'sent',requestId:message.requestId};
      await connection.query("UPDATE pf_command SET state='done',result=$2,finished_at=now() WHERE command_id=$1",[commandId,result]);
      return result;
    });
  }
  return {reset,support};
}
