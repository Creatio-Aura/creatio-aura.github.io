// The links in our emails point here, on creatio-aura.com, never at the sign-up service's own
// workers.dev address: that's a shared domain spam filters distrust (2026-11-09). Each page under
// /beta/ and /waitlist/ that loads this passes the visitor straight on to the service, with their link's
// token. Only these paths, and only a plain token, so the page can't be used to send anyone elsewhere.
(function () {
  var SERVICE = "https://creatio-aura-beta.creatio-aura.workers.dev";
  var PATHS = ["/confirm", "/leave", "/approve", "/play-added", "/waitlist/confirm", "/waitlist/leave"];
  var to = document.body.getAttribute("data-to");
  var t = new URLSearchParams(location.search).get("t") || "";
  if (PATHS.indexOf(to) >= 0 && /^[A-Za-z0-9._-]{8,200}$/.test(t)) {
    location.replace(SERVICE + to + "?t=" + encodeURIComponent(t));
    return;
  }
  var note = document.getElementById("pass-note");
  if (note) note.textContent = "This link doesn't look complete. Try opening it from the email again, or reply to that email and we'll help.";
})();
