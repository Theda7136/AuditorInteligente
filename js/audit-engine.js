(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.AuditEngine = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const HISTORY_LIMIT = 15;
    const STORED_EXCERPT = 1500;
    const MAX_GEMINI_CHARS = 350000;
    const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

    const PRIORITY_WEIGHT = { alta: 1.35, media: 1, baja: 0.45 };

    const MODELS = [
        { id: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite (rápido)', thinkingLevel: 'LOW' },
        { id: 'gemini-3.6-flash', label: 'gemini-3.6-flash (equilibrio)', thinkingLevel: 'MEDIUM' },
        { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash (análisis profundo)', thinkingLevel: 'MEDIUM' }
    ];

    const JURISDICTIONS = {
        CO: {
            label: 'Colombia',
            penalty: 'En Colombia conviene contrastar la pena con la facultad judicial de reducir la cláusula penal excesiva (Código Civil, art. 1601) y con la tasa máxima de interés moratorio.',
            confidentiality: 'Un plazo de 2 a 5 años suele ser negociable. Si hay datos personales, la obligación debe convivir con la Ley 1581 de 2012.',
            unilateral: 'Una salida unilateral sin indemnización ni plazo real puede romper el equilibrio del contrato y conviene volverla recíproca.',
            liability: 'El tope debería cubrir al menos el valor del contrato o el seguro disponible, sin vaciar la obligación principal.',
            compliance: 'Conviene fijar ley colombiana y una sede judicial o arbitral concreta.'
        },
        MX: {
            label: 'México',
            penalty: 'En México la pena convencional puede reducirse si es desproporcionada. Conviene toparla y separarla del interés moratorio.',
            confidentiality: 'Acota la confidencialidad a un plazo cierto. Si hay datos personales, revisa también la LFPDPPP.',
            unilateral: 'La rescisión sin causa debería ser recíproca, con preaviso y pago de lo devengado.',
            liability: 'Un tope muy bajo a favor de una sola parte deja a la otra sin remedio útil frente al incumplimiento.',
            compliance: 'Indica ley aplicable y tribunales o arbitraje con sede en México, salvo pacto distinto expreso.'
        },
        ES: {
            label: 'España',
            penalty: 'En operaciones comerciales, el interés de demora tiene un marco legal (Ley 3/2004). Una pena diaria muy alta puede ser reducible por los tribunales.',
            confidentiality: 'Sustituye la duración indefinida por un plazo de 2 a 5 años y separa los secretos empresariales del resto de información.',
            unilateral: 'El desistimiento unilateral sin compensación es un punto típico de negociación y debería ser recíproco.',
            liability: 'La exclusión total de daños previsibles puede dejar la obligación sin contenido práctico.',
            compliance: 'Si hay condiciones generales, cuida la incorporación y el control de cláusulas abusivas entre las partes.'
        },
        PE: {
            label: 'Perú',
            penalty: 'La cláusula penal peruana puede moderarse cuando es manifiestamente excesiva. Conviene un tope y una tasa de mora identificable.',
            confidentiality: 'Fija un plazo posterior a la terminación, habitualmente entre 2 y 5 años.',
            unilateral: 'Exige preaviso, reciprocidad y pago de prestaciones ya ejecutadas.',
            liability: 'Revisa que el límite no sea simbólico frente al valor del contrato.',
            compliance: 'Pacta ley peruana y sede de controversias de forma expresa.'
        },
        CL: {
            label: 'Chile',
            penalty: 'La cláusula penal puede rebajarse si es excesiva (Código Civil, art. 1544). Evita acumular pena diaria e interés moratorio sin tope.',
            confidentiality: 'Limita la confidencialidad a un plazo cierto después del término.',
            unilateral: 'La terminación sin expresión de causa debería avisar con antelación y liquidar lo ejecutado.',
            liability: 'El tope tiene que guardar proporción con el precio y con los daños directos previsibles.',
            compliance: 'Deja por escrito la ley chilena y el tribunal o árbitro competente.'
        },
        AR: {
            label: 'Argentina',
            penalty: 'El Código Civil y Comercial permite morigerar la cláusula penal desproporcionada. Conviene un tope claro.',
            confidentiality: 'Reemplaza la vigencia indefinida por un plazo de 2 a 5 años.',
            unilateral: 'La resolución sin culpa de la otra parte debería ser recíproca y con preaviso.',
            liability: 'Una dispensa amplia de daños deja el contrato desbalanceado.',
            compliance: 'Indica ley argentina y el foro o arbitraje aplicable.'
        },
        OTRO: {
            label: 'Otra jurisdicción',
            penalty: 'Compara la pena con el estándar del mercado y con el límite que suela admitir la ley del contrato.',
            confidentiality: 'Sustituye "indefinido" por un plazo cierto de 2 a 5 años.',
            unilateral: 'Pide reciprocidad, preaviso de 30 a 60 días y pago de lo devengado.',
            liability: 'El tope debería ser recíproco y cercano al valor del contrato o a la póliza.',
            compliance: 'El contrato debería decir qué ley y qué tribunal o arbitraje lo rigen.'
        }
    };

    const TYPE_WEIGHT = {
        Servicios: { abusive: 1.1, financial: 1, penalties: 1.05, compliance: 1 },
        NDA: { abusive: 1.45, financial: 0.55, penalties: 0.7, compliance: 1.15 },
        Arrendamiento: { abusive: 1.05, financial: 1.2, penalties: 1.25, compliance: 1 },
        Compraventa: { abusive: 1, financial: 1.25, penalties: 1.05, compliance: 1 },
        'Licitación': { abusive: 1, financial: 1.1, penalties: 1.35, compliance: 1.45 },
        Laboral: { abusive: 1.35, financial: 1, penalties: 1.15, compliance: 1.35 },
        'Distribución': { abusive: 1.25, financial: 1.1, penalties: 1, compliance: 1.05 },
        Otro: { abusive: 1, financial: 1, penalties: 1, compliance: 1 }
    };

    const AUDIT_SCHEMA = {
        type: 'OBJECT',
        properties: {
            score: { type: 'INTEGER', description: '0 sin riesgo, 100 riesgo crítico' },
            alerts: {
                type: 'ARRAY',
                items: {
                    type: 'OBJECT',
                    properties: {
                        level: { type: 'STRING', enum: ['high', 'medium', 'low'] },
                        title: { type: 'STRING' },
                        desc: { type: 'STRING' },
                        excerpt: { type: 'STRING', description: 'Cita literal breve del contrato' }
                    },
                    required: ['level', 'title', 'desc', 'excerpt']
                }
            },
            recommendations: {
                type: 'ARRAY',
                items: { type: 'STRING' }
            }
        },
        required: ['score', 'alerts', 'recommendations']
    };

    function riskLabel(score) {
        if (score >= 70) return 'ALTO / CRÍTICO';
        if (score >= 40) return 'MEDIO';
        return 'BAJO / CONTROLADO';
    }

    function riskBand(score) {
        if (score >= 70) return 'high';
        if (score >= 40) return 'medium';
        return 'low';
    }

    function clampScore(value) {
        const number = Math.round(Number(value));
        if (!Number.isFinite(number)) return 50;
        return Math.min(100, Math.max(0, number));
    }

    function weightFor(priority) {
        return PRIORITY_WEIGHT[priority] || 1;
    }

    function excerptAround(text, index, matchLength) {
        let start = Math.max(0, index - 90);
        let end = Math.min(text.length, index + matchLength + 90);
        if (start > 0) {
            const nextSpace = text.indexOf(' ', start);
            if (nextSpace !== -1 && nextSpace < index) start = nextSpace + 1;
        }
        if (end < text.length) {
            const previousSpace = text.lastIndexOf(' ', end);
            if (previousSpace > index + matchLength) end = previousSpace;
        }
        return text.slice(start, end).replace(/\s+/g, ' ').trim();
    }

    function firstMatch(text, patterns) {
        for (const pattern of patterns) {
            const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
            const regex = new RegExp(pattern.source, flags);
            const match = regex.exec(text);
            if (match) {
                return { index: match.index, text: match[0] };
            }
        }
        return null;
    }

    function downgrade(level) {
        if (level === 'high') return 'medium';
        if (level === 'medium') return 'low';
        return 'low';
    }

    function partyFactor(ruleId, party, excerpt) {
        const sample = (excerpt || '').toLowerCase();
        const mentionsClient = /cliente/.test(sample);
        if (ruleId === 'unilateral') {
            if (party === 'cliente' && mentionsClient) return 0.55;
            if (party === 'proveedor' && mentionsClient) return 1.25;
        }
        if (ruleId === 'liability') {
            if (party === 'cliente') return 1.4;
            if (party === 'proveedor') return 0.7;
        }
        return 1;
    }

    const RULES = [
        {
            id: 'unilateral',
            category: 'abusive',
            base: 18,
            level: 'high',
            patterns: [/unilateral(?:mente)?/i, /sin responsabilidad alguna/i, /a su sola discreci[oó]n/i],
            title: 'Terminación unilateral',
            describe: function (party) {
                if (party === 'cliente') {
                    return 'El texto permite terminar el contrato por decisión de una parte, con poco margen para la otra. Desde el lado del cliente el efecto es menor, pero la redacción sigue siendo desigual.';
                }
                if (party === 'proveedor') {
                    return 'La otra parte puede terminar el contrato por su sola decisión, con un preaviso corto o sin compensación por el trabajo ya hecho.';
                }
                return 'Hay una facultad de terminación unilateral sin un equilibrio claro de preaviso y compensación.';
            },
            recommend: function (law) {
                return 'Pide que la terminación sin causa sea recíproca, con preaviso de 30 a 60 días y pago de lo ya ejecutado. ' + law.unilateral;
            }
        },
        {
            id: 'penalty',
            category: 'penalties',
            base: 12,
            level: 'medium',
            patterns: [/penalizaci[oó]n/i, /cl[aá]usula penal/i, /inter[eé]s(?:es)?\s+moratori/i, /por mora/i, /(\d+(?:[.,]\d+)?)\s*%\s*(?:diari|mensual)/i],
            title: 'Penalidad o mora desproporcionada',
            describe: function (_party, context) {
                if (context.dailyRate !== null && context.dailyRate >= 1) {
                    return 'La mora o penalidad del ' + context.dailyRate + '% diario crece más rápido que el estándar habitual de mercado y puede superar el valor de la obligación.';
                }
                return 'El contrato impone una penalidad o un interés de mora que hay que topar y comparar con la práctica del mercado.';
            },
            recommend: function (law) {
                return 'Negocia un tope (por ejemplo 10% del precio) y una tasa mensual identificable, sin acumular pena e intereses sobre lo mismo. ' + law.penalty;
            },
            extra: function (text) {
                const daily = text.match(/(\d+(?:[.,]\d+)?)\s*%\s*diari/i);
                if (!daily) return { score: 0, level: null, dailyRate: null };
                const rate = parseFloat(daily[1].replace(',', '.'));
                if (rate >= 1) return { score: 8, level: 'high', dailyRate: rate };
                return { score: 3, level: 'medium', dailyRate: rate };
            }
        },
        {
            id: 'indefinite',
            category: 'abusive',
            base: 8,
            level: 'medium',
            patterns: [/indefinid(?:o|a|amente)/i, /tiempo indeterminad/i, /por siempre/i],
            title: 'Obligación de duración indefinida',
            describe: function () {
                return 'Hay un deber —a menudo de confidencialidad o no competencia— sin fecha de fin. Eso alarga el riesgo más allá de la relación contractual.';
            },
            recommend: function (law) {
                return law.confidentiality;
            }
        },
        {
            id: 'liability',
            category: 'financial',
            base: 10,
            level: 'medium',
            patterns: [/daños (?:indirectos|consecuenciales|emergentes)/i, /l[ií]mite de responsabilidad/i, /limitaci[oó]n de responsabilidad/i, /solo ser[aá] responsable/i, /hasta el monto de una cuota/i],
            title: 'Límite de responsabilidad desbalanceado',
            describe: function (party) {
                if (party === 'cliente') {
                    return 'La responsabilidad queda limitada o excluye daños previsibles. Para quien contrata el servicio, ese tope puede dejar el incumplimiento casi sin remedio.';
                }
                return 'Hay un tope o una exclusión de daños. Hay que comprobar que sea recíproco y que no quede por debajo del valor real del contrato.';
            },
            recommend: function (law) {
                return law.liability;
            }
        },
        {
            id: 'renewal',
            category: 'penalties',
            base: 10,
            level: 'medium',
            patterns: [/pr[oó]rroga autom[aá]tica/i, /renovaci[oó]n autom[aá]tica/i, /se renovar[aá] autom[aá]ticamente/i],
            title: 'Renovación automática',
            describe: function () {
                return 'El contrato se extiende solo si nadie avisa. Es fácil quedar obligado otro periodo por omitir una fecha.';
            },
            recommend: function () {
                return 'Exige un aviso previo por escrito, un plazo razonable para oponerse y que la renovación no sea indefinida.';
            }
        },
        {
            id: 'forum',
            category: 'compliance',
            base: 8,
            level: 'low',
            patterns: [/renuncia(?:n|mos)? al? fuero/i, /renuncian a cualquier fuero/i],
            title: 'Renuncia de fuero',
            describe: function () {
                return 'Se renuncia al fuero propio. Eso puede obligar a litigar en una sede lejana o incómoda.';
            },
            recommend: function (law) {
                return law.compliance;
            }
        }
    ];

    function missingLawAlert(text, law) {
        if (text.trim().length < 180) return null;
        if (/ley aplicable|jurisdicci[oó]n|tribunal|fuero|arbitraje/i.test(text)) return null;
        return {
            id: 'governing-law',
            category: 'compliance',
            base: 6,
            level: 'low',
            title: 'No se identifica la ley ni el foro',
            desc: 'El texto revisado no dice qué ley lo rige ni dónde se resuelven los conflictos.',
            excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 180),
            anchor: '',
            recommend: law.compliance
        };
    }

    function runLocalSimulation(text, options) {
        const settings = options || {};
        const contractType = settings.contractType || 'Otro';
        const party = settings.party || 'neutral';
        const jurisdiction = JURISDICTIONS[settings.jurisdiction] ? settings.jurisdiction : 'OTRO';
        const law = JURISDICTIONS[jurisdiction];
        const priorities = settings.priorities || {};
        const typeWeights = TYPE_WEIGHT[contractType] || TYPE_WEIGHT.Otro;
        const sourceText = String(text || '');
        const alerts = [];
        let score = 8;

        RULES.forEach(function (rule) {
            const match = firstMatch(sourceText, rule.patterns);
            if (!match) return;
            const excerpt = excerptAround(sourceText, match.index, match.text.length);
            const extra = rule.extra ? rule.extra(sourceText) : { score: 0, level: null };
            const factor = partyFactor(rule.id, party, excerpt);
            const categoryWeight = typeWeights[rule.category] || 1;
            const priorityWeight = weightFor(priorities[rule.category]);
            const impact = Math.round((rule.base + (extra.score || 0)) * categoryWeight * priorityWeight * factor);
            score += impact;
            let level = extra.level || rule.level;
            if (factor <= 0.6) level = downgrade(level);
            alerts.push({
                level: level,
                title: rule.title,
                desc: rule.describe(party, extra),
                excerpt: excerpt,
                anchor: match.text,
                recommendation: rule.recommend(law, extra)
            });
        });

        const lawGap = missingLawAlert(sourceText, law);
        if (lawGap) {
            const impact = Math.round(lawGap.base * (typeWeights.compliance || 1) * weightFor(priorities.compliance));
            score += impact;
            alerts.push({
                level: lawGap.level,
                title: lawGap.title,
                desc: lawGap.desc,
                excerpt: lawGap.excerpt,
                anchor: '',
                recommendation: lawGap.recommend
            });
        }

        if (alerts.length === 0) {
            alerts.push({
                level: 'low',
                title: 'Sin hallazgos heurísticos evidentes',
                desc: 'Las reglas locales no vieron terminación unilateral, mora extrema, confidencialidad indefinida ni un límite de responsabilidad llamativo. Esto no sustituye la lectura jurídica del documento.',
                excerpt: sourceText.replace(/\s+/g, ' ').trim().slice(0, 180),
                anchor: '',
                recommendation: 'Confirma anexos, plazos, ley aplicable y que las obligaciones de cada parte estén cerradas.'
            });
        }

        const recommendations = [];
        alerts.forEach(function (alert) {
            if (alert.recommendation && recommendations.indexOf(alert.recommendation) === -1) {
                recommendations.push(alert.recommendation);
            }
        });

        score = Math.min(100, Math.max(8, score));

        return {
            score: score,
            alerts: alerts.map(function (alert) {
                return {
                    level: alert.level,
                    title: alert.title,
                    desc: alert.desc,
                    excerpt: alert.excerpt,
                    anchor: alert.anchor || ''
                };
            }),
            recommendations: recommendations,
            contractType: contractType,
            jurisdiction: jurisdiction,
            jurisdictionLabel: law.label,
            party: party
        };
    }

    function prepareContractText(text, maxChars) {
        const limit = maxChars || MAX_GEMINI_CHARS;
        const original = String(text || '');
        if (original.length <= limit) {
            return { text: original, truncated: false, originalLength: original.length, analyzedLength: original.length };
        }
        return {
            text: original.slice(0, limit),
            truncated: true,
            originalLength: original.length,
            analyzedLength: limit
        };
    }

    function buildSystemPrompt(options) {
        const settings = options || {};
        const law = JURISDICTIONS[settings.jurisdiction] || JURISDICTIONS.OTRO;
        const priorities = settings.priorities || {};
        const partyLabel = settings.party === 'cliente'
            ? 'el cliente que recibe la prestación'
            : settings.party === 'proveedor'
                ? 'el proveedor que presta el servicio o entrega el bien'
                : 'una revisión neutral de ambas partes';
        return [
            'Eres un revisor de contratos mercantiles. Ayudas a negociar, no sustituyes el dictamen de un abogado.',
            'Tipo de documento: ' + (settings.contractType || 'Otro') + '.',
            'Jurisdicción de referencia: ' + law.label + '.',
            'La revisión se hace desde la posición de ' + partyLabel + '.',
            'Prioridades del usuario (alta pesa más en la puntuación):',
            '- Riesgo financiero: ' + (priorities.financial || 'media'),
            '- Cláusulas abusivas: ' + (priorities.abusive || 'media'),
            '- Fechas y penalizaciones: ' + (priorities.penalties || 'media'),
            '- Cumplimiento y ley aplicable: ' + (priorities.compliance || 'media'),
            'Devuelve solo el JSON del esquema. score va de 0 (sin riesgo) a 100 (riesgo crítico).',
            'Cada alerta debe incluir excerpt con una cita literal breve del contrato, copiada del texto recibido.',
            'Si el texto vino recortado, limita el dictamen a lo que sí recibiste y dilo en una recomendación.',
            'Adapta las recomendaciones a la jurisdicción indicada, sin inventar artículos que no correspondan.'
        ].join('\n');
    }

    function buildGeminiRequest(options) {
        const settings = options || {};
        const model = MODELS.find(function (item) { return item.id === settings.model; }) || MODELS[0];
        const prepared = prepareContractText(settings.contractText);
        const note = prepared.truncated
            ? 'El documento original tiene ' + prepared.originalLength + ' caracteres. Analiza únicamente este inicio recortado.\n\n'
            : '';
        return {
            endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model.id) + ':generateContent',
            model: model.id,
            truncated: prepared.truncated,
            originalLength: prepared.originalLength,
            analyzedLength: prepared.analyzedLength,
            body: {
                systemInstruction: { parts: [{ text: buildSystemPrompt(settings) }] },
                contents: [{
                    role: 'user',
                    parts: [{ text: note + 'TEXTO DEL CONTRATO:\n"""\n' + prepared.text + '\n"""' }]
                }],
                generationConfig: {
                    responseMimeType: 'application/json',
                    responseSchema: AUDIT_SCHEMA,
                    maxOutputTokens: 4096,
                    thinkingConfig: { thinkingLevel: model.thinkingLevel }
                }
            }
        };
    }

    function normalizeAnalysis(parsed) {
        const source = parsed || {};
        const alerts = Array.isArray(source.alerts) ? source.alerts : [];
        const cleanAlerts = alerts.map(function (alert) {
            const level = String(alert && alert.level || '').toLowerCase();
            return {
                level: level === 'high' || level === 'low' ? level : 'medium',
                title: String(alert && alert.title || 'Hallazgo').slice(0, 180),
                desc: String(alert && alert.desc || '').slice(0, 1200),
                excerpt: String(alert && alert.excerpt || '').slice(0, 500),
                anchor: String(alert && alert.anchor || '').slice(0, 180)
            };
        }).filter(function (alert) { return alert.title; });

        const recommendations = Array.isArray(source.recommendations)
            ? source.recommendations.map(function (item) { return String(item).slice(0, 800); }).filter(Boolean)
            : [];

        return {
            score: clampScore(source.score),
            alerts: cleanAlerts.length ? cleanAlerts : [{
                level: 'low',
                title: 'Sin alertas estructuradas',
                desc: 'La respuesta no trajo hallazgos utilizables.',
                excerpt: '',
                anchor: ''
            }],
            recommendations: recommendations.length ? recommendations : ['Revisar el documento con el equipo jurídico antes de firmar.']
        };
    }

    function partyLabel(party) {
        if (party === 'cliente') return 'Cliente';
        if (party === 'proveedor') return 'Proveedor';
        return 'Revisión neutral';
    }

    function buildReportText(data) {
        const report = data || {};
        const alerts = report.alerts || [];
        const recommendations = report.recommendations || [];
        const law = JURISDICTIONS[report.jurisdiction] || JURISDICTIONS.OTRO;
        const lines = [
            'DICTAMEN DE REVISIÓN CONTRACTUAL',
            'Tipo de contrato: ' + (report.contractType || 'No indicado'),
            'Jurisdicción de referencia: ' + (report.jurisdictionLabel || law.label),
            'Parte representada: ' + partyLabel(report.party),
            'Fecha: ' + (report.date || ''),
            'Fuente: ' + (report.source || 'Auditor local'),
            'Puntuación: ' + report.score + ' / 100',
            'Nivel: ' + riskLabel(report.score),
            ''
        ];
        if (report.truncated) {
            lines.push('Aviso: el texto enviado al modelo se recortó a ' + report.analyzedLength + ' de ' + report.originalLength + ' caracteres.');
            lines.push('');
        }
        lines.push('HALLAZGOS (' + alerts.length + ')');
        alerts.forEach(function (alert, index) {
            lines.push((index + 1) + '. ' + alert.title + ' [' + String(alert.level || 'medium').toUpperCase() + ']');
            lines.push(alert.desc || '');
            lines.push('Cita: ' + (alert.excerpt ? alert.excerpt : 'Sin cita textual'));
            lines.push('');
        });
        lines.push('RECOMENDACIONES (' + recommendations.length + ')');
        recommendations.forEach(function (item, index) {
            lines.push((index + 1) + '. ' + item);
        });
        lines.push('');
        lines.push('Este informe ordena riesgos para negociar. No reemplaza el criterio de un abogado.');
        return lines.join('\n');
    }

    function createHistoryRecord(input) {
        const recordInput = input || {};
        const data = recordInput.data || {};
        const fullText = String(recordInput.fullText || '');
        const record = {
            id: recordInput.id || Date.now(),
            date: data.date || recordInput.date || '',
            title: String(recordInput.title || 'Contrato').replace(/[\n\r]+/g, ' ').trim().slice(0, 80),
            score: data.score,
            source: data.source || '',
            contractType: data.contractType || '',
            excerpt: fullText.replace(/\s+/g, ' ').trim().slice(0, STORED_EXCERPT),
            textStored: false,
            data: data
        };
        if (recordInput.storeFullText && fullText) {
            record.fullText = fullText;
            record.textStored = true;
        }
        return record;
    }

    function pushHistory(history, record) {
        const list = Array.isArray(history) ? history.slice() : [];
        const next = [record].concat(list.filter(function (item) { return item.id !== record.id; }));
        return next.slice(0, HISTORY_LIMIT);
    }

    function withoutFullText(record) {
        const copy = Object.assign({}, record);
        delete copy.fullText;
        copy.textStored = false;
        return copy;
    }

    function knownModel(modelId) {
        return MODELS.some(function (model) { return model.id === modelId; }) ? modelId : DEFAULT_MODEL;
    }

    return {
        HISTORY_LIMIT: HISTORY_LIMIT,
        MAX_GEMINI_CHARS: MAX_GEMINI_CHARS,
        DEFAULT_MODEL: DEFAULT_MODEL,
        MODELS: MODELS,
        JURISDICTIONS: JURISDICTIONS,
        riskLabel: riskLabel,
        riskBand: riskBand,
        runLocalSimulation: runLocalSimulation,
        prepareContractText: prepareContractText,
        buildSystemPrompt: buildSystemPrompt,
        buildGeminiRequest: buildGeminiRequest,
        normalizeAnalysis: normalizeAnalysis,
        buildReportText: buildReportText,
        createHistoryRecord: createHistoryRecord,
        pushHistory: pushHistory,
        withoutFullText: withoutFullText,
        knownModel: knownModel,
        partyLabel: partyLabel
    };
});

