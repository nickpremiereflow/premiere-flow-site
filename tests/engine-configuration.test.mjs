import test from 'node:test';
import assert from 'node:assert/strict';
import {engineConfiguration} from '../server/engine-configuration.mjs';

const preview={VERCEL_ENV:'preview',PF_ENGINE_MODE:'neon_preview',PF_ENGINE_ACCEPTANCE_ACCOUNT:'PF-controlled-a',PF_SUBMISSIONS_ENABLED:'true'};
const production={VERCEL_ENV:'production',PF_SITE_URL:'https://www.premiereflow.com',PF_ENGINE_MODE:'neon_production_test',PF_ENGINE_ACCEPTANCE_ACCOUNT:'PF-controlled-a',PF_SUBMISSIONS_ENABLED:'true'};

test('the accepted Preview keeps its account restriction and private transport identity',()=>{
  assert.deepEqual(engineConfiguration(preview,true),{enabled:true,previewIdentity:true,acceptanceAccount:'PF-controlled-a'});
  assert.throws(()=>engineConfiguration({...preview,VERCEL_ENV:'production'},true),/environment mismatch/);
  assert.throws(()=>engineConfiguration({...preview,PF_ENGINE_ACCEPTANCE_ACCOUNT:''},true),/controlled acceptance/);
});

test('production acceptance stays limited to one account with ordinary ticket-authenticated callbacks',()=>{
  assert.deepEqual(engineConfiguration(production,true),{enabled:true,previewIdentity:false,acceptanceAccount:'PF-controlled-a'});
  for(const changed of [{VERCEL_ENV:'preview'},{PF_ENGINE_ACCEPTANCE_ACCOUNT:''},{PF_SITE_URL:'https://unrelated.example'},{PF_PREVIEW_SERVICE_ACCESS:'oidc'}])
    assert.throws(()=>engineConfiguration({...production,...changed},true));
  assert.throws(()=>engineConfiguration(production,false),/Neon account authority/);
});

test('general customer access remains closed until bounded recovery has been accepted',()=>{
  const env={...production,PF_ENGINE_MODE:'neon_production',PF_ENGINE_ACCEPTANCE_ACCOUNT:undefined};
  assert.throws(()=>engineConfiguration(env,true),/recovery/);
  assert.throws(()=>engineConfiguration({...env,CRON_SECRET:'s'.repeat(32)},true),/recovery/);
  const ready={...env,CRON_SECRET:'s'.repeat(32),PF_RECOVERY_SCHEDULE_VERIFIED:'true'};
  assert.deepEqual(engineConfiguration(ready,true),{enabled:true,previewIdentity:false,acceptanceAccount:undefined});
  assert.throws(()=>engineConfiguration({...ready,PF_ENGINE_ACCEPTANCE_ACCOUNT:'PF-controlled-a'},true),/Remove the acceptance/);
});

test('unknown modes and enabled Neon submissions without an engine fail closed',()=>{
  assert.throws(()=>engineConfiguration({...preview,PF_ENGINE_MODE:'typo'},true),/Unknown engine mode/);
  assert.throws(()=>engineConfiguration({PF_SUBMISSIONS_ENABLED:'true'},true),/configured engine/);
  assert.equal(engineConfiguration({PF_SUBMISSIONS_ENABLED:'false'},true).enabled,false);
});
