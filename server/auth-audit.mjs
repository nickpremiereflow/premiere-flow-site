import { randomUUID } from 'node:crypto';

const actions = new Set([
  'auth.session_created', 'auth.session_revoked',
  'auth.password_changed', 'auth.reset_email_sent'
]);

// Accept only library-confirmed identities and fixed event names, never request
// bodies, passwords, session tokens, reset URLs, or provider error objects.
export function authAudit(database, { fallback = value => console.error(value) } = {}) {
  return async ({ action, userId }) => {
    if (!actions.has(action) || typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error('Invalid authentication audit event');
    const eventId = randomUUID();
    try {
      const result = await database.query(`INSERT INTO pf_audit_event(event_id,event_key,account_id,actor_user_id,action)
        SELECT $1,$2,c.account_id,u.id,$3 FROM pf_user u
        LEFT JOIN pf_customer c ON c.user_id=u.id WHERE u.id=$4
        ON CONFLICT(event_key) DO NOTHING`, [eventId,'auth:'+eventId,action,userId]);
      if (result.rowCount !== 1) throw new Error('Audit identity unavailable');
      return true;
    } catch {
      // Auth state has already changed. Preserve successful login/logout/reset
      // semantics and leave a sanitized operational record if Neon is unavailable.
      fallback(JSON.stringify({code:'AUTH_AUDIT_UNAVAILABLE',eventId,action,userId,persisted:false}));
      return false;
    }
  };
}
