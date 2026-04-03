<script>
(function () {
  "use strict";

  const TOKEN_KEY = "token"; // el que ya usas
  const PUBLIC_PAGES = ["login.html", "register.html", "index.html"];
  const PRIVATE_PAGE = "/dashboard.html"; // 👈 tu panel tipo trader

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || localStorage.getItem("BROKER_TOKEN");
  }

  function isPublicPage() {
    const path = window.location.pathname;
    return PUBLIC_PAGES.some(p => path.includes(p)) || path === "/";
  }

  function redirectToDashboard() {
    if (!window.location.pathname.includes("dashboard.html")) {
      window.location.href = PRIVATE_PAGE;
    }
  }

  function redirectToLogin() {
    if (!isPublicPage()) {
      window.location.href = "/login.html";
    }
  }

  function initAuthGuard() {
    const token = getToken();

    if (token) {
      // Usuario autenticado
      redirectToDashboard();
    } else {
      // No autenticado
      redirectToLogin();
    }
  }

  document.addEventListener("DOMContentLoaded", initAuthGuard);
})();
</script>
