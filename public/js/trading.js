<script>
(function () {
  "use strict";

  if (window.__LEONES_TRADING_JS3_LOADED__) {
    console.warn("[LEONES] trading.js ya estaba cargado, se omite.");
    return;
  }
  window.__LEONES_TRADING_JS3_LOADED__ = true;

  console.log("[LEONES] trading.js loaded (bridge mode)");

  const API = window.API || "/api";
  const SOCKET_URL = window.SOCKET_URL || location.origin;

  function getToken() {
    try {
      return localStorage.getItem("token") || localStorage.getItem("BROKER_TOKEN");
    } catch (e) {
      return null;
    }
  }

  function hasSession() {
    return !!getToken();
  }

  function safeCall(fn, ...args) {
    try {
      if (typeof fn === "function") return fn(...args);
    } catch (e) {
      console.warn("[LEONES] safeCall error:", e);
    }
    return null;
  }

  function refreshFromMainUI() {
    safeCall(window.refreshBrokerUI);
    safeCall(window.startBrokerUI);
    safeCall(window.loadAccount);
    safeCall(window.fetchPositions);
  }

  function bindEvents() {
    if (window.__LEONES_TRADING_JS3_EVENTS__) return;
    window.__LEONES_TRADING_JS3_EVENTS__ = true;

    window.addEventListener("leones:loggedIn", () => {
      refreshFromMainUI();
    });

    window.addEventListener("leones:loggedOut", () => {
      const balanceEl = document.getElementById("balance");
      if (balanceEl) balanceEl.textContent = "--";

      const positionsEl = document.getElementById("positions");
      if (positionsEl) positionsEl.innerHTML = "";

      const symbolsEl = document.getElementById("symbols");
      if (symbolsEl) symbolsEl.innerHTML = "";
    });
  }

  function init() {
    bindEvents();

    if (!hasSession()) {
      console.warn("⚠️ No hay token, modo público");
      return;
    }

    refreshFromMainUI();
  }

  document.addEventListener("DOMContentLoaded", init);

  window.__LEONES_TRADING_BRIDGE__ = {
    refreshFromMainUI,
    hasSession,
    API,
    SOCKET_URL
  };
})();
</script>
