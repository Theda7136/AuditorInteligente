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
        assert.match(await response.text(), /Auditor Inteligente|Revisión de contratos/i);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
