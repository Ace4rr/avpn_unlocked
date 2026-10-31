const $ = (id) => document.getElementById(id);
const msg = (p) => new Promise((res) => chrome.runtime.sendMessage(p, (r) => res(r || { ok: false })));

const NAMES = { de: "Германия", nl: "Нидерланды", ru: "Россия" };
const BUSY = ["ENABLING", "DISABLING", "SWITCHING"];

let state = { enabled: false, server: "de", vpnState: "OFF", lastError: null, expiresAt: null };

function timeLeft() {
  if (!state.enabled || !state.expiresAt) return null;
  return new Date(state.expiresAt).getTime() - Date.now();
}

function render() {
  const busy = BUSY.includes(state.vpnState);
  const on = state.enabled && state.vpnState === "ON";

  $("avatar").className = busy ? "warn" : on ? "ok" : state.lastError ? "err" : "";
  $("status").textContent = busy
    ? (state.vpnState === "DISABLING" ? "Отключение…" : "Подключение…")
    : on ? (NAMES[state.server] || state.server)
    : "Отключено";

  const btn = $("toggle");
  btn.className = "toggle " + (busy ? "busy" : on ? "on" : "off");
  $("label").textContent = busy ? "…" : on ? "Отключиться" : "Подключиться";

  document.querySelectorAll(".srv").forEach((b) =>
    b.classList.toggle("active", b.dataset.srv === state.server)
  );

  $("error").hidden = !state.lastError;
  $("error").textContent = state.lastError || "";

  updateMeta();
}

function updateMeta() {
  const left = timeLeft();
  const meta = $("meta");
  if (left == null || left <= 0) { meta.hidden = true; return; }
  meta.hidden = false;
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  meta.textContent = `сессия обновится через ${m}:${String(s).padStart(2, "0")}`;
}

async function refresh() {
  const r = await msg({ type: "GET_STATE" });
  if (!r.ok) return;
  state = r;
  render();
}

// ===== toggle =====
$("toggle").onclick = async () => {
  if (BUSY.includes(state.vpnState)) return;
  $("toggle").className = "toggle busy";
  await msg({ type: "TOGGLE" });
  refresh();
};

// ===== servers =====
document.querySelectorAll(".srv").forEach((b) => {
  b.onclick = async () => {
    if (b.dataset.srv === state.server && state.enabled) return;
    state.server = b.dataset.srv;
    render();
    await msg({ type: "SET_SERVER", server: b.dataset.srv });
    refresh();
  };
});

setInterval(updateMeta, 1000);

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && (ch.vpn_state || ch.enabled || ch.lastError)) refresh();
});

// ===== settings =====
$("gear").onclick = () => { $("panel").hidden = !$("panel").hidden; };

async function loadSettings() {
  const r = await msg({ type: "GET_SETTINGS" });
  if (!r.ok) return;
  const s = r.settings;
  $("autoReconnect").checked = !!s.autoReconnect;
  $("renewAhead").value = s.renewAheadMin;
  $("scheme").value = s.scheme;
  // "<local>" подставляется сам, показываем только пользовательские записи
  $("bypass").value = s.bypass === "<local>" ? "" : s.bypass;
  $("apiBase").value = s.apiBase || "";
}

function saveSettings() {
  const patch = {
    autoReconnect: $("autoReconnect").checked,
    renewAheadMin: Math.min(20, Math.max(1, parseInt($("renewAhead").value, 10) || 5)),
    scheme: $("scheme").value,
    bypass: $("bypass").value,
    apiBase: $("apiBase").value.trim()
  };
  msg({ type: "SET_SETTINGS", patch });
}

["autoReconnect", "renewAhead", "scheme", "bypass", "apiBase"].forEach((id) => {
  $(id).addEventListener("change", saveSettings);
});

refresh();
loadSettings();
