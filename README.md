# IA Extension

A IA Extension é uma extensão para o Google Chrome que controla como os funcionários de uma empresa usam sites de IA generativa: ChatGPT, Gemini, Copilot, Claude, Perplexity, DeepSeek, Mistral, Grok, Meta AI, Poe e Character.AI. Ela segue uma política definida pela empresa.

## O que ela faz

### 1. Controle de acesso aos sites de IA
Para cada site da lista, a política define uma de três ações:

- **monitorar:** o acesso é permitido, mas fica registrado;
- **bloquear:** aparece a página "Acesso bloqueado";
- **redirecionar:** o usuário vai para uma página da empresa, como a política de uso de IA.

O bloqueio é feito pelo próprio Chrome, antes de o site carregar. Cada acesso gera um registro com usuário, site, horário e ação aplicada. Opcionalmente, a extensão tira um print da tela ao entrar no site.

### 2. Proteção de dados sensíveis
Dentro dos sites de IA, a extensão verifica o texto em dois momentos: quando o usuário cola algo (Ctrl+V) e quando tenta enviar (Enter ou botão Enviar). Ela reconhece:

- **documentos brasileiros:** CPF, CNPJ, RG, CNH, PIS e título de eleitor. Confere os dígitos verificadores, então números inventados não disparam;
- **outros dados:** e-mail, telefone e cartão de crédito (pela validação de Luhn);
- **segredos:** senhas, tokens de API e chaves privadas;
- **itens da empresa:** palavras proibidas, como "confidencial" ou nomes de projetos, e padrões próprios, como número de processo judicial.

A detecção também pega dados disfarçados: números escritos por extenso ("três"), separados por símbolos ou com letras espaçadas.

Ao encontrar um dado sensível, a extensão faz o que a política mandar:

- **bloquear (padrão):** cancela a colagem ou o envio e mostra um aviso azul;
- **mascarar:** troca o dado por um marcador, como `[CPF]` ou `[EMAIL]`, e pede para o usuário revisar e enviar de novo.

### 3. Pedido de autorização
No aviso de bloqueio, o usuário pode escrever uma justificativa (mínimo de 10 caracteres) e clicar em "Solicitar autorização". O pedido vai para a equipe de Segurança da Informação e fica registrado no mesmo incidente do bloqueio, com status "pendente".

Para aprovar, a equipe adiciona uma exceção na política (`pii.exceptions`): quais usuários ou grupos, quais tipos de dado e até que data. A liberação vale na próxima sincronização e acaba sozinha quando a data vence.

### 4. Registro de incidentes (auditoria)
Cada bloqueio ou mascaramento gera um incidente com:

- data e hora;
- e-mail da conta Google do Chrome;
- site e página;
- se foi colagem ou envio;
- tipos de dado encontrados;
- texto original, texto mascarado e print da tela;
- justificativa, quando houver.

O texto original e o print vão direto para o servidor e nunca ficam gravados no computador do funcionário. Se o servidor estiver fora do ar, esses dois campos são descartados e só os metadados ficam na fila, sendo reenviados a cada minuto.

### 5. Política central por departamento
A extensão baixa a política do servidor a cada 15 minutos. Cada grupo pode ter regras diferentes: por exemplo, o Jurídico (`server/policies/juridico.json`) tem tudo bloqueado, menos o Copilot.

A TI pode configurar o endereço do servidor, a chave e o grupo remotamente (GPO ou Google Admin Console, campos em `managed_schema.json`), e aí o usuário não consegue alterar.

Sem servidor, vale a política padrão embutida (`default-policy.json`): sites liberados, mas todo dado sensível bloqueado. Se o servidor cair, a extensão mantém a última política recebida, sem afrouxar as regras.

### 6. Popup
Ao clicar no ícone da extensão aparecem:

- se a aba atual é um site de IA e qual ação vale para ela;
- versão da política, grupo, número de sites e modo de proteção;
- última sincronização e eventos aguardando envio;
- o botão "Sincronizar agora" e um formulário de configuração, que só aparece quando não há configuração da empresa.

### 7. Servidor de testes (`server/server.js`)
É um servidor Node simples, só para desenvolvimento. Ele entrega as políticas e grava os eventos em `server/data/`:

- um JSON por incidente em `incidents/`;
- `incidents.json` com todos os incidentes;
- os prints em `screenshots/`;
- o histórico completo em `events.jsonl`.

## Como rodar

1. Inicie o servidor de testes (precisa do Node.js):
   ```bash
   node server/server.js
   ```
   Ele fica em `http://localhost:8787`, com a chave `dev-key`.
2. No Chrome, abra `chrome://extensions`, ligue o **Modo do desenvolvedor** e clique em **Carregar sem compactação**, escolhendo esta pasta.
3. Clique no ícone da extensão e preencha a configuração: URL `http://localhost:8787`, chave `dev-key` e grupo `default` (ou `juridico`).
4. Abra um site de IA e cole um texto com um CPF válido para ver o bloqueio.

Depois de alterar o código, recarregue a extensão em `chrome://extensions` e aperte F5 nas abas de IA.

## Estrutura

| Caminho | Função |
| --- | --- |
| `manifest.json` | Identidade e permissões da extensão |
| `src/background.js` | Service worker: aplica a política, registra acessos, tira prints, responde mensagens |
| `src/policy.js` | Configuração e política (download, cache, exceções) |
| `src/events.js` | Fila de eventos e envio ao servidor |
| `content/pii.js` | Detector de dados sensíveis |
| `content/content.js` | Proteção dentro da página: colagem, envio, avisos e pedido de autorização |
| `popup.html` / `popup.js` | Janela do ícone da extensão |
| `blocked.html` / `blocked.js` | Página "Acesso bloqueado" |
| `default-policy.json` | Política usada sem servidor |
| `managed_schema.json` | Campos configuráveis pela empresa |
| `server/` | Servidor de testes e políticas por grupo |

## Limitações atuais

- O servidor é só para testes: chave fixa `dev-key`, sem HTTPS e sem tela para aprovar pedidos (a aprovação é feita editando o JSON da política).
- Arquivos anexados não são verificados, só texto colado ou digitado.
- Funciona só no Chrome. O e-mail do usuário só aparece se houver uma conta Google logada no navegador.
- `server/data/` guarda dados pessoais em texto puro e não deve ir para o repositório (já está no `.gitignore`).
