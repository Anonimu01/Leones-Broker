(function () {
  "use strict";

  if (window.__LEONES_AUTH_GUARD__) return;
  window.__LEONES_AUTH_GUARD__ = true;

  const TOKEN_KEY = "token";
  const PUBLIC_PAGES = ["login.html", "register.html", "index.html"];
  const DASHBOARD_PAGE = "/dashboard.html";

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || localStorage.getItem("BROKER_TOKEN");
  }

  function isPublicPage() {
    const path = window.location.pathname;
    return PUBLIC_PAGES.some(p => path.includes(p)) || path === "/";
  }

  function isDashboardPage() {
    return window.location.pathname.includes("dashboard.html");
  }

  function redirectToDashboard() {
    if (!isDashboardPage()) {
      console.log("[AUTH] Redirigiendo a dashboard...");
      window.location.href = DASHBOARD_PAGE;
    }
  }

  function redirectToLogin() {
    if (!isPublicPage()) {
      console.log("[AUTH] Redirigiendo a login...");
      window.location.href = "/login.html";
    }
  }

  function initAuthGuard() {
    const token = getToken();

    // Pequeño delay para evitar conflictos con otros scripts
    setTimeout(() => {
      if (token) {
        // Si hay token y estamos en página pública, vamos a dashboard
        if (isPublicPage()) {
          redirectToDashboard();
        }
      } else {
        // Si no hay token y estamos en página privada, vamos a login
        if (!isPublicPage()) {
          redirectToLogin();
        }
      }
    }, 150);
  }

  document.addEventListener("DOMContentLoaded", initAuthGuard);

})();
