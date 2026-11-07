const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeAnalysisInput,
    analysisQuota,
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

function requestFrom(address, headers = {}) {
    return { socket: { remoteAddress: address }, headers: { host: 'app.example.test', ...headers } };
}

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
