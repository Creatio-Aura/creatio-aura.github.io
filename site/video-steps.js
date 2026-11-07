// Recordings of the app with their steps listed beside them (the Effugium Aura tour, the tester guide's
// Send feedback). The step on screen is highlighted, a step can be picked to jump to it, and a button
// pauses. A video plays only while it's on screen, and never by itself with Reduce Motion on.
//
// <video id="v" data-steps="v-steps" [data-done="17.2"] muted loop playsinline ...>
// <ol id="v-steps" class="video-steps"><li><button type="button" data-at="0"><span class="n">1</span>...</button></li>...</ol>
// <button type="button" data-toggle="v" data-play="Play" data-pause="Pause">Play</button>
(() => {
  let still = false;
  try {
    still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {}

  document.querySelectorAll("video[data-steps]").forEach((video) => {
    const list = document.getElementById(video.dataset.steps);
    const toggle = document.querySelector(`[data-toggle="${video.id}"]`);
    const buttons = list ? Array.from(list.querySelectorAll("button[data-at]")) : [];
    const at = buttons.map((b) => parseFloat(b.dataset.at));
    const doneAt = video.dataset.done ? parseFloat(video.dataset.done) : null;
    let wanted = !still; // playing, unless the person paused it (or asked for less motion)

    video.muted = true;
    video.loop = true;
    video.playsInline = true;

    const play = () => {
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    };
    const label = () => {
      if (toggle) toggle.textContent = video.paused ? toggle.dataset.play : toggle.dataset.pause;
    };
    const mark = () => {
      const t = video.currentTime;
      let now = 0;
      at.forEach((a, k) => {
        if (t >= a) now = k;
      });
      const finished = doneAt !== null && t >= doneAt;
      buttons.forEach((b, k) => {
        if (k === now && !finished) b.setAttribute("aria-current", "step");
        else b.removeAttribute("aria-current");
        const done = doneAt !== null && (k < now || finished);
        b.classList.toggle("done", done);
        const n = b.querySelector(".n");
        if (n && doneAt !== null) n.textContent = done ? "✓" : String(k + 1);
      });
    };

    video.addEventListener("timeupdate", mark);
    video.addEventListener("play", label);
    video.addEventListener("pause", label);
    buttons.forEach((b, k) =>
      b.addEventListener("click", () => {
        video.currentTime = Math.max(0, at[k] - parseFloat(b.dataset.lead || "0"));
        wanted = true;
        play();
        mark();
      })
    );
    if (toggle)
      toggle.addEventListener("click", () => {
        wanted = video.paused;
        if (wanted) play();
        else video.pause();
      });

    // Only while on screen: it saves the battery, and the steps stay in step with what's seen.
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(
        (entries) =>
          entries.forEach((e) => {
            if (e.isIntersecting && wanted) play();
            else if (!e.isIntersecting) video.pause();
          }),
        { threshold: 0.25 }
      ).observe(video);
    } else if (wanted) play();

    label();
    mark();
  });
})();
