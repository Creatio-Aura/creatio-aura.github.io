// The fixed stars: decoration only, drawn into the .sky layer of each page. Each glitters at its
// own pace (still, for people who ask for reduced motion: see styles.css).
(() => {
  const sky = document.querySelector(".sky");
  if (!sky) return;
  // [left %, top px, size px, kind]
  const stars = [
    [6, 90, 3, "dot"], [14, 210, 2, "dot"], [9, 360, 12, "sparkle"], [22, 120, 2, "dot"], [30, 300, 3, "dot"],
    [36, 70, 10, "sparkle"], [44, 190, 2, "dot"], [58, 110, 3, "dot"], [64, 250, 2, "dot"], [71, 60, 14, "sparkle"],
    [78, 170, 3, "dot"], [86, 320, 2, "dot"], [93, 140, 11, "sparkle"], [97, 420, 3, "dot"], [3, 520, 2, "dot"],
    [18, 610, 10, "sparkle"], [27, 700, 2, "dot"], [52, 560, 2, "dot"], [74, 640, 3, "dot"], [89, 590, 12, "sparkle"],
    [8, 880, 3, "dot"], [33, 940, 2, "dot"], [61, 860, 9, "sparkle"], [82, 980, 2, "dot"], [95, 820, 3, "dot"],
    [12, 1460, 10, "sparkle"], [40, 1520, 2, "dot"], [68, 1480, 3, "dot"], [88, 1560, 11, "sparkle"], [50, 1420, 2, "dot"],
  ];
  const sparkle =
    '<svg viewBox="0 0 20 20" width="100%" height="100%"><path d="M10 0c.8 5.6 3.6 8.6 10 10-6.4 1.4-9.2 4.4-10 10-.8-5.6-3.6-8.6-10-10 6.4-1.4 9.2-4.4 10-10z" fill="#fff1d6"/></svg>';
  stars.forEach(([left, top, size, kind], i) => {
    const star = document.createElement("span");
    star.className = `star ${kind}`;
    star.style.cssText = `left:${left}%;top:${top}px;width:${size}px;height:${size}px;--t:${2.4 + (i % 5) * 0.7}s;--d:${((i * 0.37) % 3).toFixed(2)}s`;
    if (kind === "sparkle") star.innerHTML = sparkle;
    sky.appendChild(star);
  });
})();
