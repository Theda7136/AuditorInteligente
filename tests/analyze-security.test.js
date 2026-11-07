const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthStore } = require('../auth-store.js');
const {
    normalizeAnalysisInput,
    getListenSettings,
    analysisQuota,
    isRateLimited,
    loginAttemptQuota,
    createTrustedProxyList,
    getClientAddress,
    analyzeOriginAllowed,
    analyzeEnvelopeError,
    authorizeAnalysis,
    analyzeContract
} = require('../server.js');

const validInput = {
    contractText: 'Texto de contrato para revisión.',
    contractType: 'Servicios',
    jurisdiction: 'CO',
    party: 'proveedor',
    priorities: { financial: 'media', abusive: 'alta', penalties: 'alta', compliance: 'baja' }
};

const fakeAddresses = new Map();
let nextFakeAddress = 1;
function requestFrom(address, headers = {}) {
    let remoteAddress = address;
    if (!net.isIP(remoteAddress)) {
        if (!fakeAddresses.has(remoteAddress)) {
            fakeAddresses.set(remoteAddress, '198.51.100.' + nextFakeAddress++);
        }
        remoteAddress = fakeAddresses.get(remoteAddress);
    }
    return { socket: { remoteAddress }, headers: { host: 'app.example.test', ...headers } };
}

test('escucha en loopback por defecto y valida host/puerto configurados', () => {
    assert.deepEqual(getListenSettings({}), { host: '127.0.0.1', port: 8765 });
    assert.deepEqual(getListenSettings({ HOST: '0.0.0.0', PORT: '9000' }), { host: '0.0.0.0', port: 9000 });
    assert.throws(() => getListenSettings({ PORT: 'no-es-puerto' }), /PORT/);
    assert.throws(() => getListenSettings({ PORT: '70000' }), /PORT/);
});

test('valida el objeto y los valores que afectan al prompt antes de llamar a Gemini', () => {
    assert.equal(normalizeAnalysisInput(validInput).value.contractType, 'Servicios');
    assert.equal(normalizeAnalysisInput(null).error.status, 400);
    assert.equal(normalizeAnalysisInput({ ...validInput, contractText: '   ' }).error.status, 400);
    assert.equal(normalizeAnalysisInput({ ...validInput, jurisdiction: 'INVENTADA' }).error.status, 400);
    assert.equal(normalizeAnalysisInput({ ...validInput, party: 'admin' }).error.status, 400);
    assert.equal(normalizeAnalysisInput({ ...validInput, model: 'modelo-costoso-desconocido' }).error.status, 400);
    assert.equal(normalizeAnalysisInput({ ...validInput, priorities: { abusive: 'extrema' } }).error.status, 400);
    assert.equal(normalizeAnalysisInput({ ...validInput, contractText: 'x'.repeat(700001) }).error.status, 413);
});

test('solo acepta IP reenviada por proxies explícitamente confiables', () => {
    const trusted = createTrustedProxyList('127.0.0.1,10.0.0.0/8');
    assert.equal(getClientAddress(requestFrom('203.0.113.9', { 'x-forwarded-for': '198.51.100.8' }), trusted), '203.0.113.9');
    assert.equal(getClientAddress(requestFrom('127.0.0.1', {
        'x-forwarded-for': '198.51.100.66, 203.0.113.7, 10.1.2.3'
    }), trusted), '203.0.113.7');
    assert.equal(getClientAddress(requestFrom('127.0.0.1', { 'x-forwarded-for': 'malformed' }), trusted), '127.0.0.1');
    assert.equal(getClientAddress(requestFrom('::ffff:127.0.0.1', {
        'x-forwarded-for': '203.0.113.12'
    }), trusted), '203.0.113.12');
    assert.throws(() => createTrustedProxyList('not-an-ip'), /TRUSTED_PROXY_IPS/);
    assert.throws(() => createTrustedProxyList('10.0.0.0/99'), /TRUSTED_PROXY_IPS/);
});

test('aplica cuota baja a invitados, cuota por cuenta y techo compartido por IP', () => {
    const guestIp = 'security-test-guest-unique';
    for (let count = 0; count < 3; count += 1) {
        assert.equal(analysisQuota(requestFrom(guestIp), null, 10_000 + count).allowed, true);
    }
    assert.equal(analysisQuota(requestFrom(guestIp), null, 10_010).allowed, false);

    const userIpPrefix = 'security-test-user-unique-';
    for (let count = 0; count < 12; count += 1) {
        assert.equal(analysisQuota(requestFrom(userIpPrefix + count), 987654, 20_000 + count).allowed, true);
    }
    assert.equal(analysisQuota(requestFrom(userIpPrefix + 'last'), 987654, 20_020).allowed, false);
    assert.equal(analysisQuota(requestFrom(userIpPrefix + 'other-user'), 987655, 20_021).allowed, true);

    const sharedIp = 'security-test-ip-cap-unique';
    for (let count = 0; count < 20; count += 1) {
        assert.equal(analysisQuota(requestFrom(sharedIp), 1_000_000 + count, 30_000 + count).allowed, true);
    }
    const limited = analysisQuota(requestFrom(sharedIp), 2_000_000, 30_021);
    assert.equal(limited.allowed, false);
    assert.ok(limited.retryAfter > 0);
});

test('persiste las cuotas en SQLite y no consume la IP cuando se rechaza por cuota de cuenta', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-quotas-'));
    const filename = path.join(directory, 'auth.sqlite');
    const now = 1_700_000_000_000;
    let store = createAuthStore(filename);
    try {
        const guestIp = 'persistent-quota-guest';
        for (let count = 0; count < 3; count += 1) {
            assert.equal(analysisQuota(requestFrom(guestIp), null, now + count, store).allowed, true);
        }
        store.close();
        store = createAuthStore(filename);
        const limitedGuest = analysisQuota(requestFrom(guestIp), null, now + 10, store);
        assert.equal(limitedGuest.allowed, false);
        assert.ok(limitedGuest.retryAfter > 0);

        const userId = 987654321;
        for (let count = 0; count < 12; count += 1) {
            assert.equal(analysisQuota(requestFrom('persistent-user-' + count), userId, now + 100 + count, store).allowed, true);
        }
        const sharedIp = 'persistent-quota-atomic-denial';
        assert.equal(analysisQuota(requestFrom(sharedIp), userId, now + 120, store).allowed, false);
        assert.equal(analysisQuota(requestFrom(sharedIp), userId + 1, now + 121, store).allowed, true);
    } finally {
        store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('persiste el límite de solicitudes de autenticación por IP tras reiniciar SQLite', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-auth-rate-'));
    const filename = path.join(directory, 'auth.sqlite');
    const now = 1_700_000_100_000;
    let store = createAuthStore(filename);
    try {
        const proxyList = createTrustedProxyList('');
        const address = requestFrom('203.0.113.45');
        for (let count = 0; count < 20; count += 1) {
            assert.equal(isRateLimited(address, proxyList, store, now + count), false);
        }
        assert.equal(isRateLimited(address, proxyList, store, now + 20), true);
        store.close();
        store = createAuthStore(filename);
        assert.equal(isRateLimited(address, proxyList, store, now + 21), true);
        assert.equal(isRateLimited(requestFrom('203.0.113.46'), proxyList, store, now + 22), false);
    } finally {
        store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('limita intentos de inicio por correo normalizado y limpia el contador al iniciar sesión', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-login-quota-'));
    const filename = path.join(directory, 'auth.sqlite');
    const now = 1_700_000_200_000;
    let store = createAuthStore(filename);
    try {
        let result;
        for (let count = 0; count < 10; count += 1) {
            result = loginAttemptQuota('Usuario@Example.test', store, now + count);
            assert.equal(result.allowed, true);
        }
        const blocked = loginAttemptQuota('usuario@example.test', store, now + 20);
        assert.equal(blocked.allowed, false);
        assert.ok(blocked.retryAfter > 0);
        store.close();
        store = createAuthStore(filename);
        assert.equal(loginAttemptQuota('USUARIO@example.test', store, now + 21).allowed, false);
        store.resetAnalysisQuota(blocked.key);
        assert.equal(loginAttemptQuota('usuario@example.test', store, now + 22).allowed, true);
    } finally {
        store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('rechaza peticiones de origen cruzado y acepta el mismo origen o clientes sin Origin', () => {
    assert.equal(analyzeOriginAllowed(requestFrom('origin-test', { origin: 'https://app.example.test' })), true);
    assert.equal(analyzeOriginAllowed(requestFrom('origin-test-no-origin')), true);
    assert.equal(analyzeOriginAllowed(requestFrom('origin-test', { origin: 'https://evil.example' })), false);
    assert.equal(analyzeOriginAllowed(requestFrom('origin-test', { 'sec-fetch-site': 'cross-site' })), false);
    assert.equal(analyzeOriginAllowed(requestFrom('origin-test', { origin: 'not a URL' })), false);
});

test('la ruta exige JSON y aplica cuotas distintas a invitado y cuenta antes del análisis', () => {
    const noJson = analyzeEnvelopeError(requestFrom('envelope-test', { 'content-type': 'text/plain' }));
    assert.equal(noJson.status, 415);
    const crossSite = analyzeEnvelopeError(requestFrom('envelope-test', {
        'content-type': 'application/json',
        origin: 'https://evil.example'
    }));
    assert.equal(crossSite.status, 403);

    const oldKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-secret';
    try {
        const guestIp = 'authorization-guest-test-unique';
        for (let count = 0; count < 3; count += 1) {
            assert.equal(authorizeAnalysis(requestFrom(guestIp), validInput, null, 40_000 + count).input.contractText, validInput.contractText);
        }
        assert.equal(authorizeAnalysis(requestFrom(guestIp), validInput, null, 40_010).error.status, 429);

        const accountIpPrefix = 'authorization-account-test-unique-';
        for (let count = 0; count < 12; count += 1) {
            assert.ok(authorizeAnalysis(requestFrom(accountIpPrefix + count), validInput, { user: { id: 777001 } }, 50_000 + count).input);
        }
        assert.equal(authorizeAnalysis(requestFrom(accountIpPrefix + 'last'), validInput, { user: { id: 777001 } }, 50_020).error.status, 429);
    } finally {
        if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = oldKey;
    }
});

test('el análisis usa la clave solo en cabecera y limita la salida del modelo', async () => {
    const oldKey = process.env.GEMINI_API_KEY;
    const oldFetch = global.fetch;
    let upstreamRequest;
    process.env.GEMINI_API_KEY = 'test-secret';
    global.fetch = async (url, options) => {
        upstreamRequest = { url: String(url), options };
        return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ score: 20, alerts: [], recommendations: ['Revisar.'] }) }] } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        const result = await analyzeContract(validInput);
        assert.equal(result.status, 200);
        assert.equal(upstreamRequest.url.includes('test-secret'), false);
        assert.equal(upstreamRequest.options.headers['x-goog-api-key'], 'test-secret');
        assert.equal(JSON.parse(upstreamRequest.options.body).generationConfig.maxOutputTokens, 4096);
    } finally {
        global.fetch = oldFetch;
        if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = oldKey;
    }
});

test('una entrada inválida se rechaza antes de comprobar o usar la clave Gemini', async () => {
    const oldKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
        const result = await analyzeContract({ contractText: ' ' });
        assert.equal(result.status, 400);
        assert.equal(result.body.code, 'INVALID_INPUT');
    } finally {
        if (oldKey !== undefined) process.env.GEMINI_API_KEY = oldKey;
    }
});
