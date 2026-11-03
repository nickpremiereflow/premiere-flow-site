import { Pool } from 'pg';
const pools=new Map();
export function getDatabase(channel='application') {
  if (!pools.has(channel)) {
    if (!process.env.DATABASE_URL) throw new Error('Database is not configured');
    const pool = new Pool({connectionString:process.env.DATABASE_URL, max:3, connectionTimeoutMillis:8000, idleTimeoutMillis:10000});
    pool.on('error', () => console.error('Database connection failed'));
    pools.set(channel,pool);
  }
  return pools.get(channel);
}
export async function transaction(database, operation) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
