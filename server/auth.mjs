import { betterAuth } from 'better-auth';
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError } from './http.mjs';

const resetDelivery = new AsyncLocalStorage();
export async function awaitResetDelivery(operation,{required=false}={}) {
  return resetDelivery.run({attempted:false,sent:false},async()=>{
    const result=await operation();
    const state=resetDelivery.getStore();
    if ((required||state.attempted) && !state.sent) throw new HttpError(503,'The account email could not be delivered. Please try again.','EMAIL_UNAVAILABLE');
    return result;
  });
}

// All account creation is server-side, after verified provisioning or migration.
// Setting the first password uses the same expiring, atomic single-use flow as reset.
export function authOptions({ database, baseURL, secret, sendPasswordReset }) {
  if (!secret || secret.length < 32) throw new Error('Authentication secret is not configured');
  const origin = new URL(baseURL).origin;
  return {
    appName: 'PremiereFlow',
    baseURL: origin,
    basePath: '/api/auth',
    secret,
    database,
    trustedOrigins: [origin],
    user: { modelName: 'pf_user', changeEmail: { enabled: false } },
    account: { modelName: 'pf_credential' },
    verification: { modelName: 'pf_verification', storeIdentifier: 'hashed' },
    session: {
      modelName: 'pf_session',
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: { enabled: false }
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 15 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        // This callback must await a durable delivery acknowledgement. Never log tokens.
        const delivery=resetDelivery.getStore();
        if (delivery) delivery.attempted=true;
        await sendPasswordReset({
          userId: user.id,
          email: user.email,
          name: user.name,
          url: `${origin}/setup/?token=${encodeURIComponent(token)}`
        });
        if (delivery) delivery.sent=true;
      }
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'pf_rate_limit',
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 300, max: 3 },
        '/reset-password': { window: 300, max: 5 }
      }
    },
    advanced: {
      cookiePrefix: 'pf',
      useSecureCookies: origin.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: ['x-real-ip'] }
    },
    logger: { level: 'error' },
    telemetry: { enabled: false }
  };
}

export function createAuth(config) { return betterAuth(authOptions(config)); }

const publicRoutes = new Map([
  ['/api/auth/ok', 'GET'],
  ['/api/auth/get-session', 'GET'],
  ['/api/auth/sign-in/email', 'POST'],
  ['/api/auth/sign-out', 'POST'],
  ['/api/auth/request-password-reset', 'POST'],
  ['/api/auth/reset-password', 'POST']
]);

export function isPublicAuthRoute(path, method) {
  return publicRoutes.get(path) === method;
}
