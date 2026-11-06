const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../js/audit-engine.js');

const SAMPLE = `CONTRATO DE PRESTACIÓN DE SERVICIOS
1. OBJETO: servicios de consultoría por 24 meses.
2. PRECIO: USD $120,000 con penalización del 2% diario por mora.
3. CONFIDENCIALIDAD: por tiempo indefinido luego de finalizado el contrato.
4. TERMINACIÓN: El CLIENTE podrá dar por terminado el contrato unilateralmente con 15 días y sin responsabilidad alguna.
5. RESPONSABILIDAD: El PROVEEDOR solo será responsable por daños directos hasta el monto de una cuota mensual, excluyendo daños indirectos o consecuenciales.`;

const CLEAN = `CONTRATO DE PRESTACIÓN DE SERVICIOS
El proveedor prestará soporte durante 12 meses por USD 1000 mensuales, pagaderos dentro de los 15 días de la factura.
La confidencialidad dura 3 años después de terminado el contrato.
Cualquiera de las partes puede terminar con un aviso escrito de 60 días, pagando el trabajo ya ejecutado.
La ley aplicable es la de Colombia y los conflictos se someten a los tribunales de Bogotá.
La responsabilidad de cada parte se limita al valor anual del contrato, de forma recíproca.`;

test('el contrato de ejemplo concentra terminación, mora y confidencialidad', function () {
    const result = engine.runLocalSimulation(SAMPLE, {
        contractType: 'Servicios',
        jurisdiction: 'CO',
        party: 'proveedor',
        priorities: { financial: 'media', abusive: 'alta', penalties: 'alta', compliance: 'media' }
    });
    assert.ok(result.score >= 70);
    const titles = result.alerts.map(function (alert) { return alert.title; });
    assert.ok(titles.some(function (title) { return /unilateral/i.test(title); }));
    assert.ok(titles.some(function (title) { return /mora|penal/i.test(title); }));
    const penalty = result.alerts.find(function (alert) { return /mora|penal/i.test(alert.title); });
    assert.match(penalty.excerpt, /2%\s*diario/);
    assert.match(result.recommendations.join(' '), /Colombia|1601/);
});

test('un contrato equilibrado no dispara las reglas críticas', function () {
    const result = engine.runLocalSimulation(CLEAN, {
        contractType: 'Servicios',
        jurisdiction: 'CO',
        party: 'neutral',
        priorities: { financial: 'media', abusive: 'media', penalties: 'media', compliance: 'media' }
    });
    assert.ok(result.score < 40);
    assert.equal(result.alerts.some(function (alert) { return /unilateral|mora|indefinida|No se identifica/i.test(alert.title); }), false);
});

test('la prioridad baja reduce el peso frente a la prioridad alta', function () {
    const base = {
        contractType: 'Servicios',
        jurisdiction: 'CO',
        party: 'proveedor'
    };
    const high = engine.runLocalSimulation(SAMPLE, Object.assign({}, base, {
        priorities: { financial: 'alta', abusive: 'alta', penalties: 'alta', compliance: 'alta' }
    }));
    const low = engine.runLocalSimulation(SAMPLE, Object.assign({}, base, {
        priorities: { financial: 'baja', abusive: 'baja', penalties: 'baja', compliance: 'baja' }
    }));
    assert.ok(high.score > low.score);
});

test('quien representa al cliente ve menos riesgo en una salida a su favor', function () {
    const options = {
        contractType: 'Servicios',
        jurisdiction: 'MX',
        priorities: { financial: 'media', abusive: 'alta', penalties: 'media', compliance: 'media' }
    };
    const provider = engine.runLocalSimulation(SAMPLE, Object.assign({ party: 'proveedor' }, options));
    const client = engine.runLocalSimulation(SAMPLE, Object.assign({ party: 'cliente' }, options));
    assert.ok(provider.score > client.score);
    const clientAlert = client.alerts.find(function (alert) { return /unilateral/i.test(alert.title); });
    assert.equal(clientAlert.level, 'medium');
});

test('un NDA sube el peso de la confidencialidad indefinida', function () {
    const nda = 'ACUERDO DE CONFIDENCIALIDAD. Las partes guardarán la información por tiempo indefinido.';
    const asNda = engine.runLocalSimulation(nda, {
        contractType: 'NDA',
        jurisdiction: 'ES',
        party: 'neutral',
        priorities: { abusive: 'alta', financial: 'baja', penalties: 'baja', compliance: 'media' }
    });
    const asSale = engine.runLocalSimulation(nda, {
        contractType: 'Compraventa',
        jurisdiction: 'ES',
        party: 'neutral',
        priorities: { abusive: 'alta', financial: 'baja', penalties: 'baja', compliance: 'media' }
    });
    assert.ok(asNda.score > asSale.score);
    assert.match(asNda.recommendations.join(' '), /España|2 a 5 años/);
});

test('el informe incluye la cita y la jurisdicción', function () {
    const result = engine.runLocalSimulation(SAMPLE, {
        contractType: 'Licitación',
        jurisdiction: 'CL',
        party: 'cliente',
        priorities: { financial: 'alta', abusive: 'alta', penalties: 'alta', compliance: 'alta' }
    });
    result.date = '03/11/2026';
    result.source = 'Simulación heurística local';
    const report = engine.buildReportText(result);
    assert.match(report, /Chile/);
    assert.match(report, /Cita:/);
    assert.match(report, /2% diario/);
    assert.match(report, /No reemplaza el criterio de un abogado/);
});

test('la petición a Gemini no pone la clave en la URL y exige cita', function () {
    const longText = 'Cláusula. '.repeat(40000);
    const request = engine.buildGeminiRequest({
        model: 'gemini-1.5-flash',
        contractText: longText,
        contractType: 'Servicios',
        jurisdiction: 'CO',
        party: 'proveedor',
        priorities: { financial: 'alta', abusive: 'media', penalties: 'alta', compliance: 'baja' }
    });
    assert.equal(request.endpoint.includes('key='), false);
    assert.equal(request.model, engine.DEFAULT_MODEL);
    assert.equal(request.truncated, true);
    assert.equal(request.body.systemInstruction.parts[0].text.includes('Colombia'), true);
    assert.equal(request.body.generationConfig.temperature, undefined);
    assert.equal(request.body.generationConfig.responseSchema.properties.alerts.items.required.includes('excerpt'), true);
    assert.match(request.body.contents[0].parts[0].text, /recortado/);
});

test('el historial guarda extracto y puede omitir el texto completo', function () {
    const data = { score: 80, source: 'local', date: 'hoy', contractType: 'NDA' };
    const stored = engine.createHistoryRecord({ title: 'NDA\nprivado', fullText: SAMPLE, data: data, storeFullText: false });
    assert.equal(stored.textStored, false);
    assert.equal(stored.fullText, undefined);
    assert.ok(stored.excerpt.length > 40);
    assert.equal(stored.title.includes('\n'), false);

    const withText = engine.createHistoryRecord({ title: 'NDA', fullText: SAMPLE, data: data, storeFullText: true, id: 5 });
    const slim = engine.withoutFullText(withText);
    assert.equal(slim.fullText, undefined);
    assert.equal(slim.textStored, false);

    const history = [];
    for (let i = 0; i < 20; i += 1) {
        history.splice(0, history.length, ...engine.pushHistory(history, { id: i }));
    }
    assert.equal(history.length, engine.HISTORY_LIMIT);
});

test('una respuesta de modelo se normaliza', function () {
    const normalized = engine.normalizeAnalysis({
        score: 140,
        alerts: [{ level: 'alto', title: 'Foro', desc: 'Renuncia', excerpt: 'renuncian al fuero' }],
        recommendations: ['Cambiar la sede.']
    });
    assert.equal(normalized.score, 100);
    assert.equal(normalized.alerts[0].level, 'medium');
    assert.equal(normalized.alerts[0].excerpt, 'renuncian al fuero');
});
