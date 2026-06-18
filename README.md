# ServiceDesk TI

Aplicativo web interno para abertura e acompanhamento de chamados de TI.

## O que ja esta pronto

- Tela para colaborador abrir chamado.
- Consulta de chamados pelo e-mail do solicitante.
- Painel de TI com busca, filtro por status e indicadores.
- Atualizacao de status, responsavel e observacoes internas.
- Numero automatico de chamado.
- Banco local em `data/tickets.json`.
- Notificacao de novo chamado em modo teste, registrada em `data/email-outbox.log`.
- Aviso automatico ao solicitante quando o chamado e atribuido.
- Aviso automatico ao solicitante quando o chamado e resolvido.

## Como rodar

Abra o PowerShell nesta pasta e execute:

```powershell
node server.js
```

Depois acesse:

```text
http://localhost:3333
```

## Configuracao

As configuracoes ficam no arquivo `.env`:

```env
PORT=3333
APP_NAME=ServiceDesk TI
ADMIN_EMAIL=ti@suaempresa.com
DATA_DIR=./data
ALLOWED_REQUESTER_EMAILS=usuario1@suaempresa.com,usuario2@suaempresa.com
ALLOWED_REQUESTER_DOMAINS=aplicativo.net
SUPPORT_AGENTS=João Pedro da Silva
EMAIL_MODE=log
```

No modo atual, `EMAIL_MODE=log`, o sistema nao envia e-mail real. Ele registra a mensagem no terminal e no arquivo:

```text
data/email-outbox.log
```

Esse modo e ideal para testar o fluxo sem depender ainda de senha SMTP, Microsoft Graph ou aprovacao do tenant.

O sistema registra/enviara e-mails nestes eventos:

- Novo chamado aberto: enviado para `ADMIN_EMAIL`.
- Chamado atribuido: enviado para o e-mail do solicitante.
- Chamado resolvido: enviado para o e-mail do solicitante.

Para limitar quem pode abrir chamados, preencha `ALLOWED_REQUESTER_EMAILS` com os e-mails permitidos separados por virgula. Se essa variavel ficar vazia, qualquer e-mail consegue abrir chamado.

Para limitar por dominio corporativo, use `ALLOWED_REQUESTER_DOMAINS`:

```env
ALLOWED_REQUESTER_DOMAINS=aplicativo.net
```

Com essa configuracao, somente e-mails terminados em `@aplicativo.net` conseguem abrir chamados.

Para configurar os atendentes exibidos no campo `Responsavel`, preencha `SUPPORT_AGENTS` com os nomes separados por virgula.

## Autenticacao com Microsoft Entra ID

Para exigir login corporativo, configure estas variaveis na Railway:

```env
AUTH_MODE=entra
AUTH_TENANT_ID=Directory tenant ID
AUTH_CLIENT_ID=Application client ID
AUTH_CLIENT_SECRET=Client secret value
AUTH_REDIRECT_URI=https://sua-url-da-railway/auth/callback
AUTH_ALLOWED_TENANT_IDS=Directory tenant ID
AUTH_SESSION_IDLE_SECONDS=180
AUTH_PROMPT=login
ADMIN_USERS=joao.silva@aplicativo.net
SUPPORT_USERS=joao.silva@aplicativo.net
```

No Entra ID, use a App Registration do ServiceDesk e adicione uma plataforma `Web` com Redirect URI:

```text
https://sua-url-da-railway/auth/callback
```

Com `AUTH_MODE=entra`, o app passa a:

- exigir login Microsoft antes de abrir chamados;
- usar automaticamente o nome e e-mail da conta logada;
- permitir que usuarios comuns vejam apenas os proprios chamados;
- permitir acesso ao `Painel TI` apenas para e-mails em `SUPPORT_USERS` ou `ADMIN_USERS`.

Por seguranca, usuarios comuns so entram se o e-mail estiver em `ALLOWED_REQUESTER_EMAILS` ou se o dominio estiver em `ALLOWED_REQUESTER_DOMAINS`. Usuarios de TI/admin entram se estiverem em `SUPPORT_USERS` ou `ADMIN_USERS`. O token tambem precisa vir de um tenant listado em `AUTH_ALLOWED_TENANT_IDS` ou do proprio `AUTH_TENANT_ID`.

`AUTH_SESSION_IDLE_SECONDS=180` expira a sessao do ServiceDesk apos 3 minutos sem atividade. `AUTH_PROMPT=login` forca a Microsoft a pedir autenticacao novamente no fluxo de login. Para exigir 2FA via Microsoft Authenticator, configure MFA/Conditional Access no Entra ID para esta App Registration; o ServiceDesk nao substitui a politica de MFA do tenant.

Opcionalmente, voce pode usar grupos do Entra para permissao do Painel TI. Para isso, configure o app registration para emitir grupos no token e preencha:

```env
ENTRA_SUPPORT_GROUP_IDS=id-do-grupo-atendentes
ENTRA_ADMIN_GROUP_IDS=id-do-grupo-admins
```

Se grupos nao forem configurados no token, use `SUPPORT_USERS` e `ADMIN_USERS` por e-mail.

## Envio real de e-mail

Quando voce tiver os dados do provedor, altere o `.env` para `EMAIL_MODE=smtp` e complete:

```env
ADMIN_EMAIL=seu.email@empresa.com
EMAIL_MODE=smtp
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=usuario@suaempresa.com
SMTP_PASS=sua-senha-ou-app-password
SMTP_FROM="ServiceDesk TI <usuario@suaempresa.com>"
SMTP_TIMEOUT_MS=15000
SMTP_MAX_ATTEMPTS=3
```

Em Microsoft 365, o SMTP autenticado pode estar bloqueado por politica do tenant ou indisponivel a partir da hospedagem. Nesse caso, use Microsoft Graph com uma App Registration aprovada pelo administrador.

O envio SMTP usa a dependencia `nodemailer`, instalada automaticamente pela Railway durante o deploy.

### Envio por Microsoft Graph

Para Railway com Microsoft 365, prefira:

```env
EMAIL_MODE=graph
GRAPH_TENANT_ID=seu-tenant-id
GRAPH_CLIENT_ID=seu-client-id
GRAPH_CLIENT_SECRET=seu-client-secret
GRAPH_SENDER=joao.silva@aplicativo.net
GRAPH_SAVE_TO_SENT_ITEMS=true
GRAPH_TIMEOUT_MS=15000
```

A App Registration precisa da permissao de aplicativo `Mail.Send` no Microsoft Graph e consentimento de administrador. O endpoint usado e `POST /users/{id | userPrincipalName}/sendMail`.

## Monitoramento de ativos na rede

O ServiceDeskTI pode receber resultados de um agente local executado dentro da rede da empresa. O app no Railway funciona como painel central; o agente PowerShell faz as checagens internas e envia os resultados por HTTPS.

Configure no Railway:

```env
MONITOR_AGENT_TOKEN=um-token-longo-e-aleatorio
```

Depois acesse o app com um usuario cadastrado em `ADMIN_USERS`, abra a aba `Gestao de ativos` e cadastre os ativos com nome e IP. Usuarios que estao apenas em `SUPPORT_USERS` continuam acessando o Painel TI, mas nao acessam a gestao de ativos.

Na maquina interna que vai executar o agente, abra o PowerShell na pasta do projeto e configure:

```powershell
$env:SERVICEDESK_URL="https://seu-app.up.railway.app"
$env:MONITOR_AGENT_TOKEN="o-mesmo-token-configurado-no-railway"
.\agent\monitor.ps1
```

O agente busca os ativos em `/api/monitor/assets`, testa conectividade por ping e envia resultados para `/api/monitor/results`. Quando o ativo cadastrado for a propria maquina onde o agente roda, ele tambem envia sistema operacional e uma lista basica de softwares instalados.

## Railway

Para publicar na Railway:

1. Crie um novo projeto na Railway a partir do repositorio GitHub.
2. Selecione o repositorio `jjotxp/ServiceDeskTI`.
3. Em `Variables`, configure:

```env
APP_NAME=ServiceDesk TI
ADMIN_EMAIL=seu.email@empresa.com
ALLOWED_REQUESTER_EMAILS=usuario1@empresa.com,usuario2@empresa.com
ALLOWED_REQUESTER_DOMAINS=aplicativo.net
SUPPORT_AGENTS=João Pedro da Silva
AUTH_MODE=entra
AUTH_TENANT_ID=seu-tenant-id
AUTH_CLIENT_ID=seu-client-id
AUTH_CLIENT_SECRET=seu-client-secret
AUTH_REDIRECT_URI=https://seu-app.up.railway.app/auth/callback
AUTH_ALLOWED_TENANT_IDS=seu-tenant-id
AUTH_SESSION_IDLE_SECONDS=180
AUTH_PROMPT=login
ADMIN_USERS=joao.silva@aplicativo.net
SUPPORT_USERS=joao.silva@aplicativo.net
MONITOR_AGENT_TOKEN=um-token-longo-e-aleatorio
EMAIL_MODE=smtp
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=usuario@suaempresa.com
SMTP_PASS=sua-senha-ou-app-password
SMTP_FROM=ServiceDesk TI <usuario@suaempresa.com>
SMTP_TIMEOUT_MS=15000
SMTP_MAX_ATTEMPTS=3
```

Se SMTP continuar com timeout na Railway, use Microsoft Graph:

```env
EMAIL_MODE=graph
GRAPH_TENANT_ID=seu-tenant-id
GRAPH_CLIENT_ID=seu-client-id
GRAPH_CLIENT_SECRET=seu-client-secret
GRAPH_SENDER=usuario@suaempresa.com
GRAPH_SAVE_TO_SENT_ITEMS=true
GRAPH_TIMEOUT_MS=15000
```

Nao configure `PORT` na Railway. A propria Railway injeta essa variavel e o app ja usa o valor automaticamente.

Para manter os chamados apos redeploy, crie um volume na Railway e monte em um caminho como `/data`. Depois adicione:

```env
DATA_DIR=/data
```

Sem volume persistente, os chamados podem ser perdidos quando a Railway recriar o container.

## Escopo do MVP

### Colaborador

- Abre chamado com nome, e-mail, setor, categoria, prioridade, titulo e descricao.
- Consulta seus chamados usando o e-mail informado.

### TI

- Visualiza todos os chamados.
- Filtra por status.
- Busca por numero, solicitante, setor, categoria ou titulo.
- Atualiza status, responsavel e observacoes.

### Status

- Aberto
- Em atendimento
- Aguardando usuario
- Resolvido
- Cancelado

## Proximas etapas recomendadas

1. Ativar envio real de e-mail, preferencialmente via Microsoft Graph ou SMTP corporativo.
2. Adicionar login de administrador.
3. Adicionar anexos nos chamados.
4. Trocar banco JSON por SQLite, PostgreSQL ou SQL Server.
5. Publicar em um servidor interno ou Azure App Service.
6. Integrar login com Microsoft Entra ID.
