// public/js/withdraw.js
document.addEventListener("DOMContentLoaded", () => {
  // =========================
  // RETIRO
  // =========================
  const withdrawForm = document.querySelector("#withdrawPanel form");
  if (!withdrawForm) {
    console.error("❌ FORMULARIO DE RETIRO NO EXISTE");
  } else {
    withdrawForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const amount = document.getElementById("tx-amount-withdraw").value.trim();
      const account = document.getElementById("tx-account-withdraw").value.trim();

      if (!amount || !account) {
        alert("Por favor completa todos los campos");
        return;
      }

      const formData = new FormData();
      formData.append("amount", amount);
      formData.append("account", account);

      // Si hay archivo adjunto (opcional)
      const proofInput = document.getElementById("tx-proof-withdraw");
      if (proofInput && proofInput.files.length > 0) {
        formData.append("proof", proofInput.files[0]);
      }

      try {
        const res = await fetch("/api/withdraws", {
          method: "POST",
          body: formData,
          headers: {
            "Authorization": "Bearer " + (localStorage.getItem("token") || "")
          }
        });

        const data = await res.json();
        console.log("📩 RESPUESTA RETIRO:", data);

        if (!res.ok) {
          alert(data?.message || "Error enviando retiro");
          return;
        }

        alert("Retiro enviado correctamente");
        withdrawForm.reset();
      } catch (err) {
        console.error("❌ ERROR RETIRO:", err);
        alert("Error enviando retiro");
      }
    });
  }

  // =========================
  // DOCUMENTOS
  // =========================
  const verificationForm = document.querySelector("#verificationPanel form");
  if (!verificationForm) {
    console.error("❌ FORMULARIO DE DOCUMENTOS NO EXISTE");
  } else {
    verificationForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const docType = document.getElementById("doc-type").value;
      const docFile = document.getElementById("doc-file").files[0];

      if (!docFile) {
        alert("Por favor selecciona un archivo");
        return;
      }

      const formData = new FormData();
      formData.append("type", docType);
      formData.append("document", docFile);

      try {
        const res = await fetch("/api/documents", {
          method: "POST",
          body: formData,
          headers: {
            "Authorization": "Bearer " + (localStorage.getItem("token") || "")
          }
        });

        const data = await res.json();
        console.log("📩 RESPUESTA DOCUMENTO:", data);

        if (!res.ok) {
          alert(data?.message || "Error subiendo documento");
          return;
        }

        alert("Documento subido correctamente");
        verificationForm.reset();
      } catch (err) {
        console.error("❌ ERROR DOCUMENTO:", err);
        alert("Error subiendo documento");
      }
    });
  }
});
