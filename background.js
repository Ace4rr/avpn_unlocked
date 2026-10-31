// ========= CONFIG =========
const DEFAULT_API = "https://api.open60m.ru";
const FALLBACK_API = "https://api2.open60m.ru";
const TICK_MIN = 0.5;          // период фоновой проверки, мин
const REQUEST_TIMEOUT = 7000;

const SERVERS = {
  de: { name: "Германия", code: "DE" },
  nl: { name: "Нидерланды", code: "NL" },
  ru: { name: "Россия", code: "RU" }
};

const DEFAULT_SETTINGS = {
  scheme: "http",          // http | socks5
  bypass: "<local>",       // сайты мимо VPN, через запятую или с новой строки
  autoReconnect: true,     // пересоздавать сессию, если сервер её убил
  renewAheadMin: 5,        // продлевать сессию за N минут до конца TTL
  apiBase: ""              // свой API (пусто — стандартный)
};

// ========= STORAGE =========
const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

async function getSettings() {
  const { settings } = await get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function bypassList(raw) {
  const list = String(raw || "").split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  if (!list.includes("<local>")) list.unshift("<local>");
  return list;
}

// ========= API =========
function bases(settings) {
  const primary = (settings.apiBase || "").trim() || DEFAULT_API;
  return primary === DEFAULT_API ? [primary, FALLBACK_API] : [primary];
}

async function api(endpoint, { method = "GET", token, body } = {}) {
  const s = await getSettings();
  let lastErr;
  for (const base of bases(s)) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT);
      const res = await fetch(base + endpoint, {
        method,
        body,
        cache: "no-store",
        signal: ctl.signal,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      }).finally(() => clearTimeout(timer));

      const data = await res.json().catch(() => { throw new Error("bad_response"); });
      if (!res.ok) {
        const err = new Error(data.error || data.message || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (e) {
      lastErr = e;
      // клиентские ошибки второй сервер не починит
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
    }
  }
  throw lastErr || new Error("network");
}

// ========= INSTALL ID =========
async function installId() {
  const d = await get("install_id");
  if (d.install_id) return d.install_id;
  const id = crypto.randomUUID();
  await set({ install_id: id });
  return id;
}

// ========= SESSIONS =========
async function createSession(serverKey) {
  const def = SERVERS[serverKey] || SERVERS.de;
  const data = await api("/session/create", {
    method: "POST",
    body: JSON.stringify({ install_id: await installId(), country: def.code })
  });
  return {
    session_id: data.session_id,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    proxy: { host: data.proxy.host, port: data.proxy.port },
    server: serverKey,
    created_at: Date.now()
  };
}

function destroySession(session) {
  if (!session?.access_token) return;
  api("/session/destroy", { method: "POST", token: session.access_token }).catch(() => {});
}

// Продление: серверная миграция если есть, иначе пересоздание сессии.
// Старая сессия закрывается только ПОСЛЕ успешного переключения — коннект не рвётся.
async function renewSession(session, s) {
  try {
    const st = await api("/session/status", { token: session.access_token });

    if (st.migration) {
      const m = st.migration;
      const next = {
        ...session,
        session_id: m.new_session_id,
        access_token: m.new_access_token,
        refresh_token: m.new_refresh_token,
        expires_at: m.new_expires_at,
        proxy: { host: m.new_host, port: m.new_port },
        created_at: Date.now()
      };
      await applyProxy(next, s);
      destroySession(session);
      return next;
    }

    // сервер сам продлил TTL — просто берём новый срок
    if (st.expires_at && new Date(st.expires_at).getTime() > Date.now() + 60000) {
      return { ...session, expires_at: st.expires_at };
    }
  } catch (e) {
    if (!e.status || e.status >= 500) throw e; // сеть — повторим на следующем тике
    // сессия больше не действует (401/404/410) — пересоздаём ниже
  }

  const fresh = await createSession(session.server);
  await applyProxy(fresh, s);
  destroySession(session);
  return fresh;
}

// ========= PROXY =========
async function applyProxy(session, settings) {
  const s = settings || await getSettings();
  await chrome.proxy.settings.set({
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: s.scheme, host: session.proxy.host, port: session.proxy.port },
        bypassList: bypassList(s.bypass)
      }
    },
    scope: "regular"
  });
}

async function proxyActive() {
  const cfg = await chrome.proxy.settings.get({});
  return cfg.value?.mode === "fixed_servers";
}

function clearProxy() {
  return chrome.proxy.settings.clear({ scope: "regular" }).catch(() => {});
}

// ========= ERRORS =========
function friendly(e) {
  const m = String(e?.message || e || "");
  if (m.includes("rate_limit")) return "Слишком много попыток, подождите минуту";
  if (m.includes("no_nodes_available")) return "Нет свободных серверов";
  if (m.includes("no_ports_available")) return "Сервер перегружен";
  if (m.includes("bad_response") || m === "network" || m.toLowerCase().includes("abort")) return "Сервер недоступен";
  return m || "Ошибка подключения";
}

// ========= ACTIONS =========
async function doEnable() {
  const { server } = await get("server");
  const s = await getSettings();
  await set({ vpnState: "ENABLING", lastError: null });
  try {
    const session = await createSession(server || "de");
    await applyProxy(session, s);
    await set({ enabled: true, session, vpnState: "ON" });
    armTick();
  } catch (e) {
    await clearProxy();
    await set({ enabled: false, session: null, vpnState: "OFF", lastError: friendly(e) });
  }
}

async function doDisable() {
  const { session } = await get("session");
  killTick();
  destroySession(session);
  await clearProxy();
  await set({ enabled: false, session: null, vpnState: "OFF", lastError: null });
}

async function doSwitch(serverKey) {
  if (!SERVERS[serverKey]) return;
  await set({ server: serverKey });
  const { enabled, session: old } = await get(["enabled", "session"]);
  if (!enabled) return;

  const s = await getSettings();
  await set({ vpnState: "SWITCHING", lastError: null });
  try {
    destroySession(old);
    await clearProxy();
    const session = await createSession(serverKey);
    await applyProxy(session, s);
    await set({ session, vpnState: "ON" });
  } catch (e) {
    await set({ enabled: false, session: null, vpnState: "OFF", lastError: friendly(e) });
  }
}

// Фон: без таймеров отключения. Только продление сессии и синхронизация прокси.
async function tick() {
  const d = await get(["enabled", "session"]);
  if (d.enabled !== true) {
    if (await proxyActive()) await clearProxy();
    return;
  }

  const s = await getSettings();
  let session = d.session;

  if (!session) {
    if (s.autoReconnect) await reconnect(s);
    return;
  }

  const ahead = Math.max(1, s.renewAheadMin) * 60000;
  const left = (new Date(session.expires_at).getTime() || 0) - Date.now();
  if (left < ahead) {
    try {
      session = await renewSession(session, s);
    } catch (e) {
      await set({ lastError: "Продление: " + friendly(e) });
      return; // повтор на следующем тике
    }
  }

  if (!(await proxyActive())) {
    try { await applyProxy(session, s); } catch { return; }
  }

  await set({ session, lastError: null });
}

async function reconnect(s) {
  const { server } = await get("server");
  try {
    const session = await createSession(server || "de");
    await applyProxy(session, s);
    await set({ session, vpnState: "ON", lastError: null });
  } catch (e) {
    await set({ lastError: friendly(e) });
  }
}

// ========= ALARMS & LIFECYCLE =========
const TICK = "tick";
function armTick() { chrome.alarms.create(TICK, { periodInMinutes: TICK_MIN }); }
function killTick() { chrome.alarms.clear(TICK); }

chrome.alarms.onAlarm.addListener((a) => { if (a.name === TICK) tick(); });

chrome.runtime.onStartup.addListener(async () => {
  // не убиваем VPN при старте браузера — восстанавливаем
  const d = await get(["enabled", "session"]);
  if (d.enabled && d.session) {
    await applyProxy(d.session).catch(() => {});
    armTick();
  } else {
    await clearProxy();
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await installId();
  if (details.reason === "install") {
    await set({ server: "de", enabled: false, vpnState: "OFF" });
  }
});

// ========= MESSAGES =========
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "GET_STATE": {
        const d = await get(["enabled", "server", "vpnState", "lastError", "session"]);
        sendResponse({
          ok: true,
          enabled: d.enabled === true,
          server: d.server || "de",
          vpnState: d.vpnState || "OFF",
          lastError: d.lastError || null,
          expiresAt: d.session?.expires_at || null
        });
        return;
      }
      case "TOGGLE": {
        const { vpnState } = await get("vpnState");
        if (!BUSY_STATES.includes(vpnState)) {
          if ((await get("enabled")).enabled) await doDisable();
          else await doEnable();
        }
        sendResponse({ ok: true });
        return;
      }
      case "SET_SERVER": {
        await doSwitch(msg.server);
        sendResponse({ ok: true });
        return;
      }
      case "GET_SETTINGS": {
        sendResponse({ ok: true, settings: await getSettings() });
        return;
      }
      case "SET_SETTINGS": {
        const next = { ...(await getSettings()), ...(msg.patch || {}) };
        await set({ settings: next });
        // протокол/исключения применяются к активному прокси сразу
        const { enabled, session } = await get(["enabled", "session"]);
        if (enabled && session) await applyProxy(session, next).catch(() => {});
        sendResponse({ ok: true });
        return;
      }
    }
    sendResponse({ ok: false, error: "unknown_message" });
  })();
  return true;
});

const BUSY_STATES = ["ENABLING", "DISABLING", "SWITCHING"];

// ========= INIT (при каждом пробуждении service worker) =========
(async () => {
  await installId();
  const { enabled, session } = await get(["enabled", "session"]);
  if (enabled && session) {
    if (!(await proxyActive())) await applyProxy(session).catch(() => {});
    armTick();
  }
})();
