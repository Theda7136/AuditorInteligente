'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('./js/audit-engine.js');
const crypto = require('node:crypto');
const { createAuthStore } = require('./auth-store.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8765;
const MAX_BODY_BYTES = 1_500_000;
const MAX_REQUESTS_PER_MINUTE = 20;
const ANALYSIS_WINDOW_MS = 60 * 60 * 1000;
const GUEST_ANALYSES_PER_IP = 3;
const ANALYSES_PER_USER = 12;
const ANALYSES_PER_IP = 20;
const AUTH_COOKIE = 'ai_session';
const CSRF_COOKIE = 'ai_csrf';
const PASSWORD_MIN_LENGTH = 10;
const requestCounts = new Map();
const analysisCounts = new Map();
const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon'
};

function loadEnvFile() {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;

    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match || Object.hasOwn(process.env, match[1])) continue;
        process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
}

function sendJson(response, status, payload) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(payload));
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        request.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('La solicitud supera el tamaño permitido.'), { status: 413 }));
                request.destroy();
                return;
            }
            body += chunk;
        });
        request.on('end', () => {
            try {
                resolve(JSON.parse(body || '{}'));
            } catch (error) {
                reject(Object.assign(new Error('El cuerpo de la solicitud no es JSON válido.'), { status: 400 }));
            }
        });
        request.on('error', reject);
    });
}

function isRateLimited(request) {
    const now = Date.now();
    const address = request.socket.remoteAddress || 'unknown';
    const previous = requestCounts.get(address);
    if (!previous || now - previous.startedAt >= 60_000) {
        requestCounts.set(address, { startedAt: now, count: 1 });
        if (requestCounts.size > 1024) {
            for (const [key, value] of requestCounts) {
                if (now - value.startedAt >= 60_000) requestCounts.delete(key);
            }
        }
        return false;
    }
    previous.count += 1;
    return previous.count > MAX_REQUESTS_PER_MINUTE;
}

function normalizeAnalysisInput(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { error: { status: 400, body: { code: 'INVALID_INPUT', error: 'La solicitud debe ser un objeto JSON.' } } };
    }
    const contractText = typeof payload.contractText === 'string' ? payload.contractText.trim() : '';
    if (!contractText) {
        return { error: { status: 400, body: { code: 'INVALID_INPUT', error: 'Debes enviar el texto del contrato.' } } };
    }
    if (contractText.length > engine.MAX_GEMINI_CHARS * 2) {
        return { error: { status: 413, body: { code: 'DOCUMENT_TOO_LARGE', error: 'El documento supera el límite permitido.' } } };
    }

    const contractTypes = ['Servicios', 'NDA', 'Arrendamiento', 'Compraventa', 'Licitación', 'Laboral', 'Distribución', 'Otro'];
    if (payload.contractType !== undefined && !contractTypes.includes(payload.contractType)) {
        return { error: { status: 400, body: { code: 'INVALID_INPUT', error: 'El tipo de contrato no es válido.' } } };
    }
    if (payload.jurisdiction !== undefined && !Object.hasOwn(engine.JURISDICTIONS, payload.jurisdiction)) {
        return { error: { status: 400, body: { code: 'INVALID_INPUT', error: 'La jurisdicción no es válida.' } } };
    }
    if (payload.party !== undefined && !['proveedor', 'cliente', 'neutral'].includes(payload.party)) {
        return { error: { status: 400, body: { code: 'INVALID_INPUT', error: 'La parte representada no es válida.' } } };
    }
    if (payload.model !== undefined && !engine.MODELS.some(model => model.id === payload.model)) {
        return { error: { status: 400, body: { code: 'INVALID_INPUT', error: 'El modelo seleccionado no es válido.' } } };
    }

    const priorities = payload.priorities === undefined ? {} : payload.priorities;
    const priorityValues = ['alta', 'media', 'baja'];
    if (!priorities || typeof priorities !== 'object' || Array.isArray(priorities)
        || ['financial', 'abusive', 'penalties', 'compliance'].some(key =>
            priorities[key] !== undefined && !priorityValues.includes(priorities[key]))) {
        return { error: { status: 400, body: { code: 'INVALID_INPUT', error: 'Las prioridades no tienen un formato válido.' } } };
    }

    return {
        value: {
            contractText,
            model: engine.knownModel(payload.model),
            contractType: payload.contractType || 'Servicios',
            jurisdiction: payload.jurisdiction || 'CO',
            party: payload.party || 'neutral',
            priorities: {
                financial: priorities.financial || 'media',
                abusive: priorities.abusive || 'media',
                penalties: priorities.penalties || 'media',
                compliance: priorities.compliance || 'media'
            }
        }
    };
}

function analysisQuota(request, userId, now = Date.now()) {
    const address = request.socket.remoteAddress || 'unknown';
    const ipKey = 'ip:' + crypto.createHash('sha256').update(address).digest('hex');
    const userKey = userId ? 'user:' + String(userId) : null;
    const checks = [{ key: ipKey, limit: ANALYSES_PER_IP }];
    if (userKey) checks.push({ key: userKey, limit: ANALYSES_PER_USER });
    else checks.push({ key: 'guest:' + ipKey, limit: GUEST_ANALYSES_PER_IP });

    if (analysisCounts.size > 2048) {
        for (const [key, value] of analysisCounts) {
            if (now - value.startedAt >= ANALYSIS_WINDOW_MS) analysisCounts.delete(key);
        }
    }
    for (const check of checks) {
        const current = analysisCounts.get(check.key);
        if (current && now - current.startedAt < ANALYSIS_WINDOW_MS && current.count >= check.limit) {
            return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.startedAt + ANALYSIS_WINDOW_MS - now) / 1000)) };
        }
    }
    for (const check of checks) {
        const current = analysisCounts.get(check.key);
        if (!current || now - current.startedAt >= ANALYSIS_WINDOW_MS) {
            analysisCounts.set(check.key, { startedAt: now, count: 1 });
        } else {
            current.count += 1;
        }
    }
    return { allowed: true, retryAfter: 0 };
}

function analyzeOriginAllowed(request) {
    const site = request.headers['sec-fetch-site'];
    if (site === 'cross-site') return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
        return new URL(origin).host === request.headers.host;
    } catch (error) {
        return false;
    }
}

function analyzeEnvelopeError(request) {
    if (!analyzeOriginAllowed(request)) {
        return { status: 403, body: { code: 'ORIGIN', error: 'La solicitud debe originarse en esta aplicación.' } };
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
        return { status: 415, body: { code: 'CONTENT_TYPE', error: 'La solicitud debe usar application/json.' } };
    }
    return null;
}

function authorizeAnalysis(request, payload, session, now = Date.now()) {
    const normalized = normalizeAnalysisInput(payload);
    if (normalized.error) return { error: normalized.error };
    if (!process.env.GEMINI_API_KEY) {
        return { error: { status: 503, body: { code: 'NOT_CONFIGURED', error: 'Gemini no está configurado en el servidor.' } } };
    }
    const quota = analysisQuota(request, session && session.user.id, now);
    if (!quota.allowed) {
        return {
            error: {
                status: 429,
                headers: { 'Retry-After': String(quota.retryAfter) },
                body: { code: 'QUOTA', error: 'Se alcanzó el límite de análisis. Inténtalo más tarde.' }
            }
        };
    }
    return { input: normalized.value };
}

async function analyzeContract(payload) {
    const normalized = normalizeAnalysisInput(payload);
    if (normalized.error) return normalized.error;
    payload = normalized.value;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return { status: 503, body: { code: 'NOT_CONFIGURED', error: 'Gemini no está configurado en el servidor.' } };
    }

    const contractText = payload.contractText;

    const model = engine.knownModel(payload.model);
    const request = engine.buildGeminiRequest({
        model,
        contractText,
        contractType: payload.contractType,
        jurisdiction: payload.jurisdiction,
        party: payload.party,
        priorities: payload.priorities
    });
    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/'
        + encodeURIComponent(request.model) + ':generateContent';

    let upstream;
    try {
        upstream = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify(request.body),
            signal: AbortSignal.timeout(45_000)
        });
    } catch (error) {
        return { status: 502, body: { code: 'UPSTREAM_ERROR', error: 'No fue posible conectar con Gemini.' } };
    }

    const responseBody = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
        const status = upstream.status === 429 ? 429 : upstream.status === 404 ? 400 : 502;
        const message = upstream.status === 429
            ? 'Gemini limitó las solicitudes. Inténtalo de nuevo más tarde.'
            : upstream.status === 404
                ? 'El modelo seleccionado no está disponible.'
                : 'Gemini no pudo procesar el documento.';
        return { status, body: { code: upstream.status === 429 ? 'RATE' : 'UPSTREAM_ERROR', error: message } };
    }

    const rawText = responseBody.candidates?.[0]?.content?.parts?.find(part => part.text)?.text;
    if (!rawText) {
        return { status: 502, body: { code: 'EMPTY_RESPONSE', error: 'Gemini no devolvió un análisis legible.' } };
    }

    try {
        const cleaned = rawText.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
        return {
            status: 200,
            body: {
                analysis: engine.normalizeAnalysis(JSON.parse(cleaned)),
                model: request.model,
                truncated: request.truncated,
                originalLength: request.originalLength,
                analyzedLength: request.analyzedLength
            }
        };
    } catch (error) {
        return { status: 502, body: { code: 'INVALID_RESPONSE', error: 'Gemini devolvió una respuesta que no se pudo interpretar.' } };
    }
}

function serveStatic(request, response) {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const requestedPath = pathname === '/' ? '/index.html' : pathname;
    const allowed = requestedPath === '/index.html'
        || requestedPath.startsWith('/css/')
        || requestedPath.startsWith('/js/');
    const filePath = path.resolve(ROOT, '.' + requestedPath);
    const isPublicAsset = filePath === path.join(ROOT, 'index.html')
        || filePath.startsWith(path.join(ROOT, 'css') + path.sep)
        || filePath.startsWith(path.join(ROOT, 'js') + path.sep);
    if (!allowed || !isPublicAsset || requestedPath.split('/').some(part => part.startsWith('.'))) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
    }
    fs.readFile(filePath, (error, content) => {
        if (error) {
            response.writeHead(error.code === 'ENOENT' ? 404 : 500);
            response.end('Not found');
            return;
        }
        response.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(content);
    });
}

function parseCookies(header) {
    return Object.fromEntries(String(header || '').split(';').map(part => {
        const separator = part.indexOf('=');
        if (separator < 0) return ['', ''];
        return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
    }).filter(([name]) => name));
}

function cookieOptions(maxAge) {
    return `Path=/; SameSite=Strict; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

function setAuthCookies(response, session) {
    response.setHeader('Set-Cookie', [
        `${AUTH_COOKIE}=${encodeURIComponent(session.token)}; ${cookieOptions(Math.floor((session.expiresAt - Date.now()) / 1000))}; HttpOnly`,
        `${CSRF_COOKIE}=${encodeURIComponent(session.csrfToken)}; ${cookieOptions(Math.floor((session.expiresAt - Date.now()) / 1000))}`
    ]);
}

function clearAuthCookies(response) {
    response.setHeader('Set-Cookie', [
        `${AUTH_COOKIE}=; ${cookieOptions(0)}; HttpOnly`,
        `${CSRF_COOKIE}=; ${cookieOptions(0)}`
    ]);
}

function createServer(options = {}) {
    const store = options.store || createAuthStore(options.dbPath || path.join(ROOT, 'data', 'auditor-inteligente.sqlite'));
    const ownStore = !options.store;

    function getSession(request) {
        const cookies = parseCookies(request.headers.cookie);
        return store.getSession(cookies[AUTH_COOKIE]);
    }

    function csrfIsValid(request, session) {
        const cookies = parseCookies(request.headers.cookie);
        const cookieToken = cookies[CSRF_COOKIE];
        const headerToken = request.headers['x-csrf-token'];
        if (!cookieToken || !headerToken || cookieToken !== headerToken) return false;
        if (session && session.csrfToken !== headerToken) return false;
        const origin = request.headers.origin;
        if (origin) {
            try {
                if (new URL(origin).host !== request.headers.host) return false;
            } catch (error) {
                return false;
            }
        }
        return true;
    }

    async function handleAuth(request, response, pathname) {
        if (request.method === 'GET' && pathname === '/api/auth/csrf') {
            const activeSession = getSession(request);
            const token = activeSession ? activeSession.csrfToken : crypto.randomBytes(24).toString('base64url');
            response.setHeader('Set-Cookie', `${CSRF_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions(3600)}`);
            sendJson(response, 200, { csrfToken: token });
            return true;
        }

        const authRoutes = ['/api/auth/register', '/api/auth/login', '/api/auth/logout'];
        if (!authRoutes.includes(pathname)) return false;
        if (request.method !== 'POST') {
            response.writeHead(405, { Allow: 'POST' });
            response.end();
            return true;
        }

        if (isRateLimited(request)) {
            sendJson(response, 429, { code: 'RATE', error: 'Demasiados intentos. Espera un minuto.' });
            return true;
        }
        const session = getSession(request);
        if (!csrfIsValid(request, session)) {
            sendJson(response, 403, { code: 'CSRF', error: 'La sesión de seguridad expiró. Recarga la página e inténtalo de nuevo.' });
            return true;
        }

        const payload = await readJson(request);
        if (pathname === '/api/auth/logout') {
            if (session) store.destroySession(session.tokenHash);
            clearAuthCookies(response);
            sendJson(response, 200, { authenticated: false });
            return true;
        }

        const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
        const password = typeof payload.password === 'string' ? payload.password : '';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
            sendJson(response, 400, { code: 'INVALID_EMAIL', error: 'Introduce un correo electrónico válido.' });
            return true;
        }
        if (password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
            sendJson(response, 400, { code: 'INVALID_PASSWORD', error: `La contraseña debe tener entre ${PASSWORD_MIN_LENGTH} y 128 caracteres.` });
            return true;
        }

        let user;
        if (pathname === '/api/auth/register') {
            user = store.register(email, password);
            if (!user) {
                sendJson(response, 409, { code: 'EMAIL_EXISTS', error: 'Ya existe una cuenta con ese correo.' });
                return true;
            }
        } else {
            user = store.authenticate(email, password);
            if (!user) {
                sendJson(response, 401, { code: 'INVALID_CREDENTIALS', error: 'Correo o contraseña incorrectos.' });
                return true;
            }
        }

        if (session) store.destroySession(session.tokenHash);
        const created = store.createSession(user.id);
        setAuthCookies(response, created);
        sendJson(response, pathname.endsWith('/register') ? 201 : 200, {
            authenticated: true,
            user: { id: user.id, email: user.email }
        });
        return true;
    }

    return http.createServer(async (request, response) => {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'same-origin');
        response.setHeader('X-Frame-Options', 'DENY');
        const pathname = new URL(request.url, 'http://localhost').pathname;

        try {
            if (await handleAuth(request, response, pathname)) return;

            if (request.method === 'GET' && pathname === '/api/health') {
                sendJson(response, 200, { status: 'ok', gemini: Boolean(process.env.GEMINI_API_KEY) });
                return;
            }

            if (request.method === 'GET' && pathname === '/api/auth/me') {
                const session = getSession(request);
                sendJson(response, 200, session
                    ? { authenticated: true, user: session.user }
                    : { authenticated: false, user: null });
                return;
            }

            if (pathname.startsWith('/api/history')) {
                const session = getSession(request);
                if (!session) {
                    sendJson(response, 401, { code: 'AUTH_REQUIRED', error: 'Inicia sesión para acceder al historial.' });
                    return;
                }
                if (request.method === 'GET' && pathname === '/api/history') {
                    sendJson(response, 200, { history: store.listAnalyses(session.user.id) });
                    return;
                }
                if (!csrfIsValid(request, session)) {
                    sendJson(response, 403, { code: 'CSRF', error: 'La sesión de seguridad expiró. Recarga la página.' });
                    return;
                }
                if (request.method === 'POST' && pathname === '/api/history') {
                    const entry = await readJson(request);
                    const title = typeof entry.title === 'string' ? entry.title.trim().slice(0, 80) : '';
                    const excerpt = typeof entry.excerpt === 'string' ? entry.excerpt.slice(0, 400) : '';
                    const data = entry.data;
                    if (!title || !data || !Number.isInteger(data.score) || data.score < 0 || data.score > 100) {
                        sendJson(response, 400, { code: 'INVALID_HISTORY', error: 'El análisis enviado no tiene un formato válido.' });
                        return;
                    }
                    const serialized = JSON.stringify(data);
                    if (serialized.length > 100_000) {
                        sendJson(response, 413, { code: 'HISTORY_TOO_LARGE', error: 'El resultado supera el tamaño permitido.' });
                        return;
                    }
                    const id = store.saveAnalysis(session.user.id, { title, excerpt, score: data.score, data });
                    sendJson(response, 201, { id });
                    return;
                }
                const match = pathname.match(/^\/api\/history\/(\d+)$/);
                if (request.method === 'DELETE' && match) {
                    const deleted = store.deleteAnalysis(Number(match[1]), session.user.id);
                    sendJson(response, deleted ? 200 : 404, { deleted });
                    return;
                }
                if (request.method === 'DELETE' && pathname === '/api/history') {
                    store.clearAnalyses(session.user.id);
                    sendJson(response, 200, { cleared: true });
                    return;
                }
            }

            if (request.method === 'POST' && pathname === '/api/analyze') {
                const envelopeError = analyzeEnvelopeError(request);
                if (envelopeError) {
                    sendJson(response, envelopeError.status, envelopeError.body);
                    return;
                }
                const payload = await readJson(request);
                const session = getSession(request);
                const authorization = authorizeAnalysis(request, payload, session);
                if (authorization.error) {
                    if (authorization.error.headers) response.setHeader('Retry-After', authorization.error.headers['Retry-After']);
                    sendJson(response, authorization.error.status, authorization.error.body);
                    return;
                }
                const outcome = await analyzeContract(authorization.input);
                sendJson(response, outcome.status, outcome.body);
                return;
            }

            if (request.method !== 'GET' && request.method !== 'HEAD') {
                response.writeHead(405, { Allow: 'GET, HEAD' });
                response.end();
                return;
            }
            serveStatic(request, response);
        } catch (error) {
            sendJson(response, error.status || 500, {
                code: 'SERVER_ERROR',
                error: error.status ? error.message : 'Ocurrió un error interno en el servidor.'
            });
        }
    }).on('close', () => {
        if (ownStore) store.close();
    });
}

if (require.main === module) {
    loadEnvFile();
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    createServer().listen(PORT, () => {
        console.log(`Auditor Inteligente disponible en http://localhost:${PORT}`);
        if (!process.env.GEMINI_API_KEY) console.log('Gemini no está configurado; el motor local seguirá disponible.');
    });
}

module.exports = {
    createServer,
    loadEnvFile,
    analyzeContract,
    normalizeAnalysisInput,
    analysisQuota,
    analyzeOriginAllowed,
    analyzeEnvelopeError,
    authorizeAnalysis,
    parseCookies
};

