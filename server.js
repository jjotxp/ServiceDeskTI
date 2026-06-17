const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const nodemailer = require("nodemailer");

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, "data");
const dbPath = path.join(dataDir, "tickets.json");
const outboxPath = path.join(dataDir, "email-outbox.log");

loadEnv(path.join(rootDir, ".env"));

const config = {
  port: Number(process.env.PORT || 3333),
  appName: process.env.APP_NAME || "ServiceDesk TI",
  adminEmail: process.env.ADMIN_EMAIL || "ti@suaempresa.com",
  emailMode: (process.env.EMAIL_MODE || "log").toLowerCase(),
  allowedRequesterEmails: parseEmailList(process.env.ALLOWED_REQUESTER_EMAILS || ""),
  allowedRequesterDomains: parseDomainList(process.env.ALLOWED_REQUESTER_DOMAINS || ""),
  supportAgents: parseList(process.env.SUPPORT_AGENTS || "João Pedro da Silva"),
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "servicedesk@localhost",
    timeoutMs: Number(process.env.SMTP_TIMEOUT_MS || 15000),
    maxAttempts: Number(process.env.SMTP_MAX_ATTEMPTS || 3)
  },
  graph: {
    tenantId: process.env.GRAPH_TENANT_ID || "",
    clientId: process.env.GRAPH_CLIENT_ID || "",
    clientSecret: process.env.GRAPH_CLIENT_SECRET || "",
    sender: process.env.GRAPH_SENDER || process.env.SMTP_USER || process.env.ADMIN_EMAIL || "",
    saveToSentItems: String(process.env.GRAPH_SAVE_TO_SENT_ITEMS || "true").toLowerCase() === "true",
    timeoutMs: Number(process.env.GRAPH_TIMEOUT_MS || 15000)
  }
};

ensureStore();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/config" && req.method === "GET") {
      return sendJson(res, 200, {
        appName: config.appName,
        adminEmail: config.adminEmail,
        emailMode: config.emailMode,
        restrictedAccess: config.allowedRequesterEmails.length > 0 || config.allowedRequesterDomains.length > 0,
        supportAgents: config.supportAgents
      });
    }

    if (url.pathname === "/api/tickets" && req.method === "GET") {
      const db = readDb();
      return sendJson(res, 200, db.tickets.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }

    if (url.pathname === "/api/tickets" && req.method === "POST") {
      const payload = await readJsonBody(req);
      const ticket = createTicket(payload);
      const db = readDb();
      db.tickets.push(ticket);
      writeDb(db);
      try {
        await notifyNewTicket(ticket);
      } catch (error) {
        db.tickets = db.tickets.filter((item) => item.id !== ticket.id);
        writeDb(db);
        throw mailError(error);
      }
      return sendJson(res, 201, ticket);
    }

    const updateMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)$/);
    if (updateMatch && req.method === "PATCH") {
      const payload = await readJsonBody(req);
      const db = readDb();
      const ticket = db.tickets.find((item) => item.id === updateMatch[1]);
      if (!ticket) return sendJson(res, 404, { error: "Chamado nao encontrado." });

      const beforeTicket = JSON.parse(JSON.stringify(ticket));
      const events = updateTicket(ticket, payload);
      writeDb(db);
      try {
        await notifyTicketEvents(ticket, events);
      } catch (error) {
        Object.assign(ticket, beforeTicket);
        writeDb(db);
        throw mailError(error);
      }
      return sendJson(res, 200, ticket);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    if (!error.status || error.status >= 500) {
      console.error(error);
    } else {
      console.warn(error.message);
    }
    return sendJson(res, error.status || 500, { error: error.status ? error.message : "Erro interno no servidor." });
  }
});

server.listen(config.port, () => {
  console.log(`${config.appName} rodando em http://localhost:${config.port}`);
  console.log(`Modo de e-mail: ${config.emailMode}`);
});

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function ensureStore() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    writeDb({ tickets: [] });
  }
}

function readDb() {
  return JSON.parse(fs.readFileSync(dbPath, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function createTicket(payload) {
  const required = ["requesterName", "requesterEmail", "department", "category", "priority", "title", "description"];
  for (const field of required) {
    if (!String(payload[field] || "").trim()) {
      const error = new Error(`Campo obrigatorio ausente: ${field}`);
      error.status = 400;
      throw error;
    }
  }

  const now = new Date().toISOString();
  const requesterEmail = clean(payload.requesterEmail).toLowerCase();
  if (!isRequesterAllowed(requesterEmail)) {
    const error = new Error("Este e-mail nao esta autorizado a abrir chamados. Use seu e-mail corporativo.");
    error.status = 403;
    throw error;
  }

  const id = nextTicketId();
  return {
    id,
    requesterName: clean(payload.requesterName),
    requesterEmail,
    department: clean(payload.department),
    category: clean(payload.category),
    priority: clean(payload.priority),
    title: clean(payload.title),
    description: clean(payload.description),
    status: "Aberto",
    assignee: "",
    adminNotes: "",
    createdAt: now,
    updatedAt: now,
    history: [
      {
        at: now,
        event: "Chamado aberto",
        detail: "Solicitacao registrada pelo colaborador."
      }
    ]
  };
}

function updateTicket(ticket, payload) {
  const before = { status: ticket.status, assignee: ticket.assignee, adminNotes: ticket.adminNotes };
  const allowedStatuses = ["Aberto", "Em atendimento", "Aguardando usuario", "Resolvido", "Cancelado"];
  if (payload.status && allowedStatuses.includes(payload.status)) ticket.status = payload.status;
  if (typeof payload.assignee === "string") {
    ticket.assignee = clean(payload.assignee);
  }
  if (typeof payload.adminNotes === "string") ticket.adminNotes = clean(payload.adminNotes);
  ticket.updatedAt = new Date().toISOString();

  const changes = [];
  const events = [];
  if (before.status !== ticket.status) changes.push(`Status: ${before.status} -> ${ticket.status}`);
  if (before.assignee !== ticket.assignee) {
    changes.push(`Responsavel atualizado.`);
    if (ticket.assignee && ticket.status !== "Resolvido") events.push("assigned");
  }
  if (before.adminNotes !== ticket.adminNotes) changes.push(`Observacao atualizada.`);
  if (before.status !== "Resolvido" && ticket.status === "Resolvido") events.push("resolved");

  if (changes.length) {
    ticket.history.push({
      at: ticket.updatedAt,
      event: "Chamado atualizado",
      detail: changes.join(" ")
    });
  }

  return events;
}

function nextTicketId() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomInt(1000, 9999);
  return `SD-${stamp}-${random}`;
}

function clean(value) {
  return String(value || "").trim().slice(0, 5000);
}

function parseEmailList(value) {
  return parseList(value).map((email) => email.toLowerCase());
}

function parseDomainList(value) {
  return parseList(value).map((domain) => domain.replace(/^@/, "").toLowerCase());
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isRequesterAllowed(email) {
  if (!config.allowedRequesterEmails.length && !config.allowedRequesterDomains.length) return true;
  if (config.allowedRequesterEmails.includes(email)) return true;
  const domain = email.split("@")[1] || "";
  return config.allowedRequesterDomains.includes(domain);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("JSON invalido.");
    error.status = 400;
    throw error;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(urlPath, res) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const safePath = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Nao encontrado.");
  }
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

async function notifyNewTicket(ticket) {
  const subject = `[${config.appName}] Novo chamado ${ticket.id} - ${ticket.priority}`;
  const text = [
    `Novo chamado aberto: ${ticket.id}`,
    "",
    `Solicitante: ${ticket.requesterName} <${ticket.requesterEmail}>`,
    `Setor: ${ticket.department}`,
    `Categoria: ${ticket.category}`,
    `Prioridade: ${ticket.priority}`,
    `Titulo: ${ticket.title}`,
    "",
    ticket.description
  ].join("\n");

  await sendMail({
    to: config.adminEmail,
    from: config.smtp.from,
    subject,
    text
  });
}

function normalizeMailError(error) {
  const text = String(error && error.message ? error.message : error || "erro desconhecido").trim();
  if (text.includes("535") || text.toLowerCase().includes("authentication")) {
    return "E-mail nao enviado: falha de autenticacao SMTP. Confira usuario, senha e SMTP AUTH.";
  }
  if (text.includes("5.7") || text.toLowerCase().includes("smtp auth")) {
    return "E-mail nao enviado: SMTP AUTH pode estar bloqueado para essa caixa.";
  }
  if (text.toLowerCase().includes("timeout") || text.toLowerCase().includes("timed out")) {
    return "E-mail nao enviado: o servidor SMTP demorou demais para responder.";
  }
  return `E-mail nao enviado: ${text.slice(0, 300)}`;
}

function mailError(error) {
  const detail = normalizeMailError(error);
  console.error(`Falha ao enviar notificacao: ${detail}`);
  const wrapped = new Error(detail);
  wrapped.status = 502;
  return wrapped;
}

async function notifyTicketEvents(ticket, events) {
  for (const event of events) {
    if (event === "assigned") {
      await sendMail({
        to: ticket.requesterEmail,
        from: config.smtp.from,
        subject: `[${config.appName}] Chamado ${ticket.id} atribuido`,
        text: [
          `Ola, ${ticket.requesterName}.`,
          "",
          `Seu chamado ${ticket.id} foi atribuido para atendimento.`,
          "",
          `Responsavel: ${ticket.assignee}`,
          `Titulo: ${ticket.title}`,
          `Status atual: ${ticket.status}`,
          "",
          ticket.adminNotes ? `Observacao da TI:\n${ticket.adminNotes}` : "A equipe de TI seguira com o atendimento."
        ].join("\n")
      });
    }

    if (event === "resolved") {
      await sendMail({
        to: ticket.requesterEmail,
        from: config.smtp.from,
        subject: `[${config.appName}] Chamado ${ticket.id} resolvido`,
        text: [
          `Ola, ${ticket.requesterName}.`,
          "",
          `Seu chamado ${ticket.id} foi marcado como resolvido.`,
          "",
          `Titulo: ${ticket.title}`,
          `Responsavel: ${ticket.assignee || "TI"}`,
          "",
          ticket.adminNotes ? `Observacao da TI:\n${ticket.adminNotes}` : "Caso o problema continue, responda ao time de TI ou abra um novo chamado."
        ].join("\n")
      });
    }
  }
}

async function sendMail(message) {
  if (config.emailMode !== "smtp") {
    if (config.emailMode === "graph") {
      await sendGraphMail(message);
      return;
    }

    const line = `[${new Date().toISOString()}] Para: ${message.to}\nAssunto: ${message.subject}\n${message.text}\n---\n`;
    fs.appendFileSync(outboxPath, line, "utf8");
    console.log(`E-mail simulado registrado para ${message.to}: ${message.subject}`);
    return;
  }

  await sendSmtpMail(message);
}

async function sendSmtpMail(message) {
  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) {
    return Promise.reject(new Error("Configure SMTP_HOST, SMTP_USER e SMTP_PASS para envio real."));
  }

  const smtpAddresses = await resolveSmtpHosts(config.smtp.host);
  const attempts = smtpAddresses.slice(0, Math.max(1, config.smtp.maxAttempts));
  let lastError;

  for (const smtpAddress of attempts) {
    try {
      console.log(`Tentando SMTP ${config.smtp.host}:${config.smtp.port} via ${smtpAddress}`);
      const transporter = nodemailer.createTransport({
        host: smtpAddress,
        port: config.smtp.port,
        secure: config.smtp.secure,
        requireTLS: config.smtp.port === 587,
        connectionTimeout: config.smtp.timeoutMs,
        greetingTimeout: config.smtp.timeoutMs,
        socketTimeout: config.smtp.timeoutMs,
        tls: {
          servername: config.smtp.host
        },
        auth: {
          user: config.smtp.user,
          pass: config.smtp.pass
        }
      });

      return await transporter.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text
      });
    } catch (error) {
      lastError = error;
      console.warn(`Falha SMTP via ${smtpAddress}: ${error.message}`);
    }
  }

  throw lastError || new Error("Nenhum endereco SMTP IPv4 disponivel.");
}

async function resolveSmtpHosts(host) {
  const records = await dns.resolve4(host);
  if (records.length) return records;
  const fallback = await dns.lookup(host, { family: 4 });
  return [fallback.address];
}

async function sendGraphMail(message) {
  if (!config.graph.tenantId || !config.graph.clientId || !config.graph.clientSecret || !config.graph.sender) {
    throw new Error("Configure GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET e GRAPH_SENDER para envio via Microsoft Graph.");
  }

  const token = await getGraphToken();
  const endpoint = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.graph.sender)}/sendMail`;
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: {
        subject: message.subject,
        body: {
          contentType: "Text",
          content: message.text
        },
        toRecipients: [
          {
            emailAddress: {
              address: message.to
            }
          }
        ]
      },
      saveToSentItems: config.graph.saveToSentItems
    })
  }, config.graph.timeoutMs);

  if (response.status !== 202) {
    const detail = await response.text();
    throw new Error(`Microsoft Graph sendMail falhou (${response.status}): ${detail.slice(0, 500)}`);
  }
}

async function getGraphToken() {
  const tokenEndpoint = `https://login.microsoftonline.com/${encodeURIComponent(config.graph.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: config.graph.clientId,
    client_secret: config.graph.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });

  const response = await fetchWithTimeout(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  }, config.graph.timeoutMs);

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(`Falha ao obter token Graph (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`);
  }

  return payload.access_token;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Timeout ao acessar ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
