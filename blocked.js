// =====================================================================================
// blocked.js — Preenche a página "Acesso bloqueado" (blocked.html)
// A URL chega assim: blocked.html?d=deepseek.com&n=DeepSeek
// =====================================================================================

const params = new URLSearchParams(location.search); // lê os parâmetros depois do "?"
const domain = params.get('d') ?? '';                // d = domínio bloqueado
const name = params.get('n');                        // n = nome do serviço

document.getElementById('domain').textContent = domain;                   // mostra o domínio (textContent: nunca como HTML)
if (name) document.getElementById('service').textContent = name;          // mostra o nome, se veio
