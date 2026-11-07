const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { Readable } = require('node:stream');
const { createServer } = require('../server.js');

const input = {
    contractText: 'Texto de contrato para revisar.',
    contractType: 'Servicios',
    jurisdiction: 'CO',
    party: 'proveedor',
    priorities: { financial: 'media', abusive: 'alta', penalties: 'alta', compliance: 'baja' }
};

const fakeAddresses = new Map();
let nextFakeAddress = 1;
function testAddress(address) {
    if (net.isIP(address)) return address;
    if (!fakeAddresses.has(address)) fakeAddresses.set(address, '198.51.100.' + nextFakeAddress++);
    return fakeAddresses.get(address);
}

function createApi(store) {
    const server = createServer({ store: store || { getSession: () => null } });
    const handler = server.listeners('request')[0];
    return function post(payload, options = {}) {
        const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const request = Readable.from([Buffer.from(body)]);
        request.method = 'POST';
        request.url = '/api/analyze';
        request.headers = {
            host: 'app.example.test',
            'content-type': options.contentType || 'application/json',
            ...(options.origin === undefined ? {} : { origin: options.origin }),
            ...(options.cookie === undefined ? {} : { cookie: options.cookie })
        };
        request.socket = { remoteAddress: testAddress(options.ip || 'api-test-default') };

        return new Promise(resolve => {
            const response = {
                statusCode: 200,
                headers: {},
                setHeader(name, value) { this.headers[name] = value; },
                writeHead(status, headers = {}) {
                    this.statusCode = status;
                    Object.assign(this.headers, headers);
                },
                end(responseBody = '') {
                    resolve({ status: this.statusCode, headers: this.headers, body: String(responseBody) });
                }
            };
            handler(request, response);
        });
    };
}

function geminiResponse() {
    return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ score: 22, alerts: [], recommendations: ['Revisar.'] }) }] } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('POST /api/analyze permite invitado y conserva la clave solo en la llamada servidor a servidor', async () => {
    const oldKey = process.env.GEMINI_API_KEY;
    const oldFetch = global.fetch;
    let upstream;
    process.env.GEMINI_API_KEY = 'api-test-secret';
    global.fetch = async (url, options) => {
        upstream = { url: String(url), options };
        return geminiResponse();
    };
    try {
        const response = await createApi()(input, { ip: 'api-guest-success' });
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(response.body).analysis.score, 22);
        assert.equal(upstream.url.includes('api-test-secret'), false);
        assert.equal(upstream.options.headers['x-goog-api-key'], 'api-test-secret');
    } finally {
        global.fetch = oldFetch;
        if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = oldKey;
    }
});

test('POST /api/analyze rechaza origen, tipo de contenido y campos inválidos sin llamar a Gemini', async () => {
    const oldKey = process.env.GEMINI_API_KEY;
    const oldFetch = global.fetch;
    let calls = 0;
    process.env.GEMINI_API_KEY = 'api-test-secret';
    global.fetch = async () => { calls += 1; return geminiResponse(); };
    try {
        const post = createApi();
        assert.equal((await post(input, { ip: 'api-invalid-content', contentType: 'text/plain' })).status, 415);
        assert.equal((await post(input, { ip: 'api-cross-origin', origin: 'https://attacker.example' })).status, 403);
        assert.equal((await post({ ...input, jurisdiction: 'INVALIDA' }, { ip: 'api-invalid-payload' })).status, 400);
        assert.equal(calls, 0);
    } finally {
        global.fetch = oldFetch;
        if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = oldKey;
    }
});

test('POST /api/analyze aplica cuota de invitado por IP y cuota de cuenta autenticada', async () => {
    const oldKey = process.env.GEMINI_API_KEY;
    const oldFetch = global.fetch;
    let calls = 0;
    process.env.GEMINI_API_KEY = 'api-test-secret';
    global.fetch = async () => { calls += 1; return geminiResponse(); };
    const store = {
        getSession(token) {
            return token === 'signed-test' ? { user: { id: 998877 } } : null;
        }
    };
    const post = createApi(store);
    try {
        for (let count = 0; count < 3; count += 1) {
            assert.equal((await post(input, { ip: 'api-guest-quota' })).status, 200);
        }
        const guestLimited = await post(input, { ip: 'api-guest-quota' });
        assert.equal(guestLimited.status, 429);
        assert.ok(Number(guestLimited.headers['Retry-After']) > 0);

        for (let count = 0; count < 12; count += 1) {
            assert.equal((await post(input, { ip: 'api-account-quota-' + count, cookie: 'ai_session=signed-test' })).status, 200);
        }
        const accountLimited = await post(input, { ip: 'api-account-quota-final', cookie: 'ai_session=signed-test' });
        assert.equal(accountLimited.status, 429);
        assert.ok(Number(accountLimited.headers['Retry-After']) > 0);
        assert.equal(calls, 15);
    } finally {
        global.fetch = oldFetch;
        if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = oldKey;
    }
});
