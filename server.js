const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const dbPath = path.join(dataDir, "tickets.json");
const outboxPath = path.join(dataDir, "email-outbox.log");

loadEnv(path.join(rootDir, ".env"));

const config = {
  port: Number(process.env.PORT || 3333),
  appName: process.env.APP_NAME || "ServiceDesk TI",
  adminEmail: process.env.ADMIN_EMAIL || "ti@suaempresa.com",
  emailMode: (process.env.EMAIL_MODE || "log").toLowerCase(),
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "servicedesk@localhost"
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
        emailMode: config.emailMode
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
      await notifyNewTicket(ticket);
      return sendJson(res, 201, ticket);
    }

    const updateMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)$/);
    if (updateMatch && req.method === "PATCH") {
      const payload = await readJsonBody(req);
      const db = readDb();
      const ticket = db.tickets.find((item) => item.id === updateMatch[1]);
      if (!ticket) return sendJson(res, 404, { error: "Chamado nao encontrado." });

      const events = updateTicket(ticket, payload);
      writeDb(db);
      await notifyTicketEvents(ticket, events);
      return sendJson(res, 200, ticket);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
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
  const id = nextTicketId();
  return {
    id,
    requesterName: clean(payload.requesterName),
    requesterEmail: clean(payload.requesterEmail),
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
  if (typeof payload.assignee === "string") ticket.assignee = clean(payload.assignee);
  if (typeof payload.adminNotes === "string") ticket.adminNotes = clean(payload.adminNotes);
  ticket.updatedAt = new Date().toISOString();

  const changes = [];
  const events = [];
  if (before.status !== ticket.status) changes.push(`Status: ${before.status} -> ${ticket.status}`);
  if (before.assignee !== ticket.assignee) {
    changes.push(`Responsavel atualizado.`);
    if (ticket.assignee) events.push("assigned");
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
    const line = `[${new Date().toISOString()}] Para: ${message.to}\nAssunto: ${message.subject}\n${message.text}\n---\n`;
    fs.appendFileSync(outboxPath, line, "utf8");
    console.log(`E-mail simulado registrado para ${message.to}: ${message.subject}`);
    return;
  }

  await sendSmtpMail(message);
}

function sendSmtpMail(message) {
  return new Promise((resolve, reject) => {
    if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) {
      reject(new Error("Configure SMTP_HOST, SMTP_USER e SMTP_PASS para envio real."));
      return;
    }

    const script = `
$secure = ConvertTo-SecureString $env:SMTP_PASS -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential($env:SMTP_USER, $secure)
$params = @{
  SmtpServer = $env:SMTP_HOST
  Port = [int]$env:SMTP_PORT
  From = $env:SMTP_FROM
  To = $env:SMTP_TO
  Subject = $env:SMTP_SUBJECT
  Body = $env:SMTP_BODY
  Credential = $credential
}
if ($env:SMTP_SECURE -eq 'true' -or $env:SMTP_PORT -eq '587') { $params.UseSsl = $true }
Send-MailMessage @params
`;

    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      env: {
        ...process.env,
        SMTP_HOST: config.smtp.host,
        SMTP_PORT: String(config.smtp.port),
        SMTP_SECURE: String(config.smtp.secure),
        SMTP_USER: config.smtp.user,
        SMTP_PASS: config.smtp.pass,
        SMTP_FROM: config.smtp.from,
        SMTP_TO: message.to,
        SMTP_SUBJECT: message.subject,
        SMTP_BODY: message.text
      }
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `Falha ao enviar e-mail SMTP. Codigo ${code}.`));
    });
  });
}
