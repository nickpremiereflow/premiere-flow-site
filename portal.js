(() => {
    'use strict';
    // Remove credentials left by the old portal. Passwords and session tokens are never persisted here.
    for (const name of ['localStorage', 'sessionStorage']) {
        try { window[name].removeItem('pf_pass'); window[name].removeItem('pf_email'); } catch {}
    }
    async function request(path, body) {
        if (!path.startsWith('/api/')) throw new Error('Invalid service address.');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);
        try {
            const response = await fetch(path, {
                method: body === undefined ? 'GET' : 'POST',
                credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
                ...(body === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
            });
            let data;
            try { data = await response.json(); } catch { throw new Error('The service did not confirm the request. Please try again.'); }
            if (!response.ok || data?.success === false || data?.status === false) {
                const message = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : 'The request could not be completed.';
                const error = new Error(response.status === 429 ? 'Too many attempts. Please wait a few minutes and try again.' : message);
                error.status = response.status;
                throw error;
            }
            return data;
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('The request timed out. Please check your connection and try again.');
            throw error;
        } finally { clearTimeout(timeout); }
    }
    async function getSession() {
        const data = await request('/api/auth/get-session');
        return data?.user ? {id: data.user.id, email: data.user.email, name: data.user.name} : null;
    }
    async function signIn(email, password) {
        await request('/api/auth/sign-in/email', {email: email.trim().toLowerCase(), password});
        const user = await getSession();
        if (!user) throw new Error('The sign-in session was not confirmed. Please try again.');
        return user;
    }
    async function signOut() {
        await request('/api/auth/sign-out', {});
        location.replace('/login/');
    }
    window.PF = Object.freeze({request, getSession, signIn, signOut});
})();
