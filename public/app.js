const state = {
  tickets: [],
  assets: [],
  mineEmail: "",
  supportAgents: [],
  authEnabled: false,
  currentUser: null,
  isSupport: false,
  isAdmin: false
};

const tabs = document.querySelectorAll(".tab");
const views = document.querySelectorAll(".view");
const ticketForm = document.querySelector("#ticketForm");
const formMessage = document.querySelector("#formMessage");
const adminList = document.querySelector("#adminList");
const mineList = document.querySelector("#mineList");
const template = document.querySelector("#ticketTemplate");
const assetTemplate = document.querySelector("#assetTemplate");
const assetForm = document.querySelector("#assetForm");
const assetList = document.querySelector("#assetList");
const assetMessage = document.querySelector("#assetMessage");
const successNotice = document.querySelector("#successNotice");
const successMessage = document.querySelector("#successMessage");

init();

async function init() {
  bindNavigation();
  bindForms();
  await loadConfig();
  await loadMe();
  if (state.authEnabled && !state.currentUser) {
    showAuthGate();
    return;
  }
  setupAuthenticatedUi();
  await loadTickets();
}

function bindNavigation() {
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((item) => item.classList.remove("active"));
      views.forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      document.querySelector(`#view-${tab.dataset.view}`).classList.add("active");
      if (tab.dataset.view === "admin") renderAdmin();
      if (tab.dataset.view === "mine") renderMine();
      if (tab.dataset.view === "monitor") loadAssets();
    });
  });
}

function bindForms() {
  ticketForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = ticketForm.querySelector("button");
    button.disabled = true;
    button.textContent = "Enviando...";
    formMessage.textContent = "Registrando chamado...";
    const payload = Object.fromEntries(new FormData(ticketForm).entries());
    try {
      const ticket = await api("/api/tickets", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      ticketForm.reset();
      applyIdentityFields();
      formMessage.textContent = "";
      showSuccess(ticket);
      state.mineEmail = ticket.requesterEmail;
      document.querySelector("#mineEmail").value = ticket.requesterEmail;
      await loadTickets();
    } catch (error) {
      formMessage.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "Abrir chamado";
    }
  });

  document.querySelector("#refreshAdmin").addEventListener("click", loadTickets);
  document.querySelector("#adminSearch").addEventListener("input", renderAdmin);
  document.querySelector("#statusFilter").addEventListener("change", renderAdmin);
  document.querySelector("#dismissSuccess").addEventListener("click", () => {
    successNotice.hidden = true;
  });
  document.querySelector("#mineSearch").addEventListener("click", () => {
    state.mineEmail = document.querySelector("#mineEmail").value.trim().toLowerCase();
    renderMine();
  });

  assetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = assetForm.querySelector("button");
    button.disabled = true;
    button.textContent = "Cadastrando...";
    assetMessage.textContent = "";
    try {
      await api("/api/assets", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(assetForm).entries()))
      });
      assetForm.reset();
      assetMessage.textContent = "Ativo cadastrado.";
      await loadAssets();
    } catch (error) {
      assetMessage.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "Cadastrar ativo";
    }
  });

  document.querySelector("#refreshAssets").addEventListener("click", loadAssets);
}

async function loadConfig() {
  const config = await api("/api/config");
  document.title = config.appName;
  document.querySelector("#appName").textContent = config.appName;
  document.querySelector("#emailMode").textContent = `E-mail: ${config.emailMode === "graph" ? "Graph ativo" : config.emailMode === "smtp" ? "SMTP ativo" : "modo teste"}`;
  document.querySelector("#accessMode").textContent = `Acesso: ${config.restrictedAccess ? "restrito" : "aberto"}`;
  state.supportAgents = config.supportAgents || [];
  state.authEnabled = Boolean(config.authEnabled);
  if (config.user) {
    state.currentUser = config.user;
    state.isSupport = Boolean(config.isSupport);
    state.isAdmin = Boolean(config.isAdmin);
  }
}

async function loadMe() {
  if (!state.authEnabled) return;
  const me = await api("/api/me");
  if (me.authenticated) {
    state.currentUser = me.user;
    state.isSupport = Boolean(me.isSupport);
    state.isAdmin = Boolean(me.isAdmin);
  }
}

function showAuthGate() {
  document.querySelector("#authGate").hidden = false;
  document.querySelector("main").hidden = true;
  document.querySelector(".tabs").hidden = true;
  document.querySelector("#userBar").hidden = true;
}

function setupAuthenticatedUi() {
  document.querySelector("#authGate").hidden = true;
  document.querySelector("main").hidden = false;
  document.querySelector(".tabs").hidden = false;

  if (state.currentUser) {
    document.querySelector("#userName").textContent = `${state.currentUser.name} (${state.currentUser.email})`;
    document.querySelector("#userBar").hidden = false;
    document.querySelector("#accountName").textContent = state.currentUser.name;
    document.querySelector("#accountEmail").textContent = state.currentUser.email;
    document.querySelector("#accountCard").hidden = false;
    document.querySelectorAll(".identity-field").forEach((field) => {
      field.hidden = true;
    });
    applyIdentityFields();
    document.querySelector("#mineEmail").value = state.currentUser.email;
    document.querySelector("#mineEmail").readOnly = true;
    state.mineEmail = state.currentUser.email;
  }

  const adminTab = document.querySelector('[data-view="admin"]');
  if (adminTab && !state.isSupport) {
    adminTab.hidden = true;
  }
  const monitorTab = document.querySelector('[data-view="monitor"]');
  if (monitorTab && !state.isAdmin) {
    monitorTab.hidden = true;
  }
}

function applyIdentityFields() {
  if (!state.currentUser) return;
  ticketForm.requesterName.value = state.currentUser.name;
  ticketForm.requesterEmail.value = state.currentUser.email;
}

function showSuccess(ticket) {
  successMessage.textContent = `${ticket.id} foi registrado e a TI recebeu a notificacao por e-mail.`;
  successNotice.hidden = false;
  successNotice.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function loadTickets() {
  state.tickets = await api("/api/tickets");
  renderAdmin();
  renderMine();
}

async function loadAssets() {
  if (state.authEnabled && !state.isAdmin) return;
  state.assets = await api("/api/assets");
  renderAssets();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Falha na requisicao.");
  return data;
}

function renderAdmin() {
  if (state.authEnabled && !state.isSupport) {
    adminList.className = "ticket-list empty";
    adminList.textContent = "Apenas atendentes podem acessar o Painel TI.";
    return;
  }
  renderMetrics();
  const term = document.querySelector("#adminSearch").value.trim().toLowerCase();
  const status = document.querySelector("#statusFilter").value;
  const tickets = state.tickets.filter((ticket) => {
    const haystack = [ticket.id, ticket.requesterName, ticket.requesterEmail, ticket.department, ticket.title, ticket.category]
      .join(" ")
      .toLowerCase();
    return (!status || ticket.status === status) && (!term || haystack.includes(term));
  });
  adminList.innerHTML = "";
  if (!tickets.length) {
    adminList.className = "ticket-list empty";
    adminList.textContent = "Nenhum chamado encontrado.";
    return;
  }
  adminList.className = "ticket-list";
  tickets.forEach((ticket) => adminList.appendChild(ticketNode(ticket, true)));
}

function renderAssets() {
  assetList.innerHTML = "";
  if (!state.assets.length) {
    assetList.className = "asset-list empty";
    assetList.textContent = "Nenhum ativo cadastrado ainda.";
    return;
  }

  assetList.className = "asset-list";
  state.assets.forEach((asset) => assetList.appendChild(assetNode(asset)));
}

function assetNode(asset) {
  const node = assetTemplate.content.firstElementChild.cloneNode(true);
  const status = asset.status || "Pendente";
  node.querySelector(".asset-name").textContent = asset.name;
  node.querySelector(".asset-status").textContent = status;
  node.querySelector(".asset-status").dataset.status = status;
  node.querySelector(".asset-ip").textContent = asset.ipAddress;
  node.querySelector(".asset-type").textContent = asset.type || "-";
  node.querySelector(".asset-department").textContent = asset.department || "-";
  node.querySelector(".asset-checked").textContent = asset.lastCheckedAt ? formatDate(asset.lastCheckedAt) : "Nunca";
  node.querySelector(".asset-error").textContent = asset.lastError || "";
  node.querySelector(".asset-error").hidden = !asset.lastError;
  node.querySelector(".asset-os").textContent = asset.os ? `SO: ${asset.os}` : "SO ainda nao coletado";
  const softwares = Array.isArray(asset.softwares) ? asset.softwares.slice(0, 8) : [];
  node.querySelector(".asset-softwares").textContent = softwares.length
    ? `Softwares: ${softwares.join(", ")}`
    : "Softwares ainda nao coletados";
  return node;
}

function renderMine() {
  const email = state.mineEmail || document.querySelector("#mineEmail").value.trim().toLowerCase();
  mineList.innerHTML = "";
  if (!email) {
    mineList.className = "ticket-list empty";
    mineList.textContent = "Informe seu e-mail para consultar seus chamados.";
    return;
  }
  const tickets = state.tickets.filter((ticket) => ticket.requesterEmail.toLowerCase() === email);
  if (!tickets.length) {
    mineList.className = "ticket-list empty";
    mineList.textContent = "Nenhum chamado encontrado para este e-mail.";
    return;
  }
  mineList.className = "ticket-list";
  tickets.forEach((ticket) => mineList.appendChild(ticketNode(ticket, false)));
}

function ticketNode(ticket, editable) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.querySelector(".ticket-id").textContent = ticket.id;
  node.querySelector(".status").textContent = ticket.status;
  node.querySelector(".status").dataset.status = ticket.status;
  node.querySelector(".priority").textContent = ticket.priority;
  node.querySelector(".priority").dataset.priority = ticket.priority;
  node.querySelector("h3").textContent = ticket.title;
  node.querySelector(".desc").textContent = ticket.description;
  node.querySelector(".requester").textContent = `${ticket.requesterName} <${ticket.requesterEmail}>`;
  node.querySelector(".department").textContent = ticket.department;
  node.querySelector(".category").textContent = ticket.category;
  node.querySelector(".created").textContent = formatDate(ticket.createdAt);

  const form = node.querySelector(".admin-edit");
  if (!editable) {
    form.remove();
    return node;
  }

  form.status.value = ticket.status;
  fillAssigneeOptions(form.assignee, ticket.assignee || "");
  form.adminNotes.value = ticket.adminNotes || "";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.textContent = "Salvando...";
    button.disabled = true;
    try {
      await api(`/api/tickets/${ticket.id}`, {
        method: "PATCH",
        body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
      });
      button.textContent = "Salvo e enviado";
      await loadTickets();
    } catch (error) {
      button.textContent = "Falha no e-mail";
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  });

  return node;
}

function fillAssigneeOptions(select, currentValue) {
  const agents = state.supportAgents.length ? state.supportAgents : ["João Pedro da Silva"];
  select.innerHTML = '<option value="">Selecione</option>';
  agents.forEach((agent) => {
    const option = document.createElement("option");
    option.value = agent;
    option.textContent = agent;
    select.appendChild(option);
  });
  select.value = agents.includes(currentValue) ? currentValue : "";
}

function renderMetrics() {
  const statuses = ["Aberto", "Em atendimento", "Aguardando usuario", "Resolvido", "Cancelado"];
  const metrics = document.querySelector("#metrics");
  metrics.innerHTML = statuses
    .map((status) => {
      const count = state.tickets.filter((ticket) => ticket.status === status).length;
      return `<div class="metric"><strong>${count}</strong><span>${status}</span></div>`;
    })
    .join("");
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}
