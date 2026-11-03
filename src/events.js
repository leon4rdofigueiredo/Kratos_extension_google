// =====================================================================================
// events.js — Registro de eventos de auditoria
// -------------------------------------------------------------------------------------
// Eventos entram numa fila local e são enviados em lotes ao backend.
// O texto original e o print vão direto ao servidor e nunca ficam gravados no computador
// (ver SENSITIVE_FIELDS); na fila local ficam só os metadados.
// =====================================================================================

import { getConfig } from './policy.js'; // para saber o endereço do backend e o grupo

const MAX_QUEUE = 500; // máximo de eventos guardados; passou disso, descarta os mais antigos
const BATCH_SIZE = 20; // eventos enviados por requisição

let chain = Promise.resolve();                           // "fila de tarefas" da fila de eventos
const serialize = (fn) => (chain = chain.then(fn, fn)); // executa uma tarefa por vez (evita perder eventos)

let cachedEmail = null; // e-mail do usuário guardado em memória

// E-mail da conta Google logada no Chrome.
export async function userEmail() {
    if (cachedEmail === null) { // só consulta na primeira vez
        try {
            const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }); // pede ao Chrome
            cachedEmail = info.email || '';                                                  // vazio se não houver conta
        } catch {
            cachedEmail = '';                                                                // erro: segue sem e-mail
        }
    }
    return cachedEmail;
}

// Campos que contêm dados pessoais EM CLARO (CPF, PIS, e-mail... digitados, e o print da tela).
// Eles nunca são gravados no disco do funcionário: vão direto ao servidor ou são descartados.
// 'solicitacao' era o nome antigo de originalText: continua na lista para limpar filas de versões anteriores.
const SENSITIVE_FIELDS = ['originalText', 'solicitacao', 'screenshot'];

// Envia um evento direto ao servidor, sem passar pela fila. Retorna true se o servidor confirmou.
async function sendNow(event) {
    const cfg = await getConfig();
    if (!cfg.apiUrl) return false;                              // sem servidor configurado
    try {
        const res = await fetch(`${cfg.apiUrl}/v1/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({ events: [event] }),
        });
        return res.ok;                                          // true = servidor recebeu
    } catch {
        return false;                                           // servidor fora do ar / sem rede
    }
}

// Cria um evento e coloca na fila.
export async function logEvent(type, data = {}) {
    const cfg = await getConfig();
    let event = {
        id: crypto.randomUUID(),                          // identificador único (evita duplicados no backend)
        type,                                             // tipo do evento, ex.: "ai_access"
        ts: new Date().toISOString(),                     // data e hora
        group: cfg.group,                                 // departamento
        user: await userEmail(),                          // quem
        extVersion: chrome.runtime.getManifest().version, // versão da extensão
        ...data,                                          // campos específicos do evento
    };

    const sensitive = SENSITIVE_FIELDS.filter((f) => event[f]);  // quais campos sensíveis este evento tem
    if (sensitive.length) {
        if (await sendNow(event)) return;                         // enviado direto: nada vai para o disco
        event = Object.fromEntries(Object.entries(event).filter(([k]) => !SENSITIVE_FIELDS.includes(k))); // servidor indisponível: tira os dados em claro
        event.omitted = sensitive;                                // avisa o servidor que esses campos foram descartados
    }

    await serialize(async () => {
        const { queue = [] } = await chrome.storage.local.get('queue'); // lê a fila
        queue.push(event);                                               // adiciona o evento (sem dados em claro)
        await chrome.storage.local.set({ queue: queue.slice(-MAX_QUEUE) }); // salva (limitando o tamanho)
    });
    flushEvents(); // tenta enviar agora mesmo
}

// Limpa dados em claro que ficaram na fila de versões anteriores da extensão.
export function scrubQueue() {
    return serialize(async () => {
        const { queue = [] } = await chrome.storage.local.get('queue');
        const clean = queue.map((ev) => {
            const sensitive = SENSITIVE_FIELDS.filter((f) => ev[f]);
            if (!sensitive.length) return ev;                                                // nada sensível
            const rest = Object.fromEntries(Object.entries(ev).filter(([k]) => !SENSITIVE_FIELDS.includes(k)));
            return { ...rest, omitted: sensitive };                                          // tira os campos em claro
        });
        await chrome.storage.local.set({ queue: clean });
    });
}

// Envia a fila ao backend em lotes.
export function flushEvents() {
    return serialize(async () => {
        const cfg = await getConfig();
        if (!cfg.apiUrl) return; // sem backend: eventos ficam guardados

        let { queue = [] } = await chrome.storage.local.get('queue'); // lê a fila
        while (queue.length) {                                         // enquanto houver eventos
            const batch = queue.slice(0, BATCH_SIZE);                  // pega o próximo lote
            try {
                const res = await fetch(`${cfg.apiUrl}/v1/events`, {   // envia ao backend
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
                    body: JSON.stringify({ events: batch }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);    // servidor recusou
            } catch {
                return; // falhou: para e tenta de novo no próximo alarme (1 min)
            }
            queue = queue.slice(batch.length);                         // tira da fila o lote confirmado
            await chrome.storage.local.set({ queue });                 // salva a fila atualizada
        }
    });
}

// Quantos eventos aguardam envio (mostrado no popup).
export async function queueSize() {
    const { queue = [] } = await chrome.storage.local.get('queue');
    return queue.length;
}
