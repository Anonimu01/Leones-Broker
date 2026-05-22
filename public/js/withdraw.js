/* =========================================================
   🔥 WITHDRAW SYSTEM
   ========================================================= */
document.addEventListener("DOMContentLoaded", () => {

  const withdrawForm =
    document.getElementById("withdrawForm") ||
    document.getElementById("retiroForm") ||
    document.querySelector(".withdraw-form") ||
    document.querySelector("form[data-withdraw]");

  if (!withdrawForm) {
    console.error("❌ FORMULARIO DE RETIRO NO EXISTE");
    return;
  }

  console.log("✅ Withdraw form detectado");

  withdrawForm.addEventListener("submit", async (e) => {

    e.preventDefault();

    try {

      const amount =
        document.getElementById("withdrawAmount")?.value ||
        document.getElementById("amount")?.value ||
        "";

      const method =
        document.getElementById("withdrawMethod")?.value ||
        document.getElementById("method")?.value ||
        "";

      const wallet =
        document.getElementById("withdrawWallet")?.value ||
        document.getElementById("wallet")?.value ||
        "";

      const bank =
        document.getElementById("withdrawBank")?.value ||
        document.getElementById("bank")?.value ||
        "";

      const note =
        document.getElementById("withdrawNote")?.value ||
        "";

      const proofInput =
        document.getElementById("withdrawProof") ||
        document.getElementById("proof") ||
        document.querySelector('input[type="file"]');

      const proofFile =
        proofInput?.files?.[0] || null;

      if (!amount) {
        alert("Monto requerido");
        return;
      }

      const fd = new FormData();

      fd.append("amount", amount);
      fd.append("method", method);
      fd.append("wallet", wallet);
      fd.append("bank", bank);
      fd.append("note", note);

      if (proofFile) {
        fd.append("proof", proofFile);
      }

      console.log("📦 FormData listo");

      const token =
        localStorage.getItem("token") ||
        localStorage.getItem("BROKER_TOKEN") ||
        "";

      console.log("🚀 Enviando retiro...");

      const res = await fetch("/api/withdraws", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token
        },
        body: fd
      });

      const data = await res.json();

      console.log("📩 RESPUESTA:", data);

      if (!res.ok) {
        alert(data.message || "Error enviando retiro");
        return;
      }

      alert("✅ Retiro enviado");

      withdrawForm.reset();

    } catch (err) {

      console.error("❌ ERROR RETIRO:", err);

      alert("Error de conexión");
    }

  });

});
