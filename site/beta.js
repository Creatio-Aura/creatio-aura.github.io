// A beta sign-up, on Ignis Aura's or Effugium Aura's page (the form's data-project says which):
// an email, where they'd play, the consent box and Cloudflare's human check, then "check your
// email". Confirming by email puts them in line, and we let each one in. The sign-up service
// checks everything again itself; this only keeps the form friendly.
(() => {
  const root = document.getElementById("beta-signup");
  if (!root) return;
  const form = document.getElementById("beta-form");
  const done = document.getElementById("beta-done");
  const error = document.getElementById("beta-error");
  let widget = null;

  // Where this visitor came from, as a short code kept with the sign-up (Andrew, 2026-11-07: count it
  // ourselves, no analytics): the ?from= a link put on this page ("web_jb_<post>" from a Journal post's
  // button), else the site they arrived from ("ref_google", "ref_journal_<post>"), else "direct". Never
  // the full address. Worked out once, when the page opens.
  const source = (() => {
    const from = new URLSearchParams(location.search).get("from") || "";
    if (/^[a-z0-9_]{1,80}$/.test(from)) return from;
    let ref;
    try {
      ref = document.referrer ? new URL(document.referrer) : null;
    } catch (e) {
      ref = null;
    }
    if (!ref) return "direct";
    const clean = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
    if (ref.hostname === location.hostname) {
      const page = clean(ref.pathname);
      return page && page !== clean(location.pathname) ? `ref_${page}` : "direct";
    }
    const host = ref.hostname.replace(/^(www|m|l|lm)\./, "");
    const known = { "google.": "google", "bing.com": "bing", "duckduckgo.com": "duckduckgo", "facebook.com": "facebook", "linkedin.com": "linkedin", "chatgpt.com": "chatgpt", "perplexity.ai": "perplexity", "claude.ai": "claude" };
    for (const [match, name] of Object.entries(known)) if (host.startsWith(match) || host === match || host.endsWith("." + match)) return `ref_${name}`;
    return `ref_${clean(host)}`;
  })();

  const MESSAGES = {
    "human-check": "The \"are you human\" check didn't go through. Try it again.",
    "too-many": "Too many tries for now. Wait a while, then try again.",
    "bad-email": "That email doesn't look right. Check it has an @ and ends like .com.",
    "pick-platform": "Tick at least one of the boxes above: where you'd use it.",
    "need-consent": "Tick the box, so we can email you about the beta.",
    busy: "We're sending a lot of emails right now. Try again tomorrow.",
    mail: "We couldn't send your confirmation email just now. Try again in a few minutes.",
  };
  const say = (code) => {
    error.textContent = MESSAGES[code] || "Something went wrong. Try again in a minute.";
    error.hidden = false;
  };

  // An email that looks like a typo ("gmail.con"): offer the likely address, one tap to use it.
  const emailField = () => form.email;
  const offerFix = (suggestion) => {
    const use = document.createElement("button");
    use.type = "button";
    use.className = "link-button";
    use.textContent = `Use ${suggestion}`;
    use.addEventListener("click", () => {
      emailField().value = suggestion;
      error.hidden = true;
      emailField().focus();
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

  // Leaving the email box: a gentle check straight away, before they reach the button.
  emailField().addEventListener("blur", () => {
    const value = emailField().value.trim();
    const issue = value ? emailProblem(value) : null;
    if (issue) showEmailProblem(issue);
    else if (!error.hidden && error.querySelector(".link-button")) error.hidden = true;
  });

  // Ticking a box answers "pick one": the message goes (a typo offer stays).
  form.addEventListener("change", (event) => {
    if (event.target.name === "platforms" && !error.querySelector(".link-button")) error.hidden = true;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    const platforms = [...form.querySelectorAll('input[name="platforms"]:checked')].map((input) => input.value);
    const details = {
      project: root.dataset.project,
      email: form.email.value.trim(),
      platforms,
      consent: form.consent.checked,
      website: form.website.value,
      source,
      turnstile: window.turnstile && widget !== null ? window.turnstile.getResponse(widget) : "",
    };
    const emailIssue = emailProblem(details.email);
    if (emailIssue) return showEmailProblem(emailIssue);
    if (platforms.length === 0) return say("pick-platform");
    if (!details.consent) return say("need-consent");
    if (!details.turnstile) return say("human-check");
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const response = await fetch(`${root.dataset.service}/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(details),
      });
      const result = await response.json().catch(() => ({ ok: false, error: "server" }));
      if (!result.ok) {
        if (result.error === "email-typo" || result.error === "bad-email") return showEmailProblem(result);
        return say(result.error);
      }
      document.getElementById("beta-done-email").textContent = details.email;
      form.hidden = true;
      done.hidden = false;
      done.focus?.();
    } catch {
      say("server");
    } finally {
      button.disabled = false;
      if (window.turnstile && widget !== null) window.turnstile.reset(widget);
    }
  });
})();
