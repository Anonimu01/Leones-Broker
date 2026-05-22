/* =========================================================
   🔥 WITHDRAW SYSTEM
   ========================================================= */

document.addEventListener("DOMContentLoaded", () => {

  const withdrawForm = document.getElementById("withdrawForm");

  if (!withdrawForm) {
    console.warn("❌ withdrawForm no encontrado");
    return;
  }

  console.log("✅ Withdraw JS cargado");

  withdrawForm.addEventListener("submit", async (e) => {

    e.preventDefault();

    try {

      // =====================================================
      // CAMPOS
      // =====================================================

      const amount =
        document.getElementById("withdrawAmount")?.value?.trim() || "";

      const method =
        document.getElementById("withdrawMethod")?.value?.trim() || "";

      const wallet =
        document.getElementById("withdrawWallet")?.value?.trim() || "";

      const bank =
        document.getElementById("withdrawBank")?.value?.trim() || "";

      const note =
        document.getElementById("withdrawNote")?.value?.trim() || "";

      const proofInput =
        document.getElementById("withdrawProof");

      const proofFile =
        proofInput?.files?.[0] || null;

      // =====================================================
      // VALIDACIÓN
      // =====================================================

      if (!amount || Number(amount) <= 0) {
        alert("Monto inválido");
        return;
      }

      if (!method) {
        alert("Selecciona método");
        return;
      }

      // =====================================================
      // FORMDATA
      // =====================================================

      const fd = new FormData();

      fd.append("amount", amount);
      fd.append("method", method);
      fd.append("wallet", wallet);
      fd.append("bank", bank);
      fd.append("note", note);

      if (proofFile) {
        fd.append("proof", proofFile);
      }

      // =====================================================
      // TOKEN
      // =====================================================

      const token =
        localStorage.getItem("token") ||
        localStorage.getItem("authToken") ||
        "";

      // =====================================================
      // BOTÓN
      // =====================================================

      const submitBtn =
        withdrawForm.querySelector('button[type="submit"]');

      const oldText = submitBtn?.innerHTML;

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = "Procesando...";
      }

      // =====================================================
      // FETCH
      // =====================================================

      console.log("🚀 Enviando retiro...");

      const res = await fetch("/api/withdraws", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token
        },
        body: fd
      });

      let data = {};

      try {
        data = await res.json();
      } catch {}

      console.log("📩 RESPUESTA:", data);

      // =====================================================
      // ERROR
      // =====================================================

      if (!res.ok) {

        console.error("❌ ERROR:", data);

        alert(
          data?.message ||
          data?.error ||
          "Error enviando retiro"
        );

        return;
      }

      // =====================================================
      // SUCCESS
      // =====================================================

      alert("✅ Solicitud enviada correctamente");

      withdrawForm.reset();

      if (typeof loadHistoryPanel === "function") {
        loadHistoryPanel();
      }

    } catch (err) {

      console.error("❌ withdraw error:", err);

      alert("Error de conexión");

    } finally {

      const submitBtn =
        withdrawForm.querySelector('button[type="submit"]');

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = "Enviar Retiro";
      }
    }

  });

});
