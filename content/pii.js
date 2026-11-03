// =====================================================================================
// pii.js — Detector de dados sensíveis
// -------------------------------------------------------------------------------------
// Recebe um texto e devolve { masked, counts, total }:
//   masked = texto com os dados trocados por marcadores ([CPF], [EMAIL]...)
//   counts = quantos de cada tipo, ex.: { cpf: 1, email: 2 }
//   total  = soma de tudo
// Só detecta; quem bloqueia ou mascara é o content.js.
// =====================================================================================

(() => {
    const allSame = (d) => /^(\d)\1+$/.test(d); // "11111111111" etc.: passam na conta mas não são válidos

    // ---------- Validadores (recebem só os dígitos) ----------

    function cpf(d) {
        if (d.length !== 11 || allSame(d)) return false;              // CPF tem 11 dígitos
        for (const n of [9, 10]) {                                     // calcula os 2 dígitos verificadores
            let sum = 0;
            for (let i = 0; i < n; i++) sum += +d[i] * (n + 1 - i);   // pesos 10..2 e depois 11..2
            if (((sum * 10) % 11) % 10 !== +d[n]) return false;       // não bate: não é CPF
        }
        return true;
    }

    function cnpj(d) {
        if (d.length !== 14 || allSame(d)) return false; // CNPJ tem 14 dígitos
        const dv = (n) => {                              // calcula um dígito verificador
            let sum = 0;
            let w = n - 7;                               // peso inicial: 5 (1º DV) ou 6 (2º DV)
            for (let i = 0; i < n; i++) {
                sum += +d[i] * w--;                      // multiplica pelo peso e diminui o peso
                if (w < 2) w = 9;                        // depois do 2, volta para 9
            }
            const r = sum % 11;                          // resto da divisão por 11
            return r < 2 ? 0 : 11 - r;
        };
        return dv(12) === +d[12] && dv(13) === +d[13];   // confere os dois verificadores
    }

    function pis(d) {
        if (d.length !== 11 || allSame(d)) return false; // PIS tem 11 dígitos
        const w = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];        // pesos oficiais
        let sum = 0;
        for (let i = 0; i < 10; i++) sum += +d[i] * w[i];
        const r = 11 - (sum % 11);
        return (r >= 10 ? 0 : r) === +d[10];             // 1 dígito verificador (validação fraca)
    }

    function cnh(d) {
        if (d.length !== 11 || allSame(d)) return false;        // CNH tem 11 dígitos
        let sum = 0;
        for (let i = 0; i < 9; i++) sum += +d[i] * (9 - i);     // 1º DV: pesos 9..1
        let dv1 = sum % 11;
        let inc = 0;                                            // ajuste usado no 2º DV
        if (dv1 >= 10) {
            dv1 = 0;
            inc = 2;
        }
        sum = 0;
        for (let i = 0; i < 9; i++) sum += +d[i] * (i + 1);     // 2º DV: pesos 1..9
        let dv2 = sum % 11;
        dv2 = dv2 >= 10 ? 0 : dv2 - inc;
        if (dv2 < 0) dv2 += 11;
        if (dv2 >= 10) dv2 = 0;
        return dv1 === +d[9] && dv2 === +d[10];                 // confere os dois
    }

    function voterId(d) {
        if (d.length !== 12 || allSame(d)) return false;        // título tem 12 dígitos
        const uf = +d.slice(8, 10);                             // 9º e 10º dígitos = código do estado
        if (uf < 1 || uf > 28) return false;                    // estados vão de 01 a 28
        const spMg = uf === 1 || uf === 2;                      // SP e MG têm regra especial
        let sum = 0;
        for (let i = 0; i < 8; i++) sum += +d[i] * (i + 2);     // 1º DV: pesos 2..9
        let dv1 = sum % 11;
        if (dv1 === 10) dv1 = 0;
        else if (dv1 === 0 && spMg) dv1 = 1;
        let dv2 = (+d[8] * 7 + +d[9] * 8 + dv1 * 9) % 11;       // 2º DV: usa o estado e o 1º DV
        if (dv2 === 10) dv2 = 0;
        else if (dv2 === 0 && spMg) dv2 = 1;
        return dv1 === +d[10] && dv2 === +d[11];
    }

    function card(d) {
        if (d.length < 13 || d.length > 19 || !/^(4|5[1-5]|2[2-7]|3[0478]|6|50)/.test(d)) return false; // tamanho e início de bandeira conhecida
        let sum = 0;
        for (let i = 0; i < d.length; i++) {           // algoritmo de Luhn, da direita para a esquerda
            let n = +d[d.length - 1 - i];
            if (i % 2) {                               // um dígito sim, outro não...
                n *= 2;                                // ...é dobrado
                if (n > 9) n -= 9;                     // e se passar de 9, subtrai 9
            }
            sum += n;
        }
        return sum % 10 === 0;                         // válido se a soma termina em 0
    }

    // RG: cada estado tem seu formato e não há dígito verificador nacional.
    // Aceita 8 ou 9 dígitos, mas só quando "RG"/"identidade" aparece perto (ver NUMERIC).
    function rg(d) {
        return (d.length === 8 || d.length === 9) && !allSame(d);
    }

    function phone(d) {
        if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2); // tira o código do país (55)
        if (!/^[1-9][1-9]/.test(d)) return false;                                     // DDD válido (sem zero)
        return (d.length === 11 && d[2] === '9') || (d.length === 10 && /[2-5]/.test(d[2])); // celular (9...) ou fixo (2 a 5)
    }

    // Tipos numéricos, em ordem de prioridade (o primeiro que validar vence).
    const NUMERIC = [
        { type: 'cnpj', label: '[CNPJ]', valid: cnpj },
        { type: 'cpf', label: '[CPF]', valid: cpf },
        { type: 'voter_id', label: '[VOTER_ID]', valid: voterId },
        { type: 'cnh', label: '[CNH]', valid: cnh, context: /\b(cnh|habilita[cç][aã]o)\b/i },  // exige a palavra "CNH" antes (validação fraca)
        { type: 'pis', label: '[PIS]', valid: pis, context: /\b(pis|pasep|nit|nis)\b/i },       // exige a palavra "PIS" antes (validação fraca)
        { type: 'rg', label: '[RG]', valid: rg, context: /\b(rg|identidade|registro\s+geral)\b/i }, // exige "RG"/"identidade" perto (sem validação)
        { type: 'card', label: '[CARD]', valid: card, shape: (lens) => lens.every((l) => l >= 3) }, // blocos de 3+ dígitos (ex.: 4111 1111 ...)
        { type: 'phone', label: '[PHONE]', valid: phone, shape: (lens) => lens.length === 1 || (lens[0] <= 2 && lens.at(-1) >= 4) }, // corrido ou (DDD) + número
    ];

    // ---------- Padrões de texto ----------
    // "v" = parte que será trocada (o resto é mantido, ex.: "senha: " continua visível).

    const BUILTIN = [
        {
            type: 'secret',
            label: '[PRIVATE_KEY]',
            re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // bloco de chave privada inteiro
        },
        {
            type: 'secret',
            label: '[TOKEN]',
            re: /\b(?:sk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{40,}|AIza[\w-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g, // tokens: OpenAI/Anthropic, AWS, GitHub, Google, Slack, JWT
        },
        { type: 'secret', label: '[PASSWORD]', re: /\b(?:senha|password|passwd|pwd|pass)\s*[:=]\s*(?<v>\S+)/gi }, // "senha: xxx" → troca só o xxx
        {
            type: 'email',
            label: '[EMAIL]',
            re: /[\w.+-]+\s*(?:@|\(at\)|\[at\]|\sarroba\s)\s*[\w-]+(?:(?:\.|\s+\.\s+|\s*\(dot\)\s*|\s*\[dot\]\s*|\s+(?:ponto|dot)\s+)[\w-]+)+/gi, // e-mail, inclusive "joao arroba empresa ponto com"
        },
        { type: 'rg', label: '[RG]', re: /\bRG\b[\s:nº°.#-]*(?<v>[\dxX](?:[\s.-]?[\dxX]){6,12})/gi }, // "RG: 12.345.678-X" (logo depois da palavra "RG")
        { type: 'rg', label: '[RG]', re: /(?<![\d.])\d{1,2}\.\d{3}\.\d{3}-[\dxX](?![\d.])/g },       // formato típico de RG com pontos (26.041.242-4), mesmo sem a palavra
    ];

    // Aplica uma lista de padrões: troca cada achado pelo marcador e conta.
    function applyRegex(text, detectors, counts) {
        for (const { type, label, re } of detectors) {           // para cada padrão
            text = text.replace(re, (...args) => {                // para cada trecho encontrado
                const m = args[0];                                // trecho encontrado
                const v = args.at(-1)?.v;                         // parte "v", se o padrão tiver
                counts[type] = (counts[type] ?? 0) + 1;           // conta +1 desse tipo
                return v ? m.slice(0, m.length - v.length) + label : label; // troca só "v" ou o trecho todo
            });
        }
        return text;
    }

    // ---------- Palavras-chave da empresa ----------

    const fold = (s) => s.split('').map((c) => c.normalize('NFD')[0].toLowerCase()[0]).join(''); // tira acentos e maiúsculas (mesmo tamanho do original)
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');                           // protege caracteres especiais de regex

    // Monta a regex de uma palavra-chave aceitando letras separadas ("c o n f i d e n c i a l").
    function keywordRegex(term) {
        const body = [...term]
            .map((c) => (/\s/.test(c) ? '[^\\p{L}\\p{N}]+' : escapeRe(c))) // espaço da expressão = qualquer separador
            .join('[^\\p{L}\\p{N}]{0,3}');                                  // entre letras: até 3 símbolos/espaços
        return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'gu'); // só palavra inteira
    }

    // Procura as palavras-chave e troca pelo marcador.
    function applyKeywords(text, keywords, counts) {
        for (const { re, label, type } of keywords) {        // para cada palavra-chave
            let out = '';                                     // texto sendo montado
            let last = 0;                                     // até onde já copiamos
            for (const m of fold(text).matchAll(re)) {        // procura no texto sem acentos
                out += text.slice(last, m.index) + label;     // copia o que vem antes + marcador
                last = m.index + m[0].length;                 // pula a palavra encontrada
                counts[type] = (counts[type] ?? 0) + 1;       // conta
            }
            text = out + text.slice(last);                    // copia o resto
        }
        return text;
    }

    // ---------- Documentos numéricos em qualquer formato ----------

    const NUM_WORDS = { zero: '0', um: '1', uma: '1', dois: '2', duas: '2', tres: '3', quatro: '4', cinco: '5', seis: '6', meia: '6', sete: '7', oito: '8', nove: '9' }; // números por extenso
    const TOKEN = /\p{Nd}+|(?<![\p{L}\p{N}])(?:zero|uma?|dois|duas|tr[eê]s|quatro|cinco|seis|meia|sete|oito|nove)(?![\p{L}\p{N}])/giu; // um bloco: dígitos ou número por extenso
    const GAP = /^(?:[^\p{L}\p{N}]|(?<!\p{L})(?:e|ponto|tra[cç]o|barra|h[ií]fen|espa[cç]o)(?!\p{L}))*$/iu; // o que pode haver entre blocos: símbolos, espaços ou "e", "ponto"...
    const MAX_GAP = 40;    // separador maior que isso quebra a sequência
    const MAX_DIGITS = 19; // maior documento (cartão) tem 19 dígitos

    // Converte um bloco em dígitos: "１３６" → "136", "três" → "3".
    function tokenDigits(t) {
        if (/^\p{Nd}+$/u.test(t)) return t.normalize('NFKC').replace(/\D/g, ''); // dígitos (inclusive de outros alfabetos)
        return NUM_WORDS[fold(t)] ?? '';                                          // número por extenso
    }

    // Separa o texto em sequências de blocos vizinhos. Ex.: "136 /// 543 e 41" → [136, 543, 41]
    function numericRuns(text) {
        const runs = [];  // todas as sequências
        let cur = null;   // sequência atual
        for (const m of text.matchAll(TOKEN)) {                          // para cada bloco no texto
            const g = { start: m.index, end: m.index + m[0].length, digits: tokenDigits(m[0]) }; // posição e dígitos
            if (!g.digits) {                                             // bloco sem dígito válido
                cur = null;
                continue;
            }
            const gap = cur && text.slice(cur.at(-1).end, g.start);      // o que há entre o bloco anterior e este
            if (cur && gap.length <= MAX_GAP && GAP.test(gap)) cur.push(g); // só separador: continua a sequência
            else runs.push((cur = [g]));                                 // senão: começa uma nova
        }
        return runs;
    }

    // Procura documentos dentro das sequências de blocos e troca pelo marcador.
    function applyNumeric(text, types, counts) {
        const numeric = NUMERIC.filter((n) => types(n.type)); // só os tipos ativos na política
        if (!numeric.length) return text;                     // nenhum ativo: nada a fazer

        let out = '';  // texto sendo montado
        let last = 0;  // até onde já copiamos
        for (const groups of numericRuns(text)) {             // para cada sequência de blocos
            let i = 0;                                        // bloco inicial
            while (i < groups.length) {
                const windows = [];                           // combinações de blocos a testar
                let digits = '';
                const lens = [];                              // tamanho de cada bloco
                for (let j = i; j < groups.length; j++) {     // junta blocos a partir de i
                    digits += groups[j].digits;
                    if (digits.length > MAX_DIGITS) break;    // passou de 19 dígitos: para
                    lens.push(groups[j].digits.length);
                    windows.unshift({ j, digits, lens: [...lens] }); // guarda (mais longa primeiro)
                }

                const before = text.slice(Math.max(0, groups[i].start - 25), groups[i].start); // 25 caracteres antes do número
                const around = (w) => `${before} ${text.slice(groups[w.j].end, groups[w.j].end + 25)}`; // + 25 depois (para "CNH", "PIS", "RG")
                let found = null;
                for (const n of numeric) {                                             // para cada tipo, em ordem de prioridade
                    const w = windows.find(
                        (w) =>
                            (!n.context || n.context.test(around(w))) &&               // exige a palavra perto (antes ou depois)
                            (!n.shape || n.shape(w.lens)) &&                           // formato dos blocos aceito
                            n.valid(w.digits),                                         // dígitos válidos
                    );
                    if (w) {
                        found = { ...n, j: w.j };                                      // achou: guarda tipo e último bloco
                        break;
                    }
                }

                if (!found) {
                    i++;       // nada começa neste bloco: tenta a partir do próximo
                    continue;
                }
                let start = groups[i].start;                                   // início do documento no texto
                if (start > last && '(+'.includes(text[start - 1])) start--;   // inclui "(" ou "+" colado antes
                out += text.slice(last, start) + found.label;                 // copia o que vem antes + marcador
                last = groups[found.j].end;                                    // pula o documento (com os separadores)
                if (found.type === 'rg') {                                     // RG pode terminar em "X" (ex.: 12345678-X)
                    const x = /^[-.\s]?[xX](?!\p{L})/u.exec(text.slice(last));
                    if (x) last += x[0].length;                                // inclui o "-X" no trecho mascarado
                }
                counts[found.type] = (counts[found.type] ?? 0) + 1;            // conta
                i = found.j + 1;                                               // continua depois dele
            }
        }
        return out + text.slice(last); // copia o resto
    }

    // ---------- Ponto de entrada ----------

    // Cria um detector com as regras da política (types, keywords, patterns).
    function createScanner(cfg = {}) {
        const types = (t) => !Array.isArray(cfg.types) || cfg.types.includes(t); // tipo está ativo? (sem lista = todos)

        const builtin = BUILTIN.filter((d) => types(d.type));                   // padrões de texto ativos

        const patterns = (cfg.patterns ?? []).flatMap((p) => {                  // padrões da empresa
            try {
                const flags = [...new Set(`${p.flags ?? 'i'}g`)].join('');     // garante a flag "g" (achar todos)
                return [{ type: p.name ?? 'custom', label: p.label ?? '[BLOCKED]', re: new RegExp(p.regex, flags) }];
            } catch {
                return [];                                                      // regex com erro: ignora
            }
        });

        const keywords = (cfg.keywords ?? [])                                   // palavras-chave da empresa
            .map((k) => (typeof k === 'string' ? { term: k } : k))              // aceita texto ou objeto
            .filter((k) => k.term?.trim())                                      // ignora vazias
            .map((k) => ({ re: keywordRegex(fold(k.term.trim())), label: k.label ?? '[CONFIDENTIAL]', type: 'keyword' }));

        return {
            scan(text) {
                const counts = {};                                      // contagem por tipo
                let masked = applyRegex(text, builtin, counts);         // 1. senhas, tokens, e-mail, RG
                masked = applyRegex(masked, patterns, counts);          // 2. padrões da empresa
                masked = applyKeywords(masked, keywords, counts);       // 3. palavras-chave
                masked = applyNumeric(masked, types, counts);           // 4. CPF, CNPJ, cartão, telefone...
                const total = Object.values(counts).reduce((a, b) => a + b, 0); // soma de tudo
                return { masked, counts, total };
            },
        };
    }

    globalThis.PII = { createScanner, scan: (text, cfg) => createScanner(cfg).scan(text) }; // disponibiliza para o content.js

    // Também funciona fora do Chrome (Node.js ou outro programa): const PII = require('./pii.js')
    if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.PII;
})();
