(function () {
    const engine = window.AuditEngine;
    const STORAGE_KEY_HISTORY = 'gemini_contract_audit_history';
    const STORAGE_KEY_MODEL = 'gemini_selected_model';
    const STORAGE_KEY_PREFS = 'auditor_review_prefs';
    const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

    let currentAnalysis = null;
    let clearArmed = false;
    let currentUser = null;
    let serverHistory = [];
    let csrfTokenValue = '';

    const $ = function (id) { return document.getElementById(id); };

    function showNotice(message, tone) {
        const notice = $('appNotice');
        if (!message) {
            notice.hidden = true;
            notice.textContent = '';
            return;
        }
        notice.hidden = false;
        notice.className = 'notice ' + (tone || 'info');
        notice.textContent = message;
    }

    function readPrefs() {
        return {
            contractType: $('contractType').value,
            jurisdiction: $('jurisdiction').value,
            party: $('party').value,
            priorities: {
                financial: $('priorityFinancial').value,
                abusive: $('priorityAbusive').value,
                penalties: $('priorityPenalties').value,
                compliance: $('priorityCompliance').value
            },
            storeFullText: $('storeFullText').checked
        };
    }

    function savePrefs() {
        const prefs = readPrefs();
        localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(prefs));
        localStorage.setItem(STORAGE_KEY_MODEL, $('modelSelect').value);
    }

    function loadPrefs() {
        let prefs = {};
        try {
            prefs = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFS) || '{}');
        } catch (error) {
            prefs = {};
        }
        if (prefs.contractType) $('contractType').value = prefs.contractType;
        if (prefs.jurisdiction && engine.JURISDICTIONS[prefs.jurisdiction]) $('jurisdiction').value = prefs.jurisdiction;
        if (prefs.party) $('party').value = prefs.party;
        if (prefs.priorities) {
            $('priorityFinancial').value = prefs.priorities.financial || 'media';
            $('priorityAbusive').value = prefs.priorities.abusive || 'alta';
            $('priorityPenalties').value = prefs.priorities.penalties || 'alta';
            $('priorityCompliance').value = prefs.priorities.compliance || 'alta';
        }
        $('storeFullText').checked = Boolean(prefs.storeFullText);
    }

    function updateConnectionBadge() {
        const ready = window.geminiAvailable === true;
        const badge = $('statusBadge');
        $('configStatusText').textContent = ready ? 'Gemini disponible' : 'Modo local';
        $('statusText').textContent = ready ? 'Gemini conectado al servidor' : 'Modo local';
        badge.classList.toggle('live', ready);
    }

    function setBusy(isBusy, label) {
        $('analyzeBtn').disabled = isBusy;
        $('uploadBtn').disabled = isBusy;
        $('analyzeSpinner').classList.toggle('hidden', !isBusy);
        $('analyzeBtnText').textContent = label || 'Analizar contrato';
    }

    function renderDashboard(data) {
        currentAnalysis = data;
        const hasResult = Boolean(data);
        $('emptyState').hidden = hasResult;
        $('resultsBody').hidden = !hasResult;
        $('exportPdfBtn').disabled = !hasResult;
        $('exportTxtBtn').disabled = !hasResult;
        if (!hasResult) return;

        const band = engine.riskBand(data.score);
        $('riskCard').dataset.band = band;
        $('riskScore').textContent = String(data.score);
        $('riskScoreBar').style.width = data.score + '%';
        $('riskLevelLabel').textContent = 'Riesgo ' + engine.riskLabel(data.score).toLowerCase();
        $('auditSourceTag').textContent = data.source || 'Auditoría';
        $('auditTimestampText').textContent = data.date || '';
        $('contextLine').textContent = [
            data.contractType || 'Contrato',
            data.jurisdictionLabel || '',
            engine.partyLabel(data.party)
        ].filter(Boolean).join(' · ');
        $('truncationNote').hidden = !data.truncated;
        $('truncationNote').textContent = data.truncated
            ? 'El modelo solo vio los primeros ' + data.analyzedLength + ' de ' + data.originalLength + ' caracteres.'
            : '';

        const alerts = data.alerts || [];
        $('alertsCountBadge').textContent = alerts.length + (alerts.length === 1 ? ' alerta' : ' alertas');
        const container = $('alertsContainer');
        container.replaceChildren();
        alerts.forEach(function (alert) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'alert ' + (alert.level || 'medium');
            const title = document.createElement('h3');
            title.textContent = alert.title || 'Hallazgo';
            const description = document.createElement('p');
            description.textContent = alert.desc || '';
            button.append(title, description);
            if (alert.excerpt) {
                const quote = document.createElement('p');
                quote.className = 'quote';
                quote.textContent = 'Cita: ' + alert.excerpt;
                button.append(quote);
            }
            button.addEventListener('click', function () { revealExcerpt(alert); });
            container.append(button);
        });

        const list = $('recommendationsList');
        list.replaceChildren();
        (data.recommendations || []).forEach(function (recommendation) {
            const item = document.createElement('li');
            item.textContent = recommendation;
            list.append(item);
        });
    }

    function revealExcerpt(alert) {
        const area = $('contractText');
        const candidates = [alert.anchor, alert.excerpt].filter(Boolean);
        for (let i = 0; i < candidates.length; i += 1) {
            const needle = String(candidates[i]).replace(/^[.…\s]+|[.…\s]+$/g, '').slice(0, 80);
            if (!needle) continue;
            const index = area.value.toLowerCase().indexOf(needle.toLowerCase());
            if (index >= 0) {
                area.focus();
                area.setSelectionRange(index, index + needle.length);
                showNotice('');
                return;
            }
        }
        showNotice('No encontré esa cita dentro del texto cargado.', 'info');
    }

    function stamp(result, source, prefs, extra) {
        const law = engine.JURISDICTIONS[prefs.jurisdiction] || engine.JURISDICTIONS.OTRO;
        result.source = source;
        result.contractType = prefs.contractType;
        result.jurisdiction = prefs.jurisdiction;
        result.jurisdictionLabel = law.label;
        result.party = prefs.party;
        result.date = new Date().toLocaleString();
        result.truncated = Boolean(extra && extra.truncated);
        result.originalLength = extra && extra.originalLength;
        result.analyzedLength = extra && extra.analyzedLength;
        return result;
    }

    function askConsent() {
        if (sessionStorage.getItem('auditor_gemini_consent') === '1') return Promise.resolve(true);
        const dialog = $('consentDialog');
        return new Promise(function (resolve) {
            const accept = $('consentAccept');
            const decline = $('consentDecline');
            function finish(allowed) {
                accept.removeEventListener('click', onAccept);
                decline.removeEventListener('click', onDecline);
                dialog.removeEventListener('cancel', onDecline);
                dialog.close();
                resolve(allowed);
            }
            function onAccept() {
                sessionStorage.setItem('auditor_gemini_consent', '1');
                finish(true);
            }
            function onDecline(event) {
                if (event) event.preventDefault();
                finish(false);
            }
            accept.addEventListener('click', onAccept);
            decline.addEventListener('click', onDecline);
            dialog.addEventListener('cancel', onDecline);
            dialog.showModal();
        });
    }

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    async function checkServerStatus() {
        try {
            const response = await fetch('/api/health');
            const status = await response.json();
            window.geminiAvailable = response.ok && status.gemini === true;
            $('serverStatus').textContent = window.geminiAvailable
                ? 'Gemini disponible'
                : 'Gemini no configurado; análisis local disponible';
        } catch (error) {
            window.geminiAvailable = false;
            $('serverStatus').textContent = 'Servidor API no disponible; análisis local disponible';
        }
        updateConnectionBadge();
    }

    async function callGemini(options) {
        let response;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                response = await fetch('/api/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(options)
                });
            } catch (networkError) {
                const error = new Error('No hubo conexión con el servidor. Se usó el motor local.');
                error.code = 'NETWORK';
                throw error;
            }
            if (response.status !== 429 || attempt === 2) break;
            await delay(700 * (attempt + 1));
        }

        const payload = await response.json().catch(function () { return {}; });
        if (!response.ok) {
            const message = payload.error || 'El servidor respondió con HTTP ' + response.status + '.';
            const error = new Error(message);
            error.code = payload.code || (response.status === 429 ? 'RATE' : 'API');
            throw error;
        }
        return engine.normalizeAnalysis(payload.analysis);
    }

    function readHistory() {
        if (currentUser) return serverHistory;
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    function persistHistory(history) {
        try {
            localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history));
            return { ok: true, droppedText: false };
        } catch (error) {
            try {
                localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history.map(engine.withoutFullText)));
                return { ok: true, droppedText: true };
            } catch (secondError) {
                return { ok: false, droppedText: false };
            }
        }
    }

    function renderHistory() {
        const history = readHistory();
        $('historyCountBadge').textContent = String(history.length);
        const list = $('historyList');
        list.replaceChildren();
        if (!history.length) {
            const empty = document.createElement('p');
            empty.className = 'empty';
            empty.textContent = 'Todavía no hay auditorías en este navegador.';
            list.append(empty);
            return;
        }
        history.forEach(function (item) {
            const row = document.createElement('div');
            row.className = 'history-item';
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'history-open';
            const text = document.createElement('span');
            const title = document.createElement('strong');
            title.textContent = item.title || 'Contrato';
            const meta = document.createElement('span');
            meta.className = 'muted';
            meta.textContent = (item.date || '') + (item.textStored ? '' : ' · sin texto completo');
            text.append(title, document.createElement('br'), meta);
            const pill = document.createElement('span');
            pill.className = 'score-pill ' + engine.riskBand(item.score || 0);
            pill.textContent = (item.score ?? '–') + '/100';
            open.append(text, pill);
            open.addEventListener('click', function () { loadAudit(item.id); });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'btn tiny ghost danger';
            remove.textContent = 'Borrar';
            remove.addEventListener('click', function () { deleteAudit(item.id); });
            row.append(open, remove);
            list.append(row);
        });
    }

    function loadAudit(id) {
        const item = readHistory().find(function (entry) { return entry.id === id; });
        if (!item || !item.data) return;
        if (item.fullText) {
            $('contractText').value = item.fullText;
            showNotice('');
        } else {
            $('contractText').value = item.excerpt || '';
            showNotice('Esta entrada no guardó el contrato completo. El dictamen se restauró con el extracto disponible.', 'info');
        }
        if (item.data.contractType) $('contractType').value = item.data.contractType;
        if (item.data.jurisdiction) $('jurisdiction').value = item.data.jurisdiction;
        if (item.data.party) $('party').value = item.data.party;
        renderDashboard(item.data);
    }

    async function deleteAudit(id) {
        if (currentUser) {
            const response = await fetch('/api/history/' + encodeURIComponent(id), {
                method: 'DELETE', headers: { 'X-CSRF-Token': csrfTokenValue }
            });
            if (!response.ok) { showNotice('No se pudo borrar el análisis de tu cuenta.', 'bad'); return; }
            await refreshServerHistory();
            return;
        }
        persistHistory(readHistory().filter(function (entry) { return entry.id !== id; }));
        renderHistory();
    }

    async function saveAnalysis(fullText, data) {
        const prefs = readPrefs();
        const record = engine.createHistoryRecord({
            title: fullText.split('\n')[0] || 'Contrato',
            fullText: fullText,
            data: data,
            storeFullText: prefs.storeFullText
        });
        if (currentUser) {
            const response = await fetch('/api/history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfTokenValue },
                body: JSON.stringify({ title: record.title, excerpt: record.excerpt, data: record.data })
            });
            if (!response.ok) {
                showNotice('El análisis terminó, pero no se pudo guardar en tu cuenta.', 'warn');
                return;
            }
            await refreshServerHistory();
            return;
        }
        const saved = persistHistory(engine.pushHistory(readHistory(), record));
        renderHistory();
        if (!saved.ok) {
            showNotice('No se pudo guardar el historial: el almacenamiento del navegador está lleno.', 'bad');
        } else if (saved.droppedText) {
            showNotice('El historial se guardó sin el texto completo porque no cabía en el almacenamiento local.', 'warn');
        }
    }

    async function analyzeContract() {
        const fullText = $('contractText').value.trim();
        if (!fullText) {
            showNotice('Pega un contrato o carga un archivo antes de analizar.', 'warn');
            return;
        }
        const prefs = readPrefs();
        savePrefs();
        $('analyzeBtn').disabled = true;
        $('uploadBtn').disabled = true;
        showNotice('');

        try {
            let result = null;
            let source = 'Simulación heurística local';
            let extra = null;
            let useGemini = false;
            if (window.geminiAvailable) {
                useGemini = await askConsent();
                if (!useGemini) {
                    showNotice('No se envió el contrato. El dictamen es solo del motor local.', 'info');
                }
            }
            setBusy(true, useGemini ? 'Auditando…' : 'Revisando en local…');
            if (useGemini) {
                const request = engine.buildGeminiRequest({
                    model: $('modelSelect').value,
                    contractText: fullText,
                    contractType: prefs.contractType,
                    jurisdiction: prefs.jurisdiction,
                    party: prefs.party,
                    priorities: prefs.priorities
                });
                extra = request;
                if (request.truncated) {
                    showNotice('El documento supera ' + engine.MAX_GEMINI_CHARS + ' caracteres. Gemini solo recibió el inicio.', 'warn');
                }
                try {
                    result = await callGemini({
                        model: request.model,
                        contractText: fullText,
                        contractType: prefs.contractType,
                        jurisdiction: prefs.jurisdiction,
                        party: prefs.party,
                        priorities: prefs.priorities
                    });
                    source = 'Gemini (' + request.model + ')';
                } catch (error) {
                    if (error.code === 'MODEL' || error.code === 'RATE') {
                        showNotice(error.message, 'bad');
                        return;
                    }
                    result = engine.runLocalSimulation(fullText, prefs);
                    source = 'Simulación local (respaldo)';
                    showNotice(error.message, 'warn');
                }
            } else {
                result = engine.runLocalSimulation(fullText, prefs);
            }
            stamp(result, source, prefs, source.indexOf('Gemini (') === 0 ? extra : null);
            renderDashboard(result);
            await saveAnalysis(fullText, result);
        } finally {
            setBusy(false);
        }
    }

    async function refreshCsrfToken() {
        const response = await fetch('/api/auth/csrf');
        if (!response.ok) throw new Error('No se pudo iniciar la protección de sesión.');
        const payload = await response.json();
        csrfTokenValue = payload.csrfToken;
    }

    async function refreshServerHistory() {
        const response = await fetch('/api/history');
        if (!response.ok) throw new Error('No se pudo cargar el historial de la cuenta.');
        const payload = await response.json();
        serverHistory = Array.isArray(payload.history) ? payload.history : [];
        renderHistory();
    }

    function updateAccountView() {
        $('authForms').hidden = Boolean(currentUser);
        $('accountSession').hidden = !currentUser;
        $('accountStatus').textContent = currentUser ? 'Cuenta activa' : 'Modo invitado';
        $('accountEmail').textContent = currentUser ? currentUser.email : '';
        $('authMessage').textContent = currentUser
            ? 'Tu historial está asociado a esta cuenta. Los contratos completos no se guardan en el servidor.'
            : 'Puedes analizar sin cuenta. Inicia sesión para guardar tu historial de forma privada en este servidor.';
        renderHistory();
    }

    async function initializeAuth() {
        try {
            await refreshCsrfToken();
            const response = await fetch('/api/auth/me');
            const payload = await response.json();
            currentUser = payload.authenticated ? payload.user : null;
            if (currentUser) await refreshServerHistory();
        } catch (error) {
            $('authMessage').textContent = 'No se pudo comprobar la sesión. Puedes seguir usando el análisis local.';
        }
        updateAccountView();
    }

    async function submitAuth(action) {
        const email = $('authEmail').value.trim();
        const password = $('authPassword').value;
        if (!email || !password) {
            $('authMessage').textContent = 'Completa el correo y la contraseña.';
            return;
        }
        try {
            if (!csrfTokenValue) await refreshCsrfToken();
            const response = await fetch('/api/auth/' + action, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfTokenValue },
                body: JSON.stringify({ email, password })
            });
            const payload = await response.json().catch(function () { return {}; });
            if (!response.ok) throw new Error(payload.error || 'No se pudo completar la operación.');
            currentUser = payload.user;
            await refreshCsrfToken();
            $('authPassword').value = '';
            await refreshServerHistory();
            updateAccountView();
        } catch (error) {
            $('authMessage').textContent = error.message;
        }
    }

    async function logout() {
        try {
            const response = await fetch('/api/auth/logout', {
                method: 'POST', headers: { 'X-CSRF-Token': csrfTokenValue }
            });
            if (!response.ok) throw new Error('No se pudo cerrar la sesión.');
            currentUser = null;
            serverHistory = [];
            csrfTokenValue = '';
            await refreshCsrfToken();
            updateAccountView();
        } catch (error) {
            $('authMessage').textContent = error.message;
        }
    }

    function pdfSafe(text) {
        return String(text || '').replace(/…/g, '...').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    }

    function exportTxt() {
        if (!currentAnalysis) return;
        const blob = new Blob([engine.buildReportText(currentAnalysis)], { type: 'text/plain;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'dictamen-' + new Date().toISOString().slice(0, 10) + '.txt';
        link.click();
        URL.revokeObjectURL(link.href);
    }

    function exportPdf() {
        if (!currentAnalysis) return;
        if (!window.jspdf || !window.jspdf.jsPDF) {
            showNotice('No se cargó el generador de PDF. Revisa la conexión e inténtalo de nuevo.', 'bad');
            return;
        }
        const data = currentAnalysis;
        const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const margin = 18;
        const width = pageWidth - margin * 2;
        let y = 20;

        function addParagraph(text, options) {
            const settings = options || {};
            const size = settings.size || 10;
            doc.setFont('helvetica', settings.bold ? 'bold' : 'normal');
            doc.setFontSize(size);
            doc.setTextColor.apply(doc, settings.color || [51, 65, 85]);
            const lines = doc.splitTextToSize(pdfSafe(text), width);
            const lineHeight = size * 0.48;
            if (y + lines.length * lineHeight > pageHeight - margin) {
                doc.addPage();
                y = margin;
            }
            doc.text(lines, margin, y);
            y += lines.length * lineHeight + (settings.gap == null ? 2 : settings.gap);
        }

        doc.setFillColor(23, 43, 77);
        doc.rect(0, 0, pageWidth, 36, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(16);
        doc.text('DICTAMEN DE REVISION CONTRACTUAL', margin, 16);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.text('Riesgos, citas y recomendaciones para negociar', margin, 26);
        y = 48;
        addParagraph(data.contractType + ' · ' + (data.jurisdictionLabel || '') + ' · ' + engine.partyLabel(data.party), { bold: true, size: 11, color: [23, 43, 77] });
        addParagraph((data.date || '') + '  |  ' + (data.source || ''));
        addParagraph('Evaluacion: ' + data.score + ' / 100 — ' + engine.riskLabel(data.score), { bold: true, size: 12, color: data.score >= 70 ? [180, 35, 24] : [23, 43, 77], gap: 6 });
        if (data.truncated) {
            addParagraph('El modelo solo reviso ' + data.analyzedLength + ' de ' + data.originalLength + ' caracteres.', { gap: 4 });
        }
        addParagraph('HALLAZGOS', { bold: true, size: 12, color: [23, 43, 77], gap: 3 });
        (data.alerts || []).forEach(function (alert, index) {
            addParagraph((index + 1) + '. ' + alert.title + ' [' + String(alert.level || '').toUpperCase() + ']', { bold: true, gap: 1 });
            addParagraph(alert.desc || '', { size: 9, gap: 1 });
            addParagraph('Cita: ' + (alert.excerpt || 'Sin cita textual'), { size: 9, gap: 3 });
        });
        addParagraph('RECOMENDACIONES', { bold: true, size: 12, color: [23, 43, 77], gap: 3 });
        (data.recommendations || []).forEach(function (item, index) {
            addParagraph((index + 1) + '. ' + item, { size: 9, gap: 2 });
        });
        addParagraph('Este informe no reemplaza el criterio de un abogado.', { size: 8, gap: 2 });

        const pages = doc.internal.getNumberOfPages();
        for (let page = 1; page <= pages; page += 1) {
            doc.setPage(page);
            doc.setFontSize(8);
            doc.setTextColor(100, 116, 139);
            doc.text('Confidencial', margin, pageHeight - 8);
            doc.text(page + ' / ' + pages, pageWidth - margin, pageHeight - 8, { align: 'right' });
        }
        doc.save('dictamen-' + new Date().toISOString().slice(0, 10) + '.pdf');
    }

    function readFile(file) {
        const extension = (file.name.split('.').pop() || '').toLowerCase();
        if (extension === 'doc') {
            showNotice('Los archivos .doc antiguos no se pueden leer en el navegador. Guárdalo como .docx o PDF.', 'warn');
            return;
        }
        setBusy(true, 'Leyendo archivo…');
        const reader = new FileReader();
        reader.onerror = function () {
            setBusy(false);
            showNotice('No se pudo leer el archivo.', 'bad');
        };
        if (extension === 'pdf') {
            reader.onload = async function () {
                try {
                    if (!window.pdfjsLib) throw new Error('PDF.js no está disponible.');
                    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
                    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(reader.result) }).promise;
                    let text = '';
                    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
                        const page = await pdf.getPage(pageNumber);
                        const content = await page.getTextContent();
                        text += content.items.map(function (item) { return item.str; }).join(' ') + '\n\n';
                    }
                    $('contractText').value = text.trim();
                    setBusy(false);
                    analyzeContract();
                } catch (error) {
                    setBusy(false);
                    showNotice('No se pudo extraer el texto del PDF. Si es un escaneo, hace falta pegar el texto. ' + error.message, 'bad');
                }
            };
            reader.readAsArrayBuffer(file);
            return;
        }
        if (extension === 'docx') {
            reader.onload = async function () {
                try {
                    if (!window.mammoth) throw new Error('Mammoth no está disponible.');
                    const result = await mammoth.extractRawText({ arrayBuffer: reader.result });
                    $('contractText').value = (result.value || '').trim();
                    setBusy(false);
                    analyzeContract();
                } catch (error) {
                    setBusy(false);
                    showNotice('No se pudo leer el DOCX. ' + error.message, 'bad');
                }
            };
            reader.readAsArrayBuffer(file);
            return;
        }
        reader.onload = function () {
            $('contractText').value = String(reader.result || '').trim();
            setBusy(false);
            analyzeContract();
        };
        reader.readAsText(file);
    }

    function bind() {
        engine.MODELS.forEach(function (model) {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.label;
            $('modelSelect').append(option);
        });
        $('modelSelect').value = engine.knownModel(localStorage.getItem(STORAGE_KEY_MODEL));
        loadPrefs();
        updateConnectionBadge();
        renderHistory();
        renderDashboard(null);
        if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;

        checkServerStatus();
        initializeAuth();
        $('loginBtn').addEventListener('click', function () { submitAuth('login'); });
        $('registerBtn').addEventListener('click', function () { submitAuth('register'); });
        $('logoutBtn').addEventListener('click', logout);
        ['modelSelect', 'contractType', 'jurisdiction', 'party', 'priorityFinancial', 'priorityAbusive', 'priorityPenalties', 'priorityCompliance', 'storeFullText']
            .forEach(function (id) {
                $(id).addEventListener('change', savePrefs);
            });
        $('analyzeBtn').addEventListener('click', analyzeContract);
        $('clearTextBtn').addEventListener('click', function () {
            $('contractText').value = '';
            renderDashboard(null);
            showNotice('');
            $('contractText').focus();
        });
        $('uploadBtn').addEventListener('click', function () { $('hiddenFileInput').click(); });
        $('hiddenFileInput').addEventListener('change', function (event) {
            const file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (file) readFile(file);
        });
        $('exportTxtBtn').addEventListener('click', exportTxt);
        $('exportPdfBtn').addEventListener('click', exportPdf);
        $('clearHistoryBtn').addEventListener('click', function () {
            if (!clearArmed) {
                clearArmed = true;
                $('clearHistoryBtn').textContent = 'Confirmar borrado';
                setTimeout(function () {
                    clearArmed = false;
                    $('clearHistoryBtn').textContent = 'Limpiar historial';
                }, 4000);
                return;
            }
            clearArmed = false;
            $('clearHistoryBtn').textContent = 'Limpiar historial';
            if (currentUser) {
                fetch('/api/history', { method: 'DELETE', headers: { 'X-CSRF-Token': csrfTokenValue } })
                    .then(function (response) { if (!response.ok) throw new Error(); return refreshServerHistory(); })
                    .catch(function () { showNotice('No se pudo limpiar el historial de tu cuenta.', 'bad'); });
            } else {
                localStorage.removeItem(STORAGE_KEY_HISTORY);
                renderHistory();
            }
        });
    }

    document.addEventListener('DOMContentLoaded', bind);
})();
