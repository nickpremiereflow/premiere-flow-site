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
  console.log('Portal schema migration completed.');
} finally {await database.end();}
