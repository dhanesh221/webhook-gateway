const form = document.getElementById("login-form");
const passwordInput = document.getElementById("password");
const submit = document.getElementById("submit");
const msg = document.getElementById("msg");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  msg.textContent = "";
  msg.className = "msg";
  submit.disabled = true;

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordInput.value }),
    });

    if (res.ok) {
      window.location.replace("/dashboard.html");
      return;
    }

    const body = await res.json().catch(() => ({}));
    msg.textContent = body.error || "Sign in failed.";
    msg.className = "msg error";
    passwordInput.value = "";
    passwordInput.focus();
  } catch {
    msg.textContent = "Could not reach the server.";
    msg.className = "msg error";
  } finally {
    submit.disabled = false;
  }
});
