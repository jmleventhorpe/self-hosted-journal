(() => {
  // Login / first-run setup page. Settings come from data attributes on the
  // form, so the page needs no inline script (the Content-Security-Policy in
  // app.py only allows scripts served as files from this server).
  const form = document.getElementById("auth-form");
  const INITIALIZED = form.dataset.initialized === "true";
  const MIN_PASSWORD_LENGTH = Number(form.dataset.minPasswordLength);
  const errorEl = document.getElementById("error");
  const submitBtn = form.querySelector("button[type=submit]");
  const submitLabel = submitBtn.textContent;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.textContent = "";
    const password = document.getElementById("password").value;

    if (!INITIALIZED) {
      const confirm = document.getElementById("password2").value;
      // Spread counts characters as Python's len() does, so an emoji
      // isn't counted twice here and then rejected by the server.
      if ([...password].length < MIN_PASSWORD_LENGTH) {
        errorEl.textContent = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
        return;
      }
      if (password !== confirm) {
        errorEl.textContent = "Passwords don't match.";
        return;
      }
    }

    // Deriving the key takes a noticeable moment - show that something
    // is happening, and stop a second click sending it again.
    submitBtn.disabled = true;
    submitBtn.textContent = INITIALIZED ? "Unlocking…" : "Creating…";
    const endpoint = INITIALIZED ? "/login" : "/api/setup";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        window.location.href = "/"; // button stays disabled until the page changes
        return;
      }
      errorEl.textContent = data.error || "Something went wrong.";
    } catch (err) {
      errorEl.textContent = "Couldn't reach the server - check your connection.";
    }
    submitBtn.disabled = false;
    submitBtn.textContent = submitLabel;
    document.getElementById("password").select();
  });
})();
