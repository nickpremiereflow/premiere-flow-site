import { HttpError } from './http.mjs';

export async function requireAccount(auth, accounts, headers) {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new HttpError(401, 'Please sign in to continue.', 'AUTH_REQUIRED');
  // The immutable auth user ID is the only authority for selecting an account.
  const account = await accounts.findByUserId(session.user.id);
  if (!account) throw new HttpError(403, 'Your account is not ready yet. Please contact support.', 'ACCOUNT_NOT_READY');
  return { session, account };
}

export function rejectForeignIdentity(body, account) {
  for (const field of ['accountId', 'accountID']) {
    if (body[field] !== undefined && body[field] !== account.accountId) throw new HttpError(403, 'This account is not accessible.', 'FORBIDDEN');
  }
  if (body.email !== undefined && String(body.email).toLowerCase() !== account.email.toLowerCase()) throw new HttpError(403, 'This account is not accessible.', 'FORBIDDEN');
  if (body.rowId !== undefined || body.row !== undefined) throw new HttpError(400, 'Use the listing Job ID.', 'INVALID_JOB');
}

export const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireOwnedJob(jobs, account, jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) throw new HttpError(400, 'The Job ID is invalid.', 'INVALID_JOB');
  // The repository lookup must include BOTH keys; an unowned ID returns no data.
  const job = await jobs.findOwned(account.accountId, jobId);
  if (!job) throw new HttpError(404, 'Listing not found.', 'JOB_NOT_FOUND');
  return job;
}
