// =====================================================================================
// background.js — Service worker (o "cérebro" da extensão, roda em segundo plano)
// -------------------------------------------------------------------------------------
// Sincroniza e aplica a política, detecta acessos a sites de IA, tira screenshots e
// responde às mensagens do popup e das páginas.
// =====================================================================================

import { getConfig, saveLocalConfig, getPolicy, refreshPolicy, matchDomain, actionFor, effectivePii } from './policy.js';
import { logEvent, flushEvents, queueSize, userEmail, scrubQueue } from './events.js';

const CONTENT_SCRIPT_ID = 'pii-guard'; // nome do registro do detector de dados sensíveis

// ---------- Aplicação da política ----------

// Cria as regras que bloqueiam/redirecionam os sites de IA (aplicadas pelo próprio Chrome).
async function applyBlockRules(policy) {
    const addRules = [];                                   // regras novas
    policy.domains.forEach((d, i) => {                     // para cada site de IA da política
        const action = actionFor(policy, d.domain);        // monitor, block ou redirect
        if (action === 'monitor') return;                  // monitorado: não cria regra (acesso permitido)
        const url =
            action === 'redirect' && policy.redirectUrl
                ? policy.redirectUrl                       // redirect: vai para a página da empresa
                : chrome.runtime.getURL(`blocked.html?d=${encodeURIComponent(d.domain)}&n=${encodeURIComponent(d.name ?? '')}`); // block: nossa página
        addRules.push({
            id: i + 1,                                     // número único da regra
            priority: 1,
            action: { type: 'redirect', redirect: { url } }, // o que fazer: redirecionar
            condition: { requestDomains: [d.domain], resourceTypes: ['main_frame', 'sub_frame'] }, // quando: página ou iframe desse domínio
        });
    });
    const old = await chrome.declarativeNetRequest.getDynamicRules(); // regras antigas
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((r) => r.id), addRules }); // troca todas de uma vez
}

// Registra o detector de dados sensíveis para rodar dentro dos sites de IA.
async function applyContentScripts(policy) {
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] }); // já existe registro?
    if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }); // remove o antigo
    if (!policy.pii?.enabled) return;                      // proteção desligada: não registra

    await chrome.scripting.registerContentScripts([
        {
            id: CONTENT_SCRIPT_ID,
            matches: policy.domains.flatMap((d) => [`*://${d.domain}/*`, `*://*.${d.domain}/*`]), // domínio e subdomínios
            js: ['content/pii.js', 'content/content.js'], // detector primeiro, depois quem usa o detector
            runAt: 'document_start',                      // roda o mais cedo possível na página
            persistAcrossSessions: true,                  // continua valendo após reiniciar o navegador
        },
    ]);
}

// Coloca o detector nas abas de IA que JÁ estavam abertas (o registro acima só vale para páginas novas).
// Sem isso, depois de atualizar a extensão, essas abas continuariam com a versão antiga até o F5.
async function injectIntoOpenTabs(policy) {
    if (!policy.pii?.enabled) return;                                                         // proteção desligada
    const tabs = await chrome.tabs.query({ url: policy.domains.flatMap((d) => [`*://${d.domain}/*`, `*://*.${d.domain}/*`]) }); // abas de sites de IA
    for (const tab of tabs) {
        chrome.scripting
            .executeScript({ target: { tabId: tab.id }, files: ['content/pii.js', 'content/content.js'] }) // injeta a versão nova
            .catch(() => {});                                                                  // aba fechada/carregando: ignora
    }
}

// Uma sincronização por vez: se duas rodassem juntas (alarme + botão "Sincronizar agora", por exemplo),
// as duas tentariam criar as mesmas regras e o Chrome recusaria por "ID duplicado".
let syncChain = Promise.resolve();
function sync() {
    const run = syncChain.then(doSync, doSync); // espera a anterior terminar (dando certo ou não)
    syncChain = run.catch(() => {});            // um erro não trava as próximas
    return run;
}

// Ciclo completo: baixar política → aplicar → agendar tarefas.
async function doSync() {
    const { policy: previous } = await chrome.storage.local.get('policy'); // política anterior (para comparar versão)
    const policy = await refreshPolicy();                                   // baixa a nova
    await applyBlockRules(policy);                                          // aplica bloqueios
    await applyContentScripts(policy);                                      // aplica detector
    await injectIntoOpenTabs(policy);                                       // abas já abertas também recebem (site novo na política, proteção ligada)
    await chrome.alarms.create('policy-refresh', { periodInMinutes: Math.max(1, policy.refreshMinutes ?? 15) }); // atualizar política periodicamente
    await chrome.alarms.create('flush-events', { periodInMinutes: 1 });     // reenviar eventos a cada minuto
    if (previous?.version !== policy.version) {                            // só registra se a versão mudou
        await logEvent('policy_applied', { policyVersion: policy.version, source: policy.source });
    }
    return policy;
}

// ---------- Evidência ----------

// Tira um screenshot da aba (só funciona se ela for a aba visível).
async function captureTab(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);                                          // dados da aba
        if (!tab.active) return null;                                                      // aba em segundo plano: não dá para capturar
        return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 }); // imagem em base64
    } catch {
        return null;                                                                       // aba fechada ou página protegida
    }
}

// Tira da URL a parte depois de "?" e "#" (pode conter dados pessoais).
function safeUrl(url) {
    const u = new URL(url);
    return u.origin + u.pathname; // ex.: https://chatgpt.com/c/123
}

// ---------- Detecção de acesso ----------

// Antes de cada navegação: registra se o destino é um site de IA.
chrome.webNavigation.onBeforeNavigate.addListener(async ({ tabId, frameId, url }) => {
    if (frameId !== 0) return;                  // 0 = página principal (ignora iframes)
    const policy = await getPolicy();
    const match = matchDomain(policy, url);     // é site de IA?
    if (!match) return;                         // não é: ignora
    await logEvent('ai_access', {
        domain: match.domain,                   // ex.: chatgpt.com
        service: match.name,                    // ex.: ChatGPT
        url: safeUrl(url),
        action: actionFor(policy, match.domain), // o que foi aplicado: monitor, block ou redirect
        tabId,
    });
});

// Quando a página termina de carregar: screenshot opcional dos sites permitidos.
chrome.webNavigation.onCompleted.addListener(async ({ tabId, frameId, url }) => {
    if (frameId !== 0) return;                                             // só a página principal
    const policy = await getPolicy();
    if (!policy.screenshot?.onAccess) return;                              // política não pede screenshot no acesso
    const match = matchDomain(policy, url);
    if (!match || actionFor(policy, match.domain) !== 'monitor') return;   // só sites de IA permitidos
    const screenshot = await captureTab(tabId);
    if (screenshot) await logEvent('ai_access_screenshot', { domain: match.domain, url: safeUrl(url), screenshot });
});

// ---------- Mensagens (popup e páginas) ----------

async function handleMessage(msg, sender) {
    switch (msg.type) { // o que foi pedido
        case 'pii-config': { // a página pede as regras de dados sensíveis
            const [policy, cfg, email] = await Promise.all([getPolicy(), getConfig(), userEmail()]);
            return policy.pii ? effectivePii(policy.pii, email, cfg.group) : { enabled: false }; // já sem os tipos autorizados
        }

        case 'pii-auth-request': { // usuário clicou em "Solicitar autorização"
            const policy = await getPolicy();
            const match = matchDomain(policy, sender.tab?.url ?? msg.url);  // em qual site de IA
            await flushEvents(); // envia antes o bloqueio que estiver na fila, senão o servidor não acha o incidente para juntar a justificativa
            await logEvent('pii_authorization_request', {
                incidentId: msg.incidentId,        // bloqueio ao qual este pedido se refere (o servidor junta a justificativa nele)
                domain: match?.domain,
                service: match?.name,
                url: msg.url,
                types: msg.types,                                           // quais dados quer enviar
                justification: String(msg.justification ?? '').slice(0, 1000), // justificativa (máx. 1000 caracteres)
                prompt: String(msg.prompt ?? '').slice(0, 5000),            // texto bloqueado, mascarado
                originalText: String(msg.original ?? '').slice(0, 5000),    // texto bloqueado, original
            });
            await flushEvents(); // envia na hora para a equipe de segurança
            return { ok: true };
        }

        case 'pii-event': { // a página detectou (e bloqueou ou mascarou) um dado sensível
            const policy = await getPolicy();
            const match = matchDomain(policy, sender.tab?.url ?? msg.url);
            let screenshot = null;
            if (policy.screenshot?.onPii && sender.tab) {           // evidência, se a política pedir
                await new Promise((r) => setTimeout(r, 300));       // espera o aviso de bloqueio aparecer na tela
                screenshot = await captureTab(sender.tab.id);       // print com o aviso visível
            }
            await logEvent('pii_detected', {
                incidentId: msg.incidentId,        // código do incidente (criado na página)
                domain: match?.domain,
                service: match?.name,
                url: msg.url,
                stage: msg.stage,   // 'paste' (colagem) ou 'submit' (envio)
                action: msg.action, // 'blocked' ou 'masked'
                counts: msg.counts, // ex.: { cpf: 1 }
                prompt: String(msg.prompt ?? '').slice(0, 5000),         // texto pedido, mascarado (limitado a 5000 caracteres)
                originalText: String(msg.original ?? '').slice(0, 5000), // texto pedido, ORIGINAL (o que a pessoa digitou/colou)
                ...(screenshot && { screenshot }), // print da tela na hora do bloqueio (se a política pedir)
            });
            return { ok: true };
        }

        case 'status': { // o popup pede informações para exibir
            const [cfg, policy, { lastSync }, queued] = await Promise.all([
                getConfig(),
                getPolicy(),
                chrome.storage.local.get('lastSync'),
                queueSize(),
            ]);
            const match = msg.url ? matchDomain(policy, msg.url) : null; // a aba atual é site de IA?
            return {
                config: { ...cfg, apiKey: cfg.apiKey ? '••••' : '' }, // esconde a chave
                policy: { version: policy.version, source: policy.source, domains: policy.domains.length, pii: policy.pii },
                lastSync,
                queued,
                currentTab: match && { ...match, action: actionFor(policy, match.domain) },
            };
        }

        case 'sync': // botão "Sincronizar agora"
            await sync();
            await flushEvents();
            return { ok: true };

        case 'save-config': { // formulário de configuração do popup
            const cfg = await getConfig();
            if (cfg.managed) throw new Error('Configuração gerenciada pela empresa'); // empresa manda: não deixa alterar
            await saveLocalConfig(msg.config);
            await sync(); // aplica a nova configuração na hora
            return { ok: true };
        }

        default:
            throw new Error(`Mensagem desconhecida: ${msg.type}`);
    }
}

// Recebe as mensagens e devolve a resposta (ou { error }).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handleMessage(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e.message ?? e) }));
    return true; // mantém o canal aberto até a resposta assíncrona ficar pronta
});

// ---------- Ciclo de vida ----------

chrome.runtime.onInstalled.addListener(async () => {
    await scrubQueue();                  // remove dados em claro deixados na fila por versões antigas
    await sync();                        // aplica a política (o sync já atualiza as abas abertas)
});
chrome.runtime.onStartup.addListener(sync);   // ao abrir o navegador

chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'managed') sync(); // empresa mudou a configuração: aplica na hora
});

chrome.alarms.onAlarm.addListener(({ name }) => {
    if (name === 'policy-refresh') sync();       // hora de atualizar a política
    if (name === 'flush-events') flushEvents();  // hora de reenviar eventos pendentes
});
