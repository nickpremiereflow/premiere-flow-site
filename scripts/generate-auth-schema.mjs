import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { getSchema } from 'better-auth/db';
import { authOptions } from '../server/auth.mjs';

// Derive the initial empty-database schema from the pinned Better Auth version.
// This script does not connect to a database or generate a deployed credential.
const schema = getSchema(authOptions({baseURL:'https://www.premiereflow.com',secret:randomBytes(48).toString('base64url'),sendPasswordReset:async()=>{}}));
const quote = name => '"' + name.replaceAll('"','""') + '"';
const statements = ['-- Initial authentication schema: Better Auth 1.7.15. No customer data is changed.', 'BEGIN;'];
const indexes = [];
for (const [table, spec] of Object.entries(schema)) {
  const columns = ['"id" text PRIMARY KEY NOT NULL'];
  for (const [name, field] of Object.entries(spec.fields)) {
    const type = {string:'text',boolean:'boolean',date:'timestamp with time zone',number:field.bigint?'bigint':'integer'}[field.type];
    if (!type) throw new Error('Unsupported schema field type');
    let ddl = `${quote(name)} ${type}${field.required !== false?' NOT NULL':''}${field.unique?' UNIQUE':''}`;
    if (typeof field.defaultValue === 'boolean') ddl += ` DEFAULT ${field.defaultValue?'TRUE':'FALSE'}`;
    if (field.type === 'date' && typeof field.defaultValue === 'function') ddl += ' DEFAULT CURRENT_TIMESTAMP';
    if (field.references) ddl += ` REFERENCES ${quote(field.references.model)} (${quote(field.references.field)}) ON DELETE CASCADE`;
    columns.push(ddl);
    if (field.index && !field.unique) indexes.push(`CREATE INDEX IF NOT EXISTS ${quote(table+'_'+name+'_idx')} ON ${quote(table)} (${quote(name)});`);
  }
  statements.push(`CREATE TABLE IF NOT EXISTS ${quote(table)} (\n  ${columns.join(',\n  ')}\n);`);
  for (const index of spec.indexes || []) {
    indexes.push(`CREATE ${index.unique?'UNIQUE ':''}INDEX IF NOT EXISTS ${quote(table+'_'+index.columns.join('_')+'_idx')} ON ${quote(table)} (${index.columns.map(quote).join(', ')});`);
  }
}
statements.push(...indexes,'COMMIT;');
await writeFile(new URL('../migrations/001-auth.sql',import.meta.url),statements.join('\n\n')+'\n');
console.log('Generated authentication schema for '+Object.keys(schema).length+' tables.');
