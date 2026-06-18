const state = {
  tickets: [],
  assets: [],
  mineEmail: "",
  supportAgents: [],
  authEnabled: false,
  currentUser: null,
  isSupport: false,
  isAdmin: false,
  editingAssetId: null
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
const cancelAssetEdit = document.querySelector("#cancelAssetEdit");
const assetSearch = document.querySelector("#assetSearch");
const assetStatusFilter = document.querySelector("#assetStatusFilter");
const successNotice = document.querySelector("#successNotice");
const successMessage = document.querySelector("#successMessage");
const userMenuButton = document.querySelector("#userMenuButton");
const userMenu = document.querySelector("#userMenu");
let assetMessageTimeout = null;

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

  userMenuButton.addEventListener("click", () => {
    const isOpen = !userMenu.hidden;
    userMenu.hidden = isOpen;
    userMenuButton.setAttribute("aria-expanded", String(!isOpen));
  });

  document.addEventListener("click", (event) => {
    if (userMenu.hidden || document.querySelector("#userBar").contains(event.target)) return;
    userMenu.hidden = true;
    userMenuButton.setAttribute("aria-expanded", "false");
  });

  assetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = assetForm.querySelector("button");
    const isEditing = Boolean(state.editingAssetId);
    button.disabled = true;
    button.textContent = isEditing ? "Salvando..." : "Cadastrando...";
    showAssetMessage("");
    try {
      await api(isEditing ? `/api/assets/${state.editingAssetId}` : "/api/assets", {
        method: isEditing ? "PATCH" : "POST",
        body: JSON.stringify(assetPayloadFromForm())
      });
      assetForm.reset();
      showAssetMessage(isEditing ? "Ativo atualizado." : "Ativo cadastrado.");
      resetAssetFormMode();
      await loadAssets();
    } catch (error) {
      showAssetMessage(error.message);
    } finally {
      button.disabled = false;
      button.textContent = state.editingAssetId ? "Salvar alteracoes" : "Cadastrar ativo";
    }
  });

  cancelAssetEdit.addEventListener("click", () => {
    assetForm.reset();
    resetAssetFormMode();
    showAssetMessage("");
  });

  document.querySelector("#refreshAssets").addEventListener("click", loadAssets);
  assetSearch.addEventListener("input", renderAssets);
  assetStatusFilter.addEventListener("change", renderAssets);
}

async function loadConfig() {
  const config = await api("/api/config");
  document.title = config.appName;
  document.querySelector("#appName").textContent = config.appName;
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
    document.querySelector("#userInitials").textContent = initialsFromName(state.currentUser.name);
    document.querySelector("#userMenuName").textContent = state.currentUser.name;
    document.querySelector("#userMenuEmail").textContent = state.currentUser.email;
    document.querySelector("#userBar").hidden = false;
    document.querySelector("#accountGreeting").textContent = `Ol\u00e1, ${state.currentUser.name}`;
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
  if ((response.status === 401 || response.status === 403) && state.authEnabled) {
    window.location.href = "/auth/login";
    throw new Error("Sessao expirada. Redirecionando para login.");
  }
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

  const term = assetSearch.value.trim().toLowerCase();
  const statusFilter = assetStatusFilter.value;
  const assets = state.assets.filter((asset) => {
    const status = asset.status || "Pendente";
    const haystack = [
      asset.name,
      asset.ipAddress,
      asset.type,
      asset.department,
      asset.owner,
      asset.inventoryNumber,
      asset.notes,
      assetMemorySummary(asset),
      assetDiskSummary(asset),
      assetOsSummary(asset)
    ]
      .join(" ")
      .toLowerCase();
    return (!statusFilter || status === statusFilter) && (!term || haystack.includes(term));
  });

  if (!assets.length) {
    assetList.className = "asset-list empty";
    assetList.textContent = "Nenhum ativo encontrado para esse filtro.";
    return;
  }

  assetList.className = "asset-list";
  assets.forEach((asset) => assetList.appendChild(assetNode(asset)));
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
  node.querySelector(".asset-inventory").textContent = asset.inventoryNumber || "-";
  node.querySelector(".asset-created").textContent = asset.createdAt ? formatDate(asset.createdAt) : "-";
  node.querySelector(".asset-updated").textContent = asset.updatedAt ? formatDate(asset.updatedAt) : "-";
  node.querySelector(".asset-checked").textContent = asset.lastCheckedAt ? formatDate(asset.lastCheckedAt) : "Nunca";
  const memorySummary = assetMemorySummary(asset);
  const diskSummary = assetDiskSummary(asset);
  const osSummary = assetOsSummary(asset);
  node.querySelector(".asset-ram").textContent = memorySummary;
  node.querySelector(".asset-ram").hidden = !memorySummary;
  node.querySelector(".asset-disk").textContent = diskSummary;
  node.querySelector(".asset-disk").hidden = !diskSummary;
  node.querySelector(".asset-os-summary").textContent = osSummary;
  node.querySelector(".asset-os-summary").hidden = !osSummary;
  node.querySelector(".asset-error").textContent = asset.lastError || "";
  node.querySelector(".asset-error").hidden = !asset.lastError;
  node.querySelector(".asset-os").textContent = asset.os ? `SO: ${asset.os}` : "SO ainda nao coletado";
  const softwares = Array.isArray(asset.softwares) ? asset.softwares.slice(0, 8) : [];
  node.querySelector(".asset-softwares").textContent = softwares.length
    ? `Softwares: ${softwares.join(", ")}`
    : "Softwares ainda nao coletados";
  node.querySelector(".asset-edit-button").addEventListener("click", () => startAssetEdit(asset));
  node.querySelector(".asset-delete-button").addEventListener("click", () => deleteAsset(asset));
  renderHistoryList(node.querySelector(".asset-history"), asset.history, "Nenhum evento registrado.");
  return node;
}

function startAssetEdit(asset) {
  state.editingAssetId = asset.id;
  assetForm.name.value = asset.name || "";
  assetForm.ipAddress.value = asset.ipAddress || "";
  assetForm.type.value = asset.type || "Computador";
  assetForm.department.value = asset.department || "";
  assetForm.owner.value = asset.owner || "";
  assetForm.inventoryNumber.value = asset.inventoryNumber || "";
  assetForm.notes.value = asset.notes || "";
  assetForm.memoryRam.value = assetComponentValue(asset.memoryRam);
  assetForm.hardDisk.value = assetComponentValue(asset.hardDisk);
  assetForm.operatingSystem.value = assetOperatingSystemValue(asset);
  assetForm.querySelector("button[type='submit']").textContent = "Salvar alteracoes";
  cancelAssetEdit.hidden = false;
  showAssetMessage(`Editando ${asset.name}.`);
  assetForm.scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetAssetFormMode() {
  state.editingAssetId = null;
  assetForm.querySelector("button[type='submit']").textContent = "Cadastrar ativo";
  cancelAssetEdit.hidden = true;
}

async function deleteAsset(asset) {
  const confirmed = window.confirm(`Excluir o ativo ${asset.name}? Esta acao nao pode ser desfeita.`);
  if (!confirmed) return;

  try {
    await api(`/api/assets/${asset.id}`, { method: "DELETE" });
    if (state.editingAssetId === asset.id) {
      assetForm.reset();
      resetAssetFormMode();
    }
    showAssetMessage("Ativo excluido.", true);
    await loadAssets();
  } catch (error) {
    showAssetMessage(error.message);
  }
}

function assetPayloadFromForm() {
  const data = Object.fromEntries(new FormData(assetForm).entries());
  return {
    name: data.name,
    ipAddress: data.ipAddress,
    type: data.type,
    department: data.department,
    owner: data.owner,
    inventoryNumber: data.inventoryNumber,
    notes: data.notes,
    memoryRam: {
      type: data.memoryRam
    },
    hardDisk: {
      type: data.hardDisk
    },
    operatingSystem: {
      name: data.operatingSystem
    }
  };
}

function showAssetMessage(message, temporary = false) {
  if (assetMessageTimeout) {
    clearTimeout(assetMessageTimeout);
    assetMessageTimeout = null;
  }
  assetMessage.textContent = message;
  if (message && temporary) {
    assetMessageTimeout = setTimeout(() => {
      assetMessage.textContent = "";
      assetMessageTimeout = null;
    }, 2500);
  }
}

function assetMemorySummary(asset) {
  const capacity = asset.memoryRam?.capacityGb;
  const type = asset.memoryRam?.type;
  if (!capacity && !type) return "";
  return `RAM: ${[capacity ? `${capacity} GB` : "", type].filter(Boolean).join(" ")}`;
}

function assetDiskSummary(asset) {
  const capacity = asset.hardDisk?.capacityGb;
  const type = asset.hardDisk?.type;
  if (!capacity && !type) return "";
  return `Disco: ${[capacity ? `${capacity} GB` : "", type].filter(Boolean).join(" ")}`;
}

function assetOsSummary(asset) {
  const name = asset.operatingSystem?.name || asset.os;
  const version = asset.operatingSystem?.version;
  if (!name && !version) return "";
  return `SO: ${[name, version].filter(Boolean).join(" ")}`;
}

function assetComponentValue(component) {
  if (!component) return "";
  return [component.capacityGb ? `${component.capacityGb} GB` : "", component.type].filter(Boolean).join(" ");
}

function assetOperatingSystemValue(asset) {
  return [asset.operatingSystem?.name || asset.os, asset.operatingSystem?.version].filter(Boolean).join(" ");
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
  node.querySelector(".ticket-updated").textContent = ticket.updatedAt ? formatDate(ticket.updatedAt) : "-";
  renderHistoryList(node.querySelector(".ticket-history"), ticket.history, "Nenhuma movimentacao registrada.");

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

function renderHistoryList(list, history, emptyText) {
  const items = Array.isArray(history) ? history.slice(-5).reverse() : [];
  list.innerHTML = "";
  if (!items.length) {
    const item = document.createElement("li");
    item.textContent = emptyText;
    list.appendChild(item);
    return;
  }

  items.forEach((entry) => {
    const item = document.createElement("li");
    const when = entry.at ? formatDate(entry.at) : "Sem data";
    const event = entry.event || entry.status || "Evento";
    const detail = entry.detail || entry.error || "";
    item.textContent = `${when} - ${event}${detail ? `: ${detail}` : ""}`;
    list.appendChild(item);
  });
}

function initialsFromName(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "U";
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}
