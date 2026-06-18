const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const msal = require("@azure/msal-node");
const nodemailer = require("nodemailer");

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, "data");
const dbPath = path.join(dataDir, "tickets.json");
const outboxPath = path.join(dataDir, "email-outbox.log");
const sessions = new Map();

loadEnv(path.join(rootDir, ".env"));

const config = {
  port: Number(process.env.PORT || 3333),
  appName: process.env.APP_NAME || "ServiceDesk TI",
  adminEmail: process.env.ADMIN_EMAIL || "ti@suaempresa.com",
  emailMode: (process.env.EMAIL_MODE || "log").toLowerCase(),
  monitorAgentToken: process.env.MONITOR_AGENT_TOKEN || "",
  allowedRequesterEmails: parseEmailList(process.env.ALLOWED_REQUESTER_EMAILS || ""),
  allowedRequesterDomains: parseDomainList(process.env.ALLOWED_REQUESTER_DOMAINS || ""),
  auth: {
    mode: (process.env.AUTH_MODE || "off").toLowerCase(),
    tenantId: process.env.AUTH_TENANT_ID || process.env.GRAPH_TENANT_ID || "",
    clientId: process.env.AUTH_CLIENT_ID || process.env.GRAPH_CLIENT_ID || "",
    clientSecret: process.env.AUTH_CLIENT_SECRET || process.env.GRAPH_CLIENT_SECRET || "",
    redirectUri: process.env.AUTH_REDIRECT_URI || `http://localhost:${Number(process.env.PORT || 3333)}/auth/callback`,
    supportUsers: parseEmailList(process.env.SUPPORT_USERS || process.env.ADMIN_USERS || process.env.ADMIN_EMAIL || ""),
    adminUsers: parseEmailList(process.env.ADMIN_USERS || process.env.ADMIN_EMAIL || ""),
    supportGroupIds: parseList(process.env.ENTRA_SUPPORT_GROUP_IDS || "").map((id) => id.toLowerCase()),
    adminGroupIds: parseList(process.env.ENTRA_ADMIN_GROUP_IDS || "").map((id) => id.toLowerCase())
  },
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
const authEnabled = config.auth.mode === "entra";
const msalClient = authEnabled ? createMsalClient() : null;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/auth/login" && req.method === "GET") {
      return startLogin(req, res);
    }

    if (url.pathname === "/auth/callback" && req.method === "GET") {
      return finishLogin(req, res, url);
    }

    if (url.pathname === "/auth/logout" && req.method === "GET") {
      return logout(req, res);
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
      const user = getCurrentUser(req);
      return sendJson(res, 200, {
        appName: config.appName,
        adminEmail: config.adminEmail,
        emailMode: config.emailMode,
        authEnabled,
        user,
        isSupport: Boolean(user && isSupportUser(user)),
        isAdmin: Boolean(user && isAdminUser(user)),
        restrictedAccess: config.allowedRequesterEmails.length > 0 || config.allowedRequesterDomains.length > 0,
        monitorEnabled: Boolean(config.monitorAgentToken),
        supportAgents: config.supportAgents
      });
    }

    if (url.pathname === "/api/me" && req.method === "GET") {
      const user = getCurrentUser(req);
      if (!user) return sendJson(res, 200, { authenticated: false, loginUrl: "/auth/login" });
      return sendJson(res, 200, {
        authenticated: true,
        user,
        isSupport: isSupportUser(user),
        isAdmin: isAdminUser(user)
      });
    }

    if (url.pathname === "/api/tickets" && req.method === "GET") {
      const user = requireUser(req);
      const db = readDb();
      const tickets = isSupportUser(user)
        ? db.tickets
        : db.tickets.filter((ticket) => ticket.requesterEmail === user.email);
      return sendJson(res, 200, tickets.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }

    if (url.pathname === "/api/assets" && req.method === "GET") {
      requireAdmin(req);
      const db = readDb();
      return sendJson(res, 200, db.assets.sort((a, b) => a.name.localeCompare(b.name)));
    }

    if (url.pathname === "/api/assets" && req.method === "POST") {
      requireAdmin(req);
      const payload = await readJsonBody(req);
      const db = readDb();
      const asset = createAsset(payload);
      db.assets.push(asset);
      writeDb(db);
      return sendJson(res, 201, asset);
    }

    const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (assetMatch && req.method === "PATCH") {
      requireAdmin(req);
      const payload = await readJsonBody(req);
      const db = readDb();
      const asset = db.assets.find((item) => item.id === assetMatch[1]);
      if (!asset) return sendJson(res, 404, { error: "Ativo nao encontrado." });
      updateAsset(asset, payload);
      writeDb(db);
      return sendJson(res, 200, asset);
    }

    if (assetMatch && req.method === "DELETE") {
      requireAdmin(req);
      const db = readDb();
      const beforeCount = db.assets.length;
      db.assets = db.assets.filter((item) => item.id !== assetMatch[1]);
      if (db.assets.length === beforeCount) return sendJson(res, 404, { error: "Ativo nao encontrado." });
      writeDb(db);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/monitor/assets" && req.method === "GET") {
      requireMonitorAgent(req);
      const db = readDb();
      return sendJson(res, 200, db.assets.filter((asset) => asset.enabled !== false));
    }

    if (url.pathname === "/api/monitor/results" && req.method === "POST") {
      requireMonitorAgent(req);
      const payload = await readJsonBody(req);
      const result = saveMonitorResult(payload);
      return sendJson(res, 202, result);
    }

    if (url.pathname === "/api/tickets" && req.method === "POST") {
      const user = requireUser(req);
      const payload = await readJsonBody(req);
      if (authEnabled) {
        payload.requesterName = user.name;
        payload.requesterEmail = user.email;
      }
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
      const user = requireUser(req);
      if (!isSupportUser(user)) {
        const error = new Error("Apenas atendentes podem atualizar chamados.");
        error.status = 403;
        throw error;
      }
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
  console.log(`Autenticacao: ${authEnabled ? "entra" : "desativada"}`);
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

function createMsalClient() {
  if (!config.auth.tenantId || !config.auth.clientId || !config.auth.clientSecret) {
    throw new Error("AUTH_MODE=entra exige AUTH_TENANT_ID, AUTH_CLIENT_ID e AUTH_CLIENT_SECRET.");
  }

  return new msal.ConfidentialClientApplication({
    auth: {
      clientId: config.auth.clientId,
      authority: `https://login.microsoftonline.com/${config.auth.tenantId}`,
      clientSecret: config.auth.clientSecret
    }
  });
}

async function startLogin(req, res) {
  if (!authEnabled) return redirect(res, "/");
  const state = crypto.randomBytes(24).toString("hex");
  const authUrl = await msalClient.getAuthCodeUrl({
    scopes: ["openid", "profile", "email"],
    redirectUri: config.auth.redirectUri,
    state
  });

  res.writeHead(302, {
    Location: authUrl,
    "Set-Cookie": cookieHeader("sd_auth_state", state, req, 600)
  });
  res.end();
}

async function finishLogin(req, res, url) {
  if (!authEnabled) return redirect(res, "/");
  const cookies = parseCookies(req);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  if (!code || !state || state !== cookies.sd_auth_state) {
    return sendText(res, 400, "Falha na autenticacao: estado invalido.");
  }

  const result = await msalClient.acquireTokenByCode({
    code,
    scopes: ["openid", "profile", "email"],
    redirectUri: config.auth.redirectUri
  });
  const user = userFromClaims(result.idTokenClaims || {});
  if (!user.email || !isRequesterAllowed(user.email)) {
    return sendText(res, 403, "Sua conta nao esta autorizada para acessar o ServiceDesk.");
  }

  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionId, {
    user,
    expiresAt: Date.now() + 8 * 60 * 60 * 1000
  });

  res.writeHead(302, {
    Location: "/",
    "Set-Cookie": [
      cookieHeader("sd_session", sessionId, req, 8 * 60 * 60),
      clearCookieHeader("sd_auth_state", req)
    ]
  });
  res.end();
}

function logout(req, res) {
  const cookies = parseCookies(req);
  if (cookies.sd_session) sessions.delete(cookies.sd_session);
  res.writeHead(302, {
    Location: "/",
    "Set-Cookie": clearCookieHeader("sd_session", req)
  });
  res.end();
}

function userFromClaims(claims) {
  const email = String(claims.preferred_username || claims.email || claims.upn || "").toLowerCase();
  return {
    name: String(claims.name || email || "Usuario"),
    email,
    groups: Array.isArray(claims.groups) ? claims.groups.map((group) => String(group).toLowerCase()) : []
  };
}

function getCurrentUser(req) {
  if (!authEnabled) return null;
  const sessionId = parseCookies(req).sd_session;
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session.user;
}

function requireUser(req) {
  if (!authEnabled) return { name: "Modo local", email: "", groups: [] };
  const user = getCurrentUser(req);
  if (!user) {
    const error = new Error("Voce precisa entrar com sua conta corporativa.");
    error.status = 401;
    throw error;
  }
  return user;
}

function requireSupport(req) {
  const user = requireUser(req);
  if (!isSupportUser(user)) {
    const error = new Error("Apenas atendentes podem acessar este recurso.");
    error.status = 403;
    throw error;
  }
  return user;
}

function requireAdmin(req) {
  const user = requireUser(req);
  if (!isAdminUser(user)) {
    const error = new Error("Apenas administradores podem acessar este recurso.");
    error.status = 403;
    throw error;
  }
  return user;
}

function requireMonitorAgent(req) {
  if (!config.monitorAgentToken) {
    const error = new Error("MONITOR_AGENT_TOKEN nao configurado.");
    error.status = 503;
    throw error;
  }

  const header = String(req.headers.authorization || "");
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const token = String(req.headers["x-monitor-token"] || bearer || "");
  if (!safeEqual(token, config.monitorAgentToken)) {
    const error = new Error("Token do agente invalido.");
    error.status = 401;
    throw error;
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isSupportUser(user) {
  if (!authEnabled) return true;
  if (!user) return false;
  if (config.auth.supportUsers.includes(user.email) || config.auth.adminUsers.includes(user.email)) return true;
  return user.groups.some((group) => config.auth.supportGroupIds.includes(group) || config.auth.adminGroupIds.includes(group));
}

function isAdminUser(user) {
  if (!authEnabled) return true;
  if (!user) return false;
  if (config.auth.adminUsers.includes(user.email)) return true;
  return user.groups.some((group) => config.auth.adminGroupIds.includes(group));
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf("=");
        return eq === -1 ? [part, ""] : [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))];
      })
  );
}

function cookieHeader(name, value, req, maxAgeSeconds) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearCookieHeader(name, req) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${name}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
}

function isSecureRequest(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function ensureStore() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    writeDb({ tickets: [], assets: [] });
  }
}

function readDb() {
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  if (!Array.isArray(db.tickets)) db.tickets = [];
  if (!Array.isArray(db.assets)) db.assets = [];
  return db;
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

function createAsset(payload) {
  const name = clean(payload.name);
  const ipAddress = clean(payload.ipAddress);
  if (!name || !ipAddress) {
    const error = new Error("Informe nome e IP do ativo.");
    error.status = 400;
    throw error;
  }

  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    ipAddress,
    type: clean(payload.type || "Computador"),
    department: clean(payload.department),
    owner: clean(payload.owner),
    inventoryNumber: clean(payload.inventoryNumber),
    notes: clean(payload.notes),
    memoryRam: normalizeMemoryRam(payload.memoryRam || payload),
    hardDisk: normalizeHardDisk(payload.hardDisk || payload),
    operatingSystem: normalizeOperatingSystem(payload.operatingSystem || payload),
    enabled: payload.enabled !== false,
    status: "Pendente",
    lastCheckedAt: "",
    lastLatencyMs: null,
    lastError: "",
    os: "",
    softwares: [],
    createdAt: now,
    updatedAt: now,
    history: []
  };
}

function updateAsset(asset, payload) {
  const fields = ["name", "ipAddress", "type", "department", "owner", "inventoryNumber", "notes"];
  for (const field of fields) {
    if (typeof payload[field] === "string") asset[field] = clean(payload[field]);
  }
  if (payload.memoryRam || payload.memoryRamCapacityGb || payload.memoryRamType) {
    asset.memoryRam = normalizeMemoryRam(payload.memoryRam || payload);
  }
  if (payload.hardDisk || payload.hardDiskCapacityGb || payload.hardDiskType) {
    asset.hardDisk = normalizeHardDisk(payload.hardDisk || payload);
  }
  if (payload.operatingSystem || payload.operatingSystemName || payload.operatingSystemVersion) {
    asset.operatingSystem = normalizeOperatingSystem(payload.operatingSystem || payload);
  }
  if (typeof payload.enabled === "boolean") asset.enabled = payload.enabled;
  asset.updatedAt = new Date().toISOString();
}

function normalizeMemoryRam(payload) {
  return {
    capacityGb: clean(payload.capacityGb || payload.memoryRamCapacityGb),
    type: clean(payload.type || payload.memoryRamType)
  };
}

function normalizeHardDisk(payload) {
  return {
    capacityGb: clean(payload.capacityGb || payload.hardDiskCapacityGb),
    type: clean(payload.type || payload.hardDiskType)
  };
}

function normalizeOperatingSystem(payload) {
  return {
    name: clean(payload.name || payload.operatingSystemName),
    version: clean(payload.version || payload.operatingSystemVersion)
  };
}

function saveMonitorResult(payload) {
  const name = clean(payload.name || payload.hostname);
  const ipAddress = clean(payload.ipAddress || payload.ip);
  if (!name && !ipAddress) {
    const error = new Error("Resultado precisa informar name/hostname ou ipAddress/ip.");
    error.status = 400;
    throw error;
  }

  const db = readDb();
  let asset = db.assets.find((item) =>
    (ipAddress && item.ipAddress === ipAddress) || (name && item.name.toLowerCase() === name.toLowerCase())
  );

  if (!asset) {
    asset = createAsset({
      name: name || ipAddress,
      ipAddress: ipAddress || name,
      type: payload.type || "Descoberto",
      department: payload.department || "",
      owner: payload.owner || "",
      notes: "Criado automaticamente pelo agente de monitoramento."
    });
    db.assets.push(asset);
  }

  const checkedAt = clean(payload.checkedAt) || new Date().toISOString();
  const online = Boolean(payload.online);
  asset.name = name || asset.name;
  asset.ipAddress = ipAddress || asset.ipAddress;
  asset.status = online ? "Online" : "Offline";
  asset.lastCheckedAt = checkedAt;
  asset.lastLatencyMs = Number.isFinite(Number(payload.latencyMs)) ? Number(payload.latencyMs) : null;
  asset.lastError = clean(payload.error);
  asset.os = clean(payload.os || asset.os);
  asset.softwares = Array.isArray(payload.softwares)
    ? payload.softwares.map((item) => clean(item)).filter(Boolean).slice(0, 200)
    : asset.softwares;
  asset.updatedAt = new Date().toISOString();
  asset.history = Array.isArray(asset.history) ? asset.history : [];
  asset.history.push({
    at: checkedAt,
    status: asset.status,
    latencyMs: asset.lastLatencyMs,
    error: asset.lastError
  });
  asset.history = asset.history.slice(-50);
  writeDb(db);

  return {
    id: asset.id,
    name: asset.name,
    ipAddress: asset.ipAddress,
    status: asset.status,
    lastCheckedAt: asset.lastCheckedAt
  };
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

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
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
