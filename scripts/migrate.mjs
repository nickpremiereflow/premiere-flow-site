import { readFile } from 'node:fs/promises';
import { getMigrations } from 'better-auth/db/migration';
import { getDatabase } from '../server/database.mjs';
import { authOptions } from '../server/auth.mjs';

const database=getDatabase();
try {
  const options=authOptions({database,baseURL:process.env.BETTER_AUTH_URL,secret:process.env.BETTER_AUTH_SECRET,sendPasswordReset:async()=>{throw new Error('Email unavailable during migration');}});
  const migration=await getMigrations(options);
  await migration.runMigrations();
  await database.query(await readFile(new URL('../migrations/002-portal.sql',import.meta.url),'utf8'));
  for (const file of ['003-application-data.sql','004-completion-asset-binding.sql','005-billing-customer-ownership.sql','006-complete-image-sequence.sql','007-paid-unlimited-reservation.sql','008-durable-engine-dispatch.sql','009-attempt-bound-engine-results.sql','010-expired-engine-recovery.sql','011-private-media-storage.sql','012-media-job-binding.sql']) await database.query(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  console.log('Portal schema migration completed.');
} finally {await database.end();}
