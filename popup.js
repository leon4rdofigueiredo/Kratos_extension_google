// =====================================================================================
// popup.js — Comportamento da janela que abre ao clicar no ícone (popup.html)
// =====================================================================================

const $ = (id) => document.getElementById(id);                                         // atalho: pega um elemento pelo id
const ACTION_LABELS = { monitor: 'Monitorado', block: 'Bloqueado', redirect: 'Redirecionado' }; // textos do selo da aba

// Envia uma mensagem ao background; se vier { error }, vira exceção.
async function send(msg) {
    const res = await chrome.runtime.sendMessage(msg); // pede ao background
    if (res?.error) throw new Error(res.error);        // background respondeu com erro
    return res;
}

// Texto da proteção de dados. Considera também as ações por tipo (pii.actions):
// se uns tipos são bloqueados e outros mascarados, mostra "Bloquear e mascarar".
function piiLabel(pii) {
    if (!pii?.enabled) return 'Desligada';
    const defaultMode = pii.mode === 'mask' ? 'mask' : 'block';
    const modes = new Set([defaultMode, ...Object.values(pii.actions ?? {})]);
    if (modes.has('block') && modes.has('mask')) return 'Bloquear e mascarar';
    return modes.has('mask') ? 'Mascarar' : 'Bloquear';
}

// Busca o status e preenche a tela.
async function render() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); // aba aberta agora
    const s = await send({ type: 'status', url: tab?.url });                     // status completo

    // seção "Esta aba" (montada com textContent: o nome vem da política e nunca é lido como HTML)
    const badge = document.createElement('span');
    badge.className = `badge ${s.currentTab ? s.currentTab.action : 'none'}`;
    badge.textContent = s.currentTab ? ACTION_LABELS[s.currentTab.action] : 'Não é um serviço de IA monitorado';
    $('tab').replaceChildren(badge, s.currentTab ? ` ${s.currentTab.name ?? s.currentTab.domain}` : ''); // site de IA: selo + nome

    $('version').textContent = s.policy.version;                                                 // versão da política
    $('source').textContent = s.policy.source === 'remote' ? 'Backend' : 'Padrão local';         // de onde veio
    $('group').textContent = s.config.group;                                                     // departamento
    $('domains').textContent = s.policy.domains;                                                 // quantos sites de IA
    $('pii').textContent = piiLabel(s.policy.pii);                                              // proteção de dados
    $('sync').textContent = s.lastSync?.at ? new Date(s.lastSync.at).toLocaleString('pt-BR') : 'nunca'; // última sincronização
    $('queued').textContent = s.queued;                                                          // eventos aguardando envio
    $('syncError').textContent = s.lastSync?.error ? `Falha ao buscar política: ${s.lastSync.error}` : ''; // erro, se houver

    const form = $('configForm');
    form.hidden = s.config.managed;                // empresa gerencia: esconde o formulário
    $('managedNote').hidden = !s.config.managed;   // e mostra o aviso
    form.apiUrl.value = s.config.apiUrl;           // preenche a URL atual
    form.group.value = s.config.group;             // preenche o grupo atual
}

// Botão "Sincronizar agora".
$('syncBtn').addEventListener('click', async () => {
    $('syncBtn').disabled = true;    // desativa enquanto trabalha
    try {
        await send({ type: 'sync' }); // baixa a política e envia eventos
    } finally {
        $('syncBtn').disabled = false; // reativa, mesmo se der erro
        render();                      // atualiza a tela
    }
});

// Botão "Salvar" da configuração.
$('configForm').addEventListener('submit', async (e) => {
    e.preventDefault();   // impede o formulário de recarregar o popup
    const form = e.target;
    const { localConfig = {} } = await chrome.storage.local.get('localConfig'); // configuração atual
    try {
        await send({
            type: 'save-config',
            config: {
                apiUrl: form.apiUrl.value,
                apiKey: form.apiKey.value || localConfig.apiKey || '', // campo vazio = mantém a chave atual
                group: form.group.value,
            },
        });
        form.apiKey.value = '';            // limpa o campo da chave
        $('msg').textContent = 'Salvo.';
    } catch (err) {
        $('msg').textContent = err.message; // mostra o erro
    }
    render();
});

render().catch((e) => ($('tab').textContent = e.message)); // preenche a tela ao abrir o popup
