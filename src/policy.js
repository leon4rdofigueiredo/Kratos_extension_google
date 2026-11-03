// =====================================================================================
// policy.js — Configuração do dispositivo e política de uso de IA
// -------------------------------------------------------------------------------------
// CONFIGURAÇÃO = onde está o backend e quem é o usuário (apiUrl, apiKey, group).
// POLÍTICA     = o que é permitido (sites de IA, dados sensíveis, screenshots...).
// =====================================================================================

const ACTIONS = ['monitor', 'block', 'redirect']; // ações possíveis ao acessar um site de IA

// Lê a configuração efetiva: a da empresa (gerenciada) tem prioridade sobre a local.
export async function getConfig() {
    let managed = {}; // configuração definida pela empresa (GPO / Admin Console)
    try {
        managed = await chrome.storage.managed.get(null); // null = ler todos os campos
    } catch {
        // alguns navegadores não têm storage.managed: segue com {}
    }
    const { localConfig = {} } = await chrome.storage.local.get('localConfig'); // configuração salva pelo popup
    return {
        apiUrl: '',        // padrão: sem backend
        apiKey: '',        // padrão: sem chave
        group: 'default',  // padrão: grupo "default"
        ...localConfig,    // a configuração local sobrescreve os padrões...
        ...managed,        // ...e a da empresa sobrescreve tudo
        managed: Object.keys(managed).length > 0, // true = empresa gerencia (popup esconde o formulário)
    };
}

// Salva a configuração digitada no popup.
export async function saveLocalConfig({ apiUrl = '', apiKey = '', group = 'default' }) {
    await chrome.storage.local.set({
        localConfig: {
            apiUrl: apiUrl.trim().replace(/\/+$/, ''), // tira espaços e a "/" do final da URL
            apiKey: apiKey.trim(),                     // tira espaços da chave
            group: group.trim() || 'default',          // grupo vazio vira "default"
        },
    });
}

// Remove comentários // e /* */ de um texto JSON (os arquivos de política são comentados).
export function stripJsonComments(text) {
    let out = '';          // texto final, sem comentários
    let inString = false;  // true enquanto estamos dentro de "aspas"
    for (let i = 0; i < text.length; i++) {
        const c = text[i];        // caractere atual
        const next = text[i + 1]; // próximo caractere
        if (inString) {                                  // dentro de aspas: copia tudo como está
            out += c;
            if (c === '\\') out += text[++i] ?? '';      // \" ou \\ : copia o caractere escapado junto
            else if (c === '"') inString = false;        // aspas de fechamento
        } else if (c === '"') {                          // aspas de abertura
            inString = true;
            out += c;
        } else if (c === '/' && next === '/') {          // comentário de linha: //
            while (i < text.length && text[i] !== '\n') i++; // pula até o fim da linha
            out += '\n';
        } else if (c === '/' && next === '*') {          // comentário de bloco: /* ... */
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; // pula até */
            i++;
        } else {
            out += c;                                    // caractere normal: copia
        }
    }
    return out;
}

// Carrega a política embutida (default-policy.json), usada quando não há backend.
async function loadDefaultPolicy() {
    const res = await fetch(chrome.runtime.getURL('default-policy.json'));             // lê o arquivo de dentro da extensão
    return { ...JSON.parse(stripJsonComments(await res.text())), source: 'default' }; // tira comentários, converte, marca a origem
}

// Confere se a política recebida tem o mínimo necessário.
function isValidPolicy(p) {
    return p && Array.isArray(p.domains) && p.domains.every((d) => typeof d.domain === 'string'); // precisa de uma lista de domínios
}

// Devolve a política em uso agora.
export async function getPolicy() {
    const { policy } = await chrome.storage.local.get('policy'); // última política salva
    return policy ?? loadDefaultPolicy();                        // se ainda não há nenhuma, usa a padrão
}

// Baixa a política do backend e salva. Se falhar, mantém a última política remota válida.
export async function refreshPolicy() {
    const cfg = await getConfig();
    let policy = null; // política que será usada
    let error = null;  // mensagem de erro (mostrada no popup)

    if (cfg.apiUrl) { // só tenta se houver backend configurado
        try {
            const res = await fetch(`${cfg.apiUrl}/v1/policy?group=${encodeURIComponent(cfg.group)}`, { // pede a política do grupo
                headers: { Authorization: `Bearer ${cfg.apiKey}` }, // envia a chave de acesso
                cache: 'no-store',                                  // nunca usar versão guardada em cache
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);     // servidor respondeu com erro
            const remote = await res.json();                        // converte a resposta
            if (!isValidPolicy(remote)) throw new Error('Política inválida recebida do backend');
            policy = { ...remote, source: 'remote' };               // marca que veio do backend
        } catch (e) {
            error = String(e.message ?? e);                         // guarda o erro para exibir
        }
    }

    if (!policy) { // backend ausente ou com falha
        const { policy: cached } = await chrome.storage.local.get('policy');
        policy = cached?.source === 'remote' ? cached : await loadDefaultPolicy(); // não "afrouxa" as regras se o servidor cair
    }

    policy.fetchedAt = new Date().toISOString();                                   // quando foi atualizada
    await chrome.storage.local.set({ policy, lastSync: { at: policy.fetchedAt, error } }); // salva política e status
    return policy;
}

// Verifica se a URL é de um site de IA da política. Retorna { domain, name } ou null.
export function matchDomain(policy, url) {
    let host;
    try {
        host = new URL(url).hostname; // ex.: "chat.deepseek.com"
    } catch {
        return null;                  // URL inválida (ex.: about:blank)
    }
    return policy.domains.find((d) => host === d.domain || host.endsWith(`.${d.domain}`)) ?? null; // domínio exato ou subdomínio
}

export const PII_TYPES = ['cpf', 'cnpj', 'rg', 'cnh', 'pis', 'voter_id', 'email', 'phone', 'card', 'secret']; // tipos que o detector conhece

// Nomes antigos dos tipos, ainda aceitos nas políticas (para não quebrar políticas já escritas).
const LEGACY_TYPES = { titulo: 'voter_id', palavra_proibida: 'keyword' };
const normalizeType = (t) => LEGACY_TYPES[t] ?? t;

// Até quando uma autorização vale, em milissegundos.
// "2026-11-03" (só a data) vale o dia inteiro no horário do computador: até 03/11 às 23:59:59.
// Antes era lido como horário de Londres (UTC) e vencia às 21h no horário de Brasília.
// Se vier com hora ("2026-11-03T18:00"), vale até essa hora.
function validUntil(until) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(until)) return Date.parse(`${until}T23:59:59.999`); // sem "Z" = horário local
    return Date.parse(until);
}

// Regras de dados sensíveis que valem para ESTE usuário (tira os tipos que ele está autorizado a enviar).
export function effectivePii(pii = {}, email = '', group = '') {
    const now = Date.now();           // agora, em milissegundos
    const user = email.toLowerCase(); // e-mail comparado sem diferenciar maiúsculas
    const authorized = new Set(       // conjunto de tipos liberados para este usuário
        (pii.exceptions ?? [])
            .filter((e) => !e.until || validUntil(e.until) >= now) // ignora vencidas
            .filter((e) => (e.users ?? []).some((u) => u.toLowerCase() === user) || (e.groups ?? []).includes(group)) // só as deste usuário/grupo
            .flatMap((e) => (e.types ?? []).map(normalizeType)), // junta os tipos de todas as autorizações
    );
    const { exceptions, ...rest } = pii; // a lista de autorizações não vai para a página
    return {
        ...rest,
        actions: Object.fromEntries(Object.entries(pii.actions ?? {}).map(([t, a]) => [normalizeType(t), a])), // ações por tipo, aceitando nomes antigos
        types: (pii.types ?? PII_TYPES).map(normalizeType).filter((t) => !authorized.has(t)), // tipos embutidos menos os autorizados
        patterns: (pii.patterns ?? []).filter((p) => !authorized.has(p.name)),     // padrões da empresa menos os autorizados
        keywords: authorized.has('keyword') ? [] : (pii.keywords ?? []),          // palavras-chave (ou nenhuma, se autorizado)
        authorized: [...authorized],                                               // lista do que foi liberado
    };
}

// Ação para um domínio: exceção em "overrides" ou a ação padrão.
export function actionFor(policy, domain) {
    const action = policy.overrides?.[domain] ?? policy.defaultAction; // específica do domínio, senão a padrão
    return ACTIONS.includes(action) ? action : 'monitor';              // valor desconhecido → só monitora
}
