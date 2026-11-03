// =====================================================================================
// content.js — Proteção dentro da página do site de IA
// -------------------------------------------------------------------------------------
// Vigia a COLAGEM (Ctrl+V) e o ENVIO (Enter / botão Enviar). Se achar dado sensível,
// bloqueia (padrão) ou mascara, conforme a política, e avisa o background para registrar
// o incidente (contagens, texto mascarado e texto original).
// =====================================================================================

(() => {
    const alive = () => !!chrome.runtime?.id;     // false = extensão foi atualizada e este script ficou "órfão" (versão antiga)
    if (globalThis.__iaGuard?.alive()) {          // já existe uma cópia ativa nesta página: não roda de novo...
        globalThis.__iaGuard.reload?.();          // ...só pede para ela buscar a política nova
        return;
    }
    globalThis.__iaGuard = { alive, reload: () => loadConfig() }; // marca que esta cópia é a ativa

    // Envia mensagem ao background sem nunca "quebrar" a página.
    // (Depois de recarregar a extensão, o script antigo perde a conexão e o Chrome lança erro.)
    function sendToBackground(msg) {
        try {
            if (!chrome.runtime?.id) throw new Error('Extension context invalidated'); // conexão perdida
            return chrome.runtime.sendMessage(msg);                                    // envia normalmente
        } catch (e) {
            return Promise.reject(e);                                                  // transforma em erro tratável
        }
    }

    // Enquanto o background não responde, já protege com o detector padrão (todos os tipos, bloqueando).
    // Antes começava desligado, e uma colagem feita logo que a página abria passava sem verificação.
    // Este script só é colocado nas páginas quando a proteção está ligada na política.
    let cfg = { enabled: true, mode: 'block' };
    let scanner = PII.createScanner();    // detector (de content/pii.js)

    // Pede as regras ao background (também é chamado quando a política muda, ver __iaGuard.reload).
    function loadConfig() {
        sendToBackground({ type: 'pii-config' }).then(
            (c) => {
                if (!c || c.error) return;     // resposta inválida: mantém o que tem
                cfg = c;                       // guarda as regras
                scanner = PII.createScanner(c); // cria o detector com as regras da empresa
            },
            () => {},                          // falhou: ignora
        );
    }
    loadConfig();

    const TYPE_LABELS = { // nomes legíveis dos tipos, usados nos avisos
        cpf: 'CPF',
        cnpj: 'CNPJ',
        rg: 'RG',
        cnh: 'CNH',
        pis: 'PIS',
        voter_id: 'título de eleitor',
        email: 'e-mail',
        phone: 'telefone',
        card: 'cartão',
        secret: 'senha/token',
        keyword: 'termo confidencial',
    };

    // Onde o usuário digita o prompt (textarea, input ou editor "contenteditable").
    const FIELD_SELECTOR = 'textarea, input[type="text"], input:not([type]), [contenteditable="true"], [contenteditable=""]';
    // Como reconhecer o botão de enviar. Vale para <button> e também para <div role="button">,
    // que alguns sites usam no lugar de botão (antes, clicar num desses enviava sem verificação).
    const SEND_BUTTON_SELECTOR = [
        'button[type="submit"]',                                // botão de formulário
        'input[type="submit"]',
        ...['button', '[role="button"]'].flatMap((tag) => [
            `${tag}[data-testid*="send" i]`,                    // ex.: ChatGPT
            `${tag}[aria-label*="send" i]`,                     // rótulo "Send..."
            `${tag}[aria-label*="enviar" i]`,                   // rótulo "Enviar..."
            `${tag}[aria-label*="submit" i]`,                   // rótulo "Submit..."
        ]),
    ].join(',');

    let lastField = null; // último campo de texto que teve foco

    const fieldOf = (el) => (el instanceof Element ? el.closest(FIELD_SELECTOR) : null); // campo de texto que contém o elemento
    const isInput = (el) => el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';          // campo simples (não editor)
    const getText = (el) => (isInput(el) ? el.value : el.innerText);                     // texto digitado no campo

    // Troca todo o texto do campo (usado para aplicar a versão mascarada).
    function setText(el, text) {
        el.focus();                                                                    // coloca o cursor no campo
        if (isInput(el)) {                                                             // textarea/input:
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);       // muda o valor pelo método nativo
            el.dispatchEvent(new Event('input', { bubbles: true }));                  // avisa o site (React etc.) da mudança
        } else {                                                                       // editor contenteditable:
            const range = document.createRange();
            range.selectNodeContents(el);                                              // seleciona todo o conteúdo
            const sel = getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('insertText', false, text);                           // "digita" o novo texto por cima
        }
    }

    // Insere texto onde está o cursor (usado para colar a versão mascarada).
    function insertAtCursor(el, text) {
        if (isInput(el)) {
            el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end'); // insere no cursor
            el.dispatchEvent(new Event('input', { bubbles: true }));          // avisa o site
        } else {
            document.execCommand('insertText', false, text);                  // editor: insere como se fosse digitado
        }
    }

    const pageUrl = () => location.origin + location.pathname; // URL sem "?" e "#"

    let lastBlocked = null; // último texto bloqueado (vai junto no pedido de autorização)

    // Avisa o background para registrar o evento. Devolve o código do incidente, que o pedido de
    // autorização usa depois para a justificativa ficar junto deste mesmo incidente no servidor.
    function report(stage, action, result, original) {
        const incidentId = crypto.randomUUID();
        sendToBackground({
            type: 'pii-event',
            incidentId,             // código do incidente
            stage,                  // 'paste' (colagem) ou 'submit' (envio)
            action,                 // 'blocked' ou 'masked'
            counts: result.counts,  // quantos de cada tipo, ex.: { cpf: 1 }
            prompt: result.masked,  // o que a pessoa tentou enviar, mascarado ("digite cpf [CPF]")
            original,               // o que a pessoa tentou enviar, ORIGINAL ("digite cpf 136.543.287-41")
            url: pageUrl(),
        }).catch(() => {});
        return incidentId;
    }

    // { cpf: 1, email: 2 } → "1 CPF, 2 e-mail"
    function describe(counts) {
        return Object.entries(counts)
            .map(([t, n]) => `${n} ${TYPE_LABELS[t] ?? t}`) // quantidade + nome
            .join(', ');
    }

    // Decide entre bloquear e mascarar.
    function decide(result) {
        const block = Object.keys(result.counts).some((t) => (cfg.actions?.[t] ?? cfg.mode ?? 'block') === 'block'); // algum tipo exige bloqueio?
        return block ? 'block' : 'mask';
    }

    // ---------- Avisos visuais ----------

    let ui = null; // elementos do aviso (criados na primeira vez)
    function getUi() {
        if (ui) return ui;                               // já criado: reaproveita
        const host = document.createElement('div');     // elemento que vai na página
        const root = host.attachShadow({ mode: 'open' }); // área isolada: o CSS do site não interfere
        root.innerHTML = `
            <style>
                /* caixa fixa no canto inferior direito */
                .box { position: fixed; z-index: 2147483647; right: 20px; bottom: 20px; width: 380px; max-width: calc(100vw - 40px);
                       box-sizing: border-box; padding: 14px 16px; border-radius: 10px; font: 14px/1.45 system-ui, sans-serif;
                       color: #fff; box-shadow: 0 6px 24px rgba(15, 34, 51, 0.25); }
                .warn { background: #d98a0b; } .block { background: #1aa3dd; } .ok { background: #1f9d6b; } /* laranja, azul (cor do kratos), verde */
                .title { font-weight: 600; margin-bottom: 4px; }
                textarea { width: 100%; box-sizing: border-box; margin-top: 10px; min-height: 60px; padding: 6px 8px;
                           border: 0; border-radius: 6px; font: inherit; color: #0f2233; resize: vertical; }
                .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
                button { padding: 6px 12px; border: 1px solid rgba(255,255,255,.7); border-radius: 6px; font: inherit;
                         cursor: pointer; background: transparent; color: #fff; }
                button.primary { background: #fff; color: #1aa3dd; border-color: #fff; font-weight: 600; }
                button:disabled { opacity: .6; cursor: default; }
            </style>
            <div class="box" hidden>
                <div class="title"></div>  <!-- título do aviso -->
                <div class="msg"></div>    <!-- mensagem -->
                <div class="auth" hidden>  <!-- parte de "Solicitar autorização" -->
                    <textarea placeholder="Justificativa: por que você precisa enviar este dado para a IA?"></textarea>
                    <div class="row">
                        <button class="close">Fechar</button>
                        <button class="primary request">Solicitar autorização</button>
                    </div>
                </div>
            </div>`;
        document.documentElement.appendChild(host);      // coloca na página
        const $ = (s) => root.querySelector(s);          // atalho para achar elementos
        ui = { box: $('.box'), title: $('.title'), msg: $('.msg'), auth: $('.auth'), text: $('textarea'), close: $('.close'), request: $('.request') };
        ui.close.addEventListener('click', () => (ui.box.hidden = true)); // botão Fechar esconde o aviso
        return ui;
    }

    // Mostra um aviso. kind: 'warn' | 'block' | 'ok'.
    function show(kind, title, message, { autoHide = true, authTypes = null } = {}) {
        const u = getUi();
        clearTimeout(show.timer);           // cancela o sumiço automático anterior
        u.box.className = `box ${kind}`;    // cor do aviso
        u.title.textContent = title;        // textContent: nunca interpreta HTML
        u.msg.textContent = message;
        u.auth.hidden = !authTypes;         // mostra a parte de autorização só no bloqueio
        u.box.hidden = false;               // exibe

        if (authTypes) {
            u.text.value = '';              // limpa a justificativa
            u.request.disabled = false;
            u.request.onclick = async () => {                 // clique em "Solicitar autorização"
                const justification = u.text.value.trim();
                if (justification.length < 10) {              // justificativa curta demais: avisa na própria caixa
                    u.text.focus();
                    u.msg.textContent = `A justificativa precisa ter pelo menos 10 caracteres (você escreveu ${justification.length}).`;
                    return;
                }
                u.request.disabled = true;                    // evita clicar duas vezes
                try {
                    await sendToBackground({
                        type: 'pii-auth-request',
                        types: authTypes,                   // tipos de dado que quer liberar
                        justification,                      // por que precisa
                        incidentId: lastBlocked?.incidentId, // de qual bloqueio é este pedido
                        prompt: lastBlocked?.masked,        // texto bloqueado, mascarado
                        original: lastBlocked?.original,    // texto bloqueado, original
                        url: pageUrl(),
                    }); // envia o pedido
                    show('ok', 'Solicitação enviada', 'A equipe de Segurança da Informação vai analisar o pedido. Enquanto isso, o envio continua bloqueado.');
                } catch {
                    u.request.disabled = false;               // permite tentar de novo
                    u.msg.textContent = chrome.runtime?.id
                        ? 'Não foi possível enviar a solicitação. Tente novamente.'
                        : 'A extensão foi atualizada. Recarregue a página (F5) e tente novamente.';
                }
            };
        }
        if (autoHide) show.timer = setTimeout(() => (u.box.hidden = true), 7000); // some sozinho após 7 s
    }

    // Aviso de bloqueio (fica na tela até o usuário fechar).
    function showBlocked(title, result) {
        const types = Object.keys(result.counts); // tipos encontrados, ex.: ['cpf']
        show(
            'block',
            title,                                // "Colagem bloqueada" ou "Envio bloqueado"
            `O texto contém dados sensíveis (${describe(result.counts)}). Pela política da empresa, esses dados não podem ser enviados para IA sem autorização. Remova-os ou solicite autorização.`,
            { autoHide: false, authTypes: cfg.allowRequests === false ? null : types }, // botão de autorização, se a política permitir
        );
    }

    // ---------- Colagem (Ctrl+V) ----------

    document.addEventListener(
        'paste',
        (e) => {
            if (!alive() || !cfg.enabled) return;                  // versão antiga (órfã) ou proteção desligada
            const field = fieldOf(e.target);                       // campo onde está colando
            const text = e.clipboardData?.getData('text/plain');   // texto que está sendo colado
            if (!field || !text) return;                           // fora de campo de texto, ou não é texto

            const result = scanner.scan(text);                     // procura dados sensíveis
            if (!result.total) return;                             // nada encontrado: cola normalmente

            e.preventDefault();                                    // cancela a colagem
            e.stopImmediatePropagation();                          // impede o site de receber
            if (decide(result) === 'block') {
                const incidentId = report('paste', 'blocked', result, text);           // registra (com o texto original colado)
                lastBlocked = { masked: result.masked, original: text, incidentId };    // guarda para o pedido de autorização
                showBlocked('Colagem bloqueada', result);                               // bloqueio: mostra aviso
            } else {
                insertAtCursor(field, result.masked);              // máscara: cola a versão com [CPF] etc.
                show('warn', 'Dados mascarados', `Dados sensíveis foram mascarados na colagem (${describe(result.counts)}).`);
                report('paste', 'masked', result, text);
            }
        },
        true, // fase de captura: roda ANTES do código do site
    );

    // ---------- Envio ----------

    // Verifica o texto no momento do envio. Retorna true se interrompeu.
    function guardSubmit(e, field) {
        if (!alive() || !cfg.enabled || !field) return false; // versão antiga (órfã), proteção desligada ou sem campo
        const original = getText(field);                    // texto que a pessoa tentou enviar
        const result = scanner.scan(original);              // procura dados sensíveis no texto
        if (!result.total) return false;                    // nada encontrado: envio segue

        e.preventDefault();                                 // cancela o envio
        e.stopImmediatePropagation();                       // impede o site de enviar
        if (decide(result) === 'block') {
            const incidentId = report('submit', 'blocked', result, original);  // registra
            lastBlocked = { masked: result.masked, original, incidentId };      // guarda para o pedido de autorização
            showBlocked('Envio bloqueado', result);                             // bloqueio: aviso + autorização
        } else {
            setText(field, result.masked);                  // máscara: troca o texto e o usuário reenvia
            show('warn', 'Dados mascarados', `Dados sensíveis foram mascarados (${describe(result.counts)}). Revise e envie novamente.`);
            report('submit', 'masked', result, original);
        }
        return true;
    }

    document.addEventListener('focusin', (e) => {           // quando algo recebe foco...
        const f = fieldOf(e.target);
        if (f) lastField = f;                               // ...guarda se for campo de texto
    });

    window.addEventListener(
        'keydown',
        (e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return; // só Enter puro (Shift+Enter = nova linha)
            guardSubmit(e, fieldOf(e.target));                              // verifica antes de enviar
        },
        true, // captura: antes do site
    );

    window.addEventListener(
        'click',
        (e) => {
            const button = e.target instanceof Element && e.target.closest(SEND_BUTTON_SELECTOR); // clicou num botão de enviar?
            if (!button) return;                                                                   // não: ignora
            const field = button.closest('form')?.querySelector(FIELD_SELECTOR) ?? lastField;      // campo do formulário ou último usado
            guardSubmit(e, field);
        },
        true,
    );

    window.addEventListener(
        'submit',
        (e) => {
            guardSubmit(e, e.target.querySelector?.(FIELD_SELECTOR) ?? lastField); // envio por formulário
        },
        true,
    );
})();
