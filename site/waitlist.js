// "Tell me when it's out" on a project's page: an email, Cloudflare's human check and consent, then
// "check your email". The sign-up service checks everything again itself; this only keeps the
// form friendly.
(() => {
  const root = document.getElementById("waitlist");
  if (!root) return;
  const form = document.getElementById("waitlist-form");
  const done = document.getElementById("waitlist-done");
  const error = document.getElementById("waitlist-error");
  let widget = null;

  const MESSAGES = {
    "bad-email": "That email doesn't look right. Check it has an @ and ends like .com.",
    "need-consent": "Tick the box, so we can email you when it's out.",
    "human-check": "The \"are you human\" check didn't go through. Try it again.",
    "too-many": "Too many tries for now. Wait a while, then try again.",
    busy: "We're sending a lot of emails right now. Try again tomorrow.",
    mail: "We couldn't send your confirmation email just now. Try again in a few minutes.",
  };
  const say = (code) => {
    error.textContent = MESSAGES[code] || "Something went wrong. Try again in a minute.";
    error.hidden = false;
  };

  // An email that looks like a typo ("gmail.con"): offer the likely address, one tap to use it.
  const offerFix = (suggestion) => {
    const use = document.createElement("button");
    use.type = "button";
    use.className = "link-button";
    use.textContent = `Use ${suggestion}`;
    use.addEventListener("click", () => {
      form.email.value = suggestion;
      error.hidden = true;
      form.email.focus();
    });
    error.replaceChildren(`Did you mean ${suggestion}? `, use);
    error.hidden = false;
  };
  // site/email-check.js; if it didn't load, the service still checks.
  const emailProblem = (email) =>
    window.IgnisEmail
      ? window.IgnisEmail.emailProblem(email)
      : /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)
        ? null
        : { error: "bad-email" };
  const showEmailProblem = (problem) => (problem.error === "email-typo" ? offerFix(problem.suggestion) : say(problem.error));

  // The human check, drawn once its script has loaded.
  const drawCheck = () => {
    if (widget !== null || !window.turnstile) return;
    widget = window.turnstile.render("#turnstile", { sitekey: root.dataset.sitekey, theme: "dark" });
  };
  window.addEventListener("load", drawCheck);
  const waitForCheck = setInterval(() => {
    drawCheck();
    if (widget !== null) clearInterval(waitForCheck);
  }, 300);

  form.email.addEventListener("blur", () => {
    const value = form.email.value.trim();
    const issue = value ? emailProblem(value) : null;
    if (issue) showEmailProblem(issue);
    else if (!error.hidden && error.querySelector(".link-button")) error.hidden = true;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    const email = form.email.value.trim();
    const issue = emailProblem(email);
    if (issue) return showEmailProblem(issue);
    if (!form.consent.checked) return say("need-consent");
    const turnstile = window.turnstile && widget !== null ? window.turnstile.getResponse(widget) : "";
    if (!turnstile) return say("human-check");
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const response = await fetch(`${root.dataset.service}/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: root.dataset.project, email, consent: true, turnstile, website: form.website.value }),
      });
      const result = await response.json().catch(() => ({ ok: false, error: "server" }));
      if (!result.ok) {
        if (result.error === "email-typo" || result.error === "bad-email") return showEmailProblem(result);
        return say(result.error);
      }
      document.getElementById("waitlist-done-email").textContent = email;
      form.hidden = true;
      done.hidden = false;
    } catch {
      say("server");
    } finally {
      button.disabled = false;
      if (window.turnstile && widget !== null) window.turnstile.reset(widget);
    }
  });
})();
