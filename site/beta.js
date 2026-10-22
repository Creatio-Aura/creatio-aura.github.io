// The Ignis Aura beta sign-up, in three steps: the invite code (with Cloudflare's human check), then
// name, email and where they'd play, then "check your email". The sign-up service checks
// everything again itself; this only keeps the form friendly.
(() => {
  const root = document.getElementById("beta-signup");
  if (!root) return;
  const stepCode = document.getElementById("step-code");
  const stepDetails = document.getElementById("step-details");
  const stepDone = document.getElementById("step-done");
  const codeError = document.getElementById("code-error");
  const detailsError = document.getElementById("details-error");
  let pass = null;
  let widget = null;

  const MESSAGES = {
    "bad-code": "That code isn't right. Check it with whoever invited you.",
    "human-check": "The \"are you human\" check didn't go through. Try it again.",
    "too-many": "Too many tries for now. Wait a while, then try again.",
    "expired-pass": "That took a while, so the form closed. Enter your invite code again.",
    "bad-name": "Add your name (up to 60 characters).",
    "bad-email": "That email doesn't look right. Check it has an @ and ends like .com.",
    "pick-platform": "Pick at least one place you'd play.",
    "need-consent": "Tick the box so we can email you about the beta.",
    busy: "We're sending a lot of emails right now. Try again tomorrow.",
    mail: "We couldn't send your confirmation email just now. Try again in a few minutes.",
  };
  const say = (element, error) => {
    element.textContent = MESSAGES[error] || "Something went wrong. Try again in a minute.";
    element.hidden = false;
  };

  // An email that looks like a typo ("gmail.con"): offer the likely address, one tap to use it.
  const emailField = () => stepDetails.email;
  const offerFix = (suggestion) => {
    const use = document.createElement("button");
    use.type = "button";
    use.className = "link-button";
    use.textContent = `Use ${suggestion}`;
    use.addEventListener("click", () => {
      emailField().value = suggestion;
      detailsError.hidden = true;
      emailField().focus();
    });
    detailsError.replaceChildren(`Did you mean ${suggestion}? `, use);
    detailsError.hidden = false;
  };
  // site/email-check.js; if it didn't load, the service still checks.
  const emailProblem = (email) =>
    window.IgnisEmail
      ? window.IgnisEmail.emailProblem(email)
      : /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)
        ? null
        : { error: "bad-email" };
  const showEmailProblem = (problem) =>
    problem.error === "email-typo" ? offerFix(problem.suggestion) : say(detailsError, problem.error);

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

  const call = async (path, body) => {
    const response = await fetch(`${root.dataset.service}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json().catch(() => ({ ok: false, error: "server" }));
  };
  const busy = (form, on) => {
    form.querySelector("button").disabled = on;
  };

  stepCode.addEventListener("submit", async (event) => {
    event.preventDefault();
    codeError.hidden = true;
    const code = stepCode.code.value.trim();
    if (!code) return say(codeError, "bad-code");
    const turnstile = window.turnstile && widget !== null ? window.turnstile.getResponse(widget) : "";
    if (!turnstile) return say(codeError, "human-check");
    busy(stepCode, true);
    try {
      const result = await call("/check-code", { code, turnstile });
      if (!result.ok) return say(codeError, result.error);
      pass = result.pass;
      stepCode.hidden = true;
      stepDetails.hidden = false;
      document.getElementById("name").focus();
    } catch {
      say(codeError, "server");
    } finally {
      busy(stepCode, false);
      if (window.turnstile && widget !== null) window.turnstile.reset(widget);
    }
  });

  // Leaving the email box: a gentle check straight away, before they reach the button.
  emailField().addEventListener("blur", () => {
    const value = emailField().value.trim();
    const issue = value ? emailProblem(value) : null;
    if (issue) showEmailProblem(issue);
    else if (!detailsError.hidden && detailsError.querySelector(".link-button")) detailsError.hidden = true;
  });

  stepDetails.addEventListener("submit", async (event) => {
    event.preventDefault();
    detailsError.hidden = true;
    const platforms = [...stepDetails.querySelectorAll('input[name="platforms"]:checked')].map((input) => input.value);
    const details = {
      pass,
      name: document.getElementById("name").value.trim(),
      email: stepDetails.email.value.trim(),
      platforms,
      consent: stepDetails.consent.checked,
      website: stepDetails.website.value,
    };
    if (!details.name) return say(detailsError, "bad-name");
    const emailIssue = emailProblem(details.email);
    if (emailIssue) return showEmailProblem(emailIssue);
    if (platforms.length === 0) return say(detailsError, "pick-platform");
    if (!details.consent) return say(detailsError, "need-consent");
    busy(stepDetails, true);
    try {
      const result = await call("/signup", details);
      if (!result.ok) {
        if (result.error === "expired-pass") {
          stepDetails.hidden = true;
          stepCode.hidden = false;
          return say(codeError, "expired-pass");
        }
        if (result.error === "email-typo" || result.error === "bad-email") return showEmailProblem(result);
        return say(detailsError, result.error);
      }
      document.getElementById("done-email").textContent = details.email;
      stepDetails.hidden = true;
      stepDone.hidden = false;
      stepDone.focus?.();
    } catch {
      say(detailsError, "server");
    } finally {
      busy(stepDetails, false);
    }
  });
})();
