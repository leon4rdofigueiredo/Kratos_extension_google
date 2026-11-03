// =====================================================================================
// server.js — Backend mínimo para TESTES (não usar em produção)
// Uso: node server/server.js   (opcionais: PORT, API_KEY)
// =====================================================================================

const http = require('http'); // servidor web do próprio Node
const fs = require('fs');     // ler/gravar arquivos
const path = require('path'); // montar caminhos de pastas

const PORT = Number(process.env.PORT) || 8787;              // porta (padrão 8787)
const API_KEY = process.env.API_KEY || 'dev-key';           // chave que a extensão precisa enviar
const POLICIES_DIR = path.join(__dirname, 'policies');     // pasta com uma política por grupo
const DATA_DIR = path.join(__dirname, 'data');              // pasta onde os eventos são gravados
const SHOTS_DIR = path.join(DATA_DIR, 'screenshots');       // screenshots recebidos
const INCIDENTS_DIR = path.join(DATA_DIR, 'incidents');    // um JSON por bloqueio (texto pedido + erro + print)
const INCIDENTS_FILE = path.join(DATA_DIR, 'incidents.json'); // TODAS as ocorrências num único JSON (atualizado a cada evento)
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');    // eventos: um JSON por linha
const MAX_BODY = 50 * 1024 * 1024;                          // tamanho máximo de requisição: 50 MB

fs.mkdirSync(SHOTS_DIR, { recursive: true });     // cria as pastas se não existirem
fs.mkdirSync(INCIDENTS_DIR, { recursive: true });

// Responde em JSON.
function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); // código HTTP e tipo
    res.end(JSON.stringify(body));                                                // corpo
}

// Lê o corpo da requisição (com limite de tamanho).
function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;       // bytes recebidos
        const chunks = [];  // pedaços recebidos
        req.on('data', (c) => {                        // chegou um pedaço
            size += c.length;
            if (size > MAX_BODY) {                     // passou do limite
                reject(new Error('Payload muito grande'));
                req.destroy();                         // corta a conexão
            } else chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); // terminou: junta tudo
        req.on('error', reject);
    });
}

// Remove comentários // e /* */ do JSON (as políticas são comentadas).
function stripJsonComments(text) {
    let out = '';          // texto final
    let inString = false;  // dentro de "aspas"?
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];
        if (inString) {                                  // dentro de aspas: copia como está
            out += c;
            if (c === '\\') out += text[++i] ?? '';      // caractere escapado
            else if (c === '"') inString = false;        // fechou aspas
        } else if (c === '"') {                          // abriu aspas
            inString = true;
            out += c;
        } else if (c === '/' && next === '/') {          // comentário de linha
            while (i < text.length && text[i] !== '\n') i++;
            out += '\n';
        } else if (c === '/' && next === '*') {          // comentário de bloco
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i++;
        } else {
            out += c;                                    // caractere normal
        }
    }
    return out;
}

// Carrega a política de um grupo.
function loadPolicy(group) {
    const safe = /^[\w-]+$/.test(group) ? group : 'default';     // só nomes seguros (impede "../")
    const file = path.join(POLICIES_DIR, `${safe}.json`);        // ex.: policies/juridico.json
    const text = fs.readFileSync(fs.existsSync(file) ? file : path.join(POLICIES_DIR, 'default.json'), 'utf8'); // grupo sem arquivo → default
    return JSON.parse(stripJsonComments(text));                  // tira comentários e converte
}

const pad = (n) => String(n).padStart(2, '0'); // 7 → "07"

// Texto seguro para nome de arquivo: "ChatGPT" → "chatgpt", "Meta AI" → "meta-ai".
const slug = (s) =>
    String(s ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // tira acentos
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')                       // qualquer outro caractere vira "-"
        .replace(/^-|-$/g, '') || 'unknown';

// Nome padrão dos arquivos (print e JSON têm o mesmo nome):
//   AAAA-MM-DD_HH-MM-SS_<ia>_<acao>_<tipos>_<codigo>
//   ex.: 2026-09-25_00-21-59_chatgpt_blocked_cnpj_f1e9555b
function fileBaseName(ev) {
    const d = new Date(ev.ts || Date.now());                                                       // data/hora do evento (horário local)
    const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const action =
        ev.type === 'pii_authorization_request' ? 'authorization-request' // pedido de liberação
        : ev.action === 'blocked' ? 'blocked'
        : ev.action === 'masked' ? 'masked'
        : slug(ev.type);
    const types = slug(Object.keys(ev.counts ?? {}).join('-') || (ev.types ?? []).join('-') || 'general'); // ex.: "cpf" ou "cpf-email"
    const shortId = String(ev.id ?? '').replace(/[^\w-]/g, '').slice(0, 8);                          // início do id (evita nomes repetidos)
    return `${datePart}_${slug(ev.service || ev.domain)}_${action}_${types}_${shortId}`;
}

// Monta o JSON da ocorrência só com o essencial.
// O print fica em screenshots/ com o mesmo nome deste arquivo; o evento completo fica em events.jsonl.
function buildIncident(ev) {
    const d = new Date(ev.ts);                                                                // data/hora do evento (horário local)
    const original = ev.originalText || ev.solicitacao || null;                               // "solicitacao" = nome antigo do campo
    return {
        incidentId: ev.incidentId ?? null,                                                    // código do incidente (liga o bloqueio ao pedido de autorização)
        date: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`,              // ex.: 24/09/2026
        time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,           // ex.: 18:16:38
        user: ev.user || '(sem conta Google no Chrome)',                                   // e-mail da conta Google do Chrome
        service: ev.service ?? null,                                                          // ex.: ChatGPT
        url: ev.url ?? null,                                                                  // página da IA acessada
        // como aconteceu: "paste" = colou (Ctrl+V), "submit" = digitou e tentou enviar,
        // "authorization_request" = pediu liberação para enviar
        stage: ev.type === 'pii_authorization_request' ? 'authorization_request' : (ev.stage ?? null),
        action: ev.action ?? null,                                                            // "blocked" ou "masked"
        types: Object.keys(ev.counts ?? {}).length ? Object.keys(ev.counts) : (ev.types ?? []), // ex.: ["cpf"]
        originalText: original,                                                               // o que foi colado/digitado, exatamente como estava
        maskedText: ev.prompt ?? null,                                                        // o mesmo texto com os dados trocados por [CPF] etc.
        // o original só chega com o servidor ligado; com ele desligado a extensão descarta esse campo
        ...(!original && { note: 'texto original não recebido (servidor estava desligado no momento)' }),
        ...(ev.justification && { justification: ev.justification }),                         // só em pedidos de autorização
    };
}

// Quando a pessoa pede autorização, a justificativa vai para o MESMO incidente do bloqueio
// (achado pelo incidentId), em vez de virar um incidente separado.
// "pending" = incidentes deste mesmo lote que ainda não foram gravados no incidents.json.
// Devolve true se achou o bloqueio; false se não achou (aí o pedido vira um incidente próprio).
function attachJustification(ev, pending) {
    if (!ev.incidentId) return false;
    const d = new Date(ev.ts);
    const extra = {
        justification: ev.justification ?? '',
        authorizationRequestedAt: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
        authorizationStatus: 'pending', // a equipe de segurança muda para "approved" ou "denied"
    };

    // 1. arquivo do incidente (um por bloqueio)
    let found = false;
    for (const file of fs.readdirSync(INCIDENTS_DIR)) {
        if (!file.endsWith('.json')) continue;
        const full = path.join(INCIDENTS_DIR, file);
        let incident;
        try {
            incident = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch {
            continue; // arquivo ilegível: ignora
        }
        if (incident.incidentId !== ev.incidentId) continue;
        fs.writeFileSync(full, JSON.stringify({ ...incident, ...extra }, null, 2));
        found = true;
        break;
    }
    if (!found) return false;

    // 2. o mesmo incidente no incidents.json (ou no lote que ainda vai ser gravado)
    const inBatch = pending.find((i) => i.incidentId === ev.incidentId);
    if (inBatch) {
        Object.assign(inBatch, extra);
    } else if (fs.existsSync(INCIDENTS_FILE)) {
        try {
            const all = JSON.parse(fs.readFileSync(INCIDENTS_FILE, 'utf8'));
            const item = all.find((i) => i.incidentId === ev.incidentId);
            if (item) {
                Object.assign(item, extra);
                fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(all, null, 2));
            }
        } catch {
            // incidents.json danificado: o arquivo individual já foi atualizado
        }
    }
    return true;
}

// Acrescenta ocorrências ao JSON único (incidents.json), mais nova no fim.
function appendToIncidentsFile(items) {
    if (!items.length) return;
    let all = [];
    if (fs.existsSync(INCIDENTS_FILE)) {
        try {
            all = JSON.parse(fs.readFileSync(INCIDENTS_FILE, 'utf8')); // lista atual
        } catch {
            // arquivo danificado: guarda uma cópia em vez de gravar por cima (antes o histórico inteiro era perdido)
            const backupFile = INCIDENTS_FILE.replace(/\.json$/, `.corrupted-${Date.now()}.json`);
            fs.renameSync(INCIDENTS_FILE, backupFile);
            console.warn(`incidents.json estava danificado; cópia guardada em ${path.basename(backupFile)}`);
        }
    }
    all.push(...items);                                              // acrescenta as novas
    fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(all, null, 2)); // regrava o arquivo inteiro
}

// Grava os eventos recebidos.
function storeEvents(events) {
    const incidents = [];                                                                   // ocorrências deste lote (para o JSON único)
    const lines = events.map((ev) => {
        const name = fileBaseName(ev);                                                      // nome padrão deste evento
        // pedido de autorização: tenta juntar a justificativa no incidente do bloqueio
        const attached = ev.type === 'pii_authorization_request' && attachJustification(ev, incidents);
        if ((ev.type === 'pii_detected' || ev.type === 'pii_authorization_request') && !attached) { // bloqueio, mascaramento ou pedido sem bloqueio achado:
            const incident = { ...buildIncident(ev), ...(ev.screenshot && { screenshot: `screenshots/${name}.jpg` }) }; // com o nome do print
            fs.writeFileSync(path.join(INCIDENTS_DIR, `${name}.json`), JSON.stringify(incident, null, 2)); // um arquivo por ocorrência
            incidents.push(incident);                                                                   // e no JSON único
        }
        if (typeof ev.screenshot === 'string' && ev.screenshot.startsWith('data:image/')) { // evento tem screenshot?
            fs.writeFileSync(path.join(SHOTS_DIR, `${name}.jpg`), Buffer.from(ev.screenshot.split(',')[1], 'base64')); // salva a imagem
            ev = { ...ev, screenshot: `screenshots/${name}.jpg` };                         // no histórico, fica só o caminho
        }
        return JSON.stringify({ ...ev, receivedAt: new Date().toISOString() });           // acrescenta a hora de recebimento
    });
    fs.appendFileSync(EVENTS_FILE, lines.join('\n') + '\n'); // adiciona ao fim do arquivo
    appendToIncidentsFile(incidents);                        // atualiza o JSON único
}

module.exports = { fileBaseName, buildIncident, storeEvents, DATA_DIR, SHOTS_DIR, INCIDENTS_DIR, INCIDENTS_FILE, EVENTS_FILE }; // usado para reorganizar arquivos antigos

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); // endereço pedido

    if (req.headers.authorization !== `Bearer ${API_KEY}`) return json(res, 401, { error: 'unauthorized' }); // chave errada: recusa

    try {
        if (req.method === 'GET' && url.pathname === '/v1/policy') {                  // extensão pede a política
            return json(res, 200, loadPolicy(url.searchParams.get('group') || 'default'));
        }
        if (req.method === 'POST' && url.pathname === '/v1/events') {                // extensão envia eventos
            const { events } = JSON.parse(await readBody(req));
            if (!Array.isArray(events)) return json(res, 400, { error: 'events deve ser um array' });
            storeEvents(events);
            console.log(`${new Date().toISOString()} +${events.length} evento(s): ${events.map((e) => e.type).join(', ')}`); // mostra no terminal
            return json(res, 200, { received: events.length });
        }
        if (req.method === 'GET' && url.pathname === '/v1/events') {                 // consulta dos últimos 100 eventos
            const lines = fs.existsSync(EVENTS_FILE) ? fs.readFileSync(EVENTS_FILE, 'utf8').trim().split('\n') : [];
            return json(res, 200, lines.filter(Boolean).slice(-100).map(JSON.parse));
        }
        json(res, 404, { error: 'not found' });                                       // endereço desconhecido
    } catch (e) {
        json(res, 500, { error: e.message });                                         // erro inesperado
    }
});

if (require.main === module) { // só liga o servidor quando executado direto (node server/server.js)
    server.listen(PORT, () => console.log(`Backend de desenvolvimento em http://localhost:${PORT} (API_KEY=${API_KEY})`));
}
