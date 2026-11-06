const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server.js');

async function startServer() {
    const server = createServer({ dbPath: ':memory:' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return { server, baseUrl, close: () => new Promise(resolve => server.close(resolve)) };
}

function cookieValue(setCookie, name) {
    const entry = setCookie.find(value => value.startsWith(name + '='));
    return entry ? entry.split(';')[0] : '';
}

async function getCsrf(baseUrl) {
    const response = await fetch(baseUrl + '/api/auth/csrf');
    const payload = await response.json();
    const cookies = response.headers.getSetCookie();
    return { token: payload.csrfToken, csrfCookie: cookieValue(cookies, 'ai_csrf') };
}

async function register(baseUrl, email, password) {
    const csrf = await getCsrf(baseUrl);
    const response = await fetch(baseUrl + '/api/auth/register', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf.token,
            Cookie: csrf.csrfCookie
        },
        body: JSON.stringify({ email, password })
    });
    const payload = await response.json();
    return { response, payload, cookies: response.headers.getSetCookie() };
}

test('registro crea una cuenta y una sesión con cookies protegidas', async () => {
    const app = await startServer();
    try {
        const result = await register(app.baseUrl, 'daniel@example.com', 'una-clave-segura-123');
        assert.equal(result.response.status, 201);
        assert.equal(result.payload.authenticated, true);
        const sessionCookie = result.cookies.find(value => value.startsWith('ai_session='));
        assert.match(sessionCookie, /HttpOnly/);
        assert.match(sessionCookie, /SameSite=Strict/);
        assert.ok(result.cookies.some(value => value.startsWith('ai_csrf=')));
    } finally {
        await app.close();
    }
});

test('rechaza registro sin token CSRF y contraseñas demasiado cortas', async () => {
    const app = await startServer();
    try {
        const noCsrf = await fetch(app.baseUrl + '/api/auth/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'a@example.com', password: '1234567890' })
        });
        assert.equal(noCsrf.status, 403);

        const csrf = await getCsrf(app.baseUrl);
        const weakPassword = await fetch(app.baseUrl + '/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token, Cookie: csrf.csrfCookie },
            body: JSON.stringify({ email: 'a@example.com', password: '123' })
        });
        assert.equal(weakPassword.status, 400);
    } finally {
        await app.close();
    }
});

test('login valida credenciales y logout invalida la sesión', async () => {
    const app = await startServer();
    try {
        await register(app.baseUrl, 'login@example.com', 'otra-clave-segura-123');
        const csrf = await getCsrf(app.baseUrl);
        const wrong = await fetch(app.baseUrl + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token, Cookie: csrf.csrfCookie },
            body: JSON.stringify({ email: 'login@example.com', password: 'clave-incorrecta-123' })
        });
        assert.equal(wrong.status, 401);

        const freshCsrf = await getCsrf(app.baseUrl);
        const login = await fetch(app.baseUrl + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': freshCsrf.token, Cookie: freshCsrf.csrfCookie },
            body: JSON.stringify({ email: 'login@example.com', password: 'otra-clave-segura-123' })
        });
        assert.equal(login.status, 200);
        const cookies = login.headers.getSetCookie();
        const sessionCookie = cookieValue(cookies, 'ai_session');
        const csrfCookie = cookieValue(cookies, 'ai_csrf');
        const csrfToken = decodeURIComponent(csrfCookie.slice('ai_csrf='.length));

        const me = await fetch(app.baseUrl + '/api/auth/me', { headers: { Cookie: sessionCookie } });
        assert.equal((await me.json()).authenticated, true);

        const logout = await fetch(app.baseUrl + '/api/auth/logout', {
            method: 'POST', headers: { Cookie: `${sessionCookie}; ${csrfCookie}`, 'X-CSRF-Token': csrfToken }
        });
        assert.equal(logout.status, 200);
        const afterLogout = await fetch(app.baseUrl + '/api/auth/me', { headers: { Cookie: sessionCookie } });
        assert.equal((await afterLogout.json()).authenticated, false);
    } finally {
        await app.close();
    }
});

test('el historial persiste por usuario y no permite acceder a registros ajenos', async () => {
    const app = await startServer();
    try {
        const first = await register(app.baseUrl, 'first@example.com', 'clave-primera-segura-123');
        const firstSession = cookieValue(first.cookies, 'ai_session');
        const firstCsrfCookie = cookieValue(first.cookies, 'ai_csrf');
        const firstCsrf = decodeURIComponent(firstCsrfCookie.slice('ai_csrf='.length));
        const second = await register(app.baseUrl, 'second@example.com', 'clave-segunda-segura-123');
        const secondSession = cookieValue(second.cookies, 'ai_session');

        const unauthenticated = await fetch(app.baseUrl + '/api/history');
        assert.equal(unauthenticated.status, 401);

        const created = await fetch(app.baseUrl + '/api/history', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json', Cookie: `${firstSession}; ${firstCsrfCookie}`,
                'X-CSRF-Token': firstCsrf
            },
            body: JSON.stringify({
                title: 'Contrato de prueba', excerpt: 'Extracto breve',
                data: { score: 72, alerts: [], recommendations: [], date: '2026-11-06' }
            })
        });
        assert.equal(created.status, 201);
        const { id } = await created.json();

        const firstHistory = await fetch(app.baseUrl + '/api/history', { headers: { Cookie: firstSession } });
        assert.equal((await firstHistory.json()).history.length, 1);
        const secondHistory = await fetch(app.baseUrl + '/api/history', { headers: { Cookie: secondSession } });
        assert.equal((await secondHistory.json()).history.length, 0);

        const foreignDelete = await fetch(app.baseUrl + `/api/history/${id}`, {
            method: 'DELETE',
            headers: { Cookie: `${secondSession}; ${cookieValue(second.cookies, 'ai_csrf')}`, 'X-CSRF-Token': decodeURIComponent(cookieValue(second.cookies, 'ai_csrf').slice('ai_csrf='.length)) }
        });
        assert.equal(foreignDelete.status, 404);
    } finally {
        await app.close();
    }
});

test('SQLite conserva usuarios y análisis al reabrir la base de datos', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { createAuthStore } = require('../auth-store.js');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-inteligente-'));
    const filename = path.join(folder, 'test.sqlite');
    try {
        const firstStore = createAuthStore(filename);
        const user = firstStore.register('persistencia@example.com', 'clave-persistente-123');
        const session = firstStore.createSession(user.id);
        firstStore.saveAnalysis(user.id, {
            title: 'Prueba guardada', excerpt: 'Extracto', score: 45,
            data: { score: 45, alerts: [], recommendations: [] }
        });
        firstStore.close();

        const reopenedStore = createAuthStore(filename);
        assert.equal(reopenedStore.getSession(session.token).user.email, 'persistencia@example.com');
        assert.equal(reopenedStore.listAnalyses(user.id).length, 1);
        reopenedStore.close();
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});
