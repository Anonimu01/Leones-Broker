(function () {
  "use strict";

  console.log("[LEONES] trading.js loaded");

  const API = window.API || "/api";
  const SOCKET_URL = window.SOCKET_URL || location.origin;

  let socket = null;

  function getToken() {
    try {
      return localStorage.getItem("token") || localStorage.getItem("BROKER_TOKEN");
    } catch (e) {
      return null;
    }
  }

  const token = getToken();

  /* ===============================
     SOCKET.IO CONNECTION
  =============================== */
  function initSocket() {
    try {
      socket = io(SOCKET_URL, {
        auth: { token },
        transports: ["websocket"],
      });

      socket.on("connect", () => {
        console.log("📡 Conectado al socket:", socket.id);
        socket.emit("request_symbols");
        socket.emit("request_prices_snapshot");
      });

      socket.on("disconnect", () => {
        console.log("❌ Socket desconectado");
      });

      socket.on("prices_snapshot", (data) => {
        console.log("💰 Snapshot precios:", data);
        updatePrices(data);
      });

      socket.on("symbols_update", (symbols) => {
        console.log("📊 Símbolos:", symbols);
        renderSymbols(symbols);
      });

    } catch (e) {
      console.warn("Socket error:", e);
    }
  }

  /* ===============================
     FETCH ACCOUNT
  =============================== */
  async function loadAccount() {
    try {
      const res = await fetch(`${API}/account`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) throw new Error("No autorizado");

      const data = await res.json();
      console.log("👤 Account:", data);

      renderAccount(data.account);

    } catch (e) {
      console.warn("Error cargando cuenta:", e.message);
    }
  }

  /* ===============================
     FETCH POSITIONS
  =============================== */
  async function loadPositions() {
    try {
      const res = await fetch(`${API}/positions`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) return;

      const data = await res.json();
      console.log("📦 Posiciones:", data);

      renderPositions(data);

    } catch (e) {
      console.warn("Error posiciones:", e);
    }
  }

  /* ===============================
     RENDER FUNCTIONS (SEGURAS)
  =============================== */
  function renderAccount(account) {
    if (!account) return;

    const el = document.getElementById("balance");
    if (el) el.textContent = account.balance ?? 0;
  }

  function renderPositions(positions) {
    const container = document.getElementById("positions");
    if (!container) return;

    container.innerHTML = "";

    (positions || []).forEach((p) => {
      const div = document.createElement("div");
      div.textContent = `${p.symbol} | ${p.size} | ${p.price}`;
      container.appendChild(div);
    });
  }

  function renderSymbols(symbols) {
    const container = document.getElementById("symbols");
    if (!container) return;

    container.innerHTML = "";

    (symbols || []).forEach((s) => {
      const div = document.createElement("div");
      div.textContent = s.label || s.symbol;
      container.appendChild(div);
    });
  }

  function updatePrices(prices) {
    // puedes mejorar esto luego para UI
    console.log("🔄 Actualizando precios...");
  }

  /* ===============================
     INIT
  =============================== */
  function init() {
    if (!token) {
      console.warn("⚠️ No hay token, modo público");
      return;
    }

    initSocket();
    loadAccount();
    loadPositions();
  }

  document.addEventListener("DOMContentLoaded", init);

})();
