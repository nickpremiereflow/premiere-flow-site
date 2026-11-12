// Environment gates only. Job ownership, ticket claims, result validation and
// credit accounting continue to use the accepted engine pipeline unchanged.
export function engineConfiguration(env,applicationData) {
  const mode=env.PF_ENGINE_MODE||'';
  if(!['','neon_preview','neon_production_test','neon_production'].includes(mode)) throw new Error('Unknown engine mode');
  if(!mode) {
    if(applicationData&&env.PF_SUBMISSIONS_ENABLED==='true') throw new Error('Neon submissions require a configured engine');
    return {enabled:false,previewIdentity:false,acceptanceAccount:undefined};
  }
  if(!applicationData) throw new Error('The engine requires Neon account authority');
  const preview=mode==='neon_preview';
  if(env.VERCEL_ENV!==(preview?'preview':'production')) throw new Error('Engine environment mismatch');
  const controlled=mode!=='neon_production';
  if(controlled&&!/^PF-[A-Za-z0-9-]{3,100}$/.test(env.PF_ENGINE_ACCEPTANCE_ACCOUNT||'')) throw new Error('A controlled acceptance account is required');
  if(!preview) {
    if(env.PF_SITE_URL!=='https://www.premiereflow.com') throw new Error('Production must use the PremiereFlow origin');
    if(env.PF_PREVIEW_SERVICE_ACCESS) throw new Error('Preview service access cannot be used in production');
    if(!controlled) {
      if(env.PF_ENGINE_ACCEPTANCE_ACCOUNT) throw new Error('Remove the acceptance account before opening customer access');
      if(!env.CRON_SECRET||env.CRON_SECRET.length<32||env.PF_RECOVERY_SCHEDULE_VERIFIED!=='true') throw new Error('Production recovery must be configured and verified');
    }
  }
  return {enabled:true,previewIdentity:preview,acceptanceAccount:controlled?env.PF_ENGINE_ACCEPTANCE_ACCOUNT:undefined};
}
