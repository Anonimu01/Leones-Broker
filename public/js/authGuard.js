<script>
(function () {
  "use strict";

  if (window.__LEONES_AUTH_GUARD__) return;
  window.__LEONES_AUTH_GUARD__ = true;

  const TOKEN_KEY = "token";
  const PUBLIC_PAGES = ["login.html", "register.html", "index.html"];
  const PRIVATE_PAGE = "/dashboard.html";

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || localStorage.getItem("BROKER_TOKEN");
  }

  function isPublicPage() {
    const path = window.location.pathname;
    return PUBLIC_PAGES.some(p => path.includes(p)) || path === "/";
  }

  function isDashboard() {
    return window.location.pathname.includes("dashboard.html");
  }

  function redirectToDashboard() {
    if (!isDashboard()) {
      console.log("[AUTH] Redirigiendo a dashboard...");
      window.location.href = PRIVATE_PAGE;
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

    // ⛔ IMPORTANTE: esperar a que otros scripts carguen
    setTimeout(() => {
      if (token) {
        // Solo redirigir si está en páginas públicas
        if (isPublicPage()) {
          redirectToDashboard();
        }
      } else {
        // Solo redirigir si intenta entrar a zona privada
        if (!isPublicPage()) {
          redirectToLogin();
        }
      }
    }, 150); // pequeño delay evita conflicto con JS #2
  }

  document.addEventListener("DOMContentLoaded", initAuthGuard);
})();
</script>
