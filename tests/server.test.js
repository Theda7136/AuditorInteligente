const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server.js');

test('health informa que Gemini no está configurado sin exponer secretos', async function () {
    const previousKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const server = createServer({ dbPath: ':memory:' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: 'ok', gemini: false });
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousKey !== undefined) process.env.GEMINI_API_KEY = previousKey;
    }
});

test('activa HSTS en producción solo si HTTPS viene de un proxy confiable', async function () {
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const trustedServer = createServer({ dbPath: ':memory:', trustedProxyIps: '127.0.0.1' });
    await new Promise(resolve => trustedServer.listen(0, '127.0.0.1', resolve));
    const trustedAddress = trustedServer.address();
    try {
        const trustedResponse = await fetch(`http://127.0.0.1:${trustedAddress.port}/api/health`, {
            headers: { 'X-Forwarded-Proto': 'https' }
        });
        assert.equal(trustedResponse.headers.get('strict-transport-security'), 'max-age=31536000');

        const insecureResponse = await fetch(`http://127.0.0.1:${trustedAddress.port}/api/health`, {
            headers: { 'X-Forwarded-Proto': 'http' }
        });
        assert.equal(insecureResponse.headers.get('strict-transport-security'), null);
    } finally {
        await new Promise(resolve => trustedServer.close(resolve));
        if (previousEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnvironment;
    }

    process.env.NODE_ENV = 'production';
    const untrustedServer = createServer({ dbPath: ':memory:', trustedProxyIps: '127.0.0.2' });
    await new Promise(resolve => untrustedServer.listen(0, '127.0.0.1', resolve));
    const untrustedAddress = untrustedServer.address();
    try {
        const response = await fetch(`http://127.0.0.1:${untrustedAddress.port}/api/health`, {
            headers: { 'X-Forwarded-Proto': 'https' }
        });
        assert.equal(response.headers.get('strict-transport-security'), null);
    } finally {
        await new Promise(resolve => untrustedServer.close(resolve));
        if (previousEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnvironment;
    }
});

test('el servidor no publica archivos internos ni el ejemplo de variables', async function () {
    const server = createServer({ dbPath: ':memory:' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try {
        for (const file of ['/server.js', '/.env.example', '/package.json', '/tests/server.test.js', '/js/../server.js']) {
            const response = await fetch(`http://127.0.0.1:${address.port}${file}`);
            assert.equal(response.status, 403, file);
        }
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('el servidor entrega la aplicación web', async function () {
    const server = createServer({ dbPath: ':memory:' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/`);
        assert.equal(response.status, 200);
        const policy = response.headers.get('content-security-policy');
        assert.match(policy, /default-src 'self'/);
        assert.match(policy, /script-src 'self' https:\/\/cdnjs\.cloudflare\.com/);
        assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
        assert.match(policy, /object-src 'none'/);
        assert.match(policy, /frame-ancestors 'none'/);
        assert.match(await response.text(), /Auditor Inteligente|Revisión de contratos/i);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
