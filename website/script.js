(function () {
  "use strict";

  var prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  // ---- Scroll reveal ----
  var revealEls = document.querySelectorAll(".reveal");
  if (!prefersReducedMotion && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    revealEls.forEach(function (el) {
      io.observe(el);
    });
  } else {
    revealEls.forEach(function (el) {
      el.classList.add("is-visible");
    });
  }

  // ---- Hero editor mock: live attribution scan ----
  var lines = document.querySelectorAll("#editor-lines .eline");
  if (!lines.length) return;

  function applyState(el) {
    var state = el.getAttribute("data-state");
    el.classList.add("eline--" + state);
  }

  if (prefersReducedMotion) {
    lines.forEach(applyState);
    return;
  }

  var counts = { ai: 0, human: 0, unknown: 0 };
  var total = lines.length;
  var pctAi = document.getElementById("pct-ai");
  var pctHuman = document.getElementById("pct-human");
  var pctUnknown = document.getElementById("pct-unknown");

  function updateStatusBar() {
    var done = counts.ai + counts.human + counts.unknown;
    if (!done) return;
    if (pctAi) pctAi.textContent = Math.round((counts.ai / done) * 100) + "%";
    if (pctHuman)
      pctHuman.textContent = Math.round((counts.human / done) * 100) + "%";
    if (pctUnknown)
      pctUnknown.textContent = Math.round((counts.unknown / done) * 100) + "%";
  }

  function runScan() {
    counts = { ai: 0, human: 0, unknown: 0 };
    lines.forEach(function (el) {
      el.className = "eline";
    });
    if (pctAi) pctAi.textContent = "—";
    if (pctHuman) pctHuman.textContent = "—";
    if (pctUnknown) pctUnknown.textContent = "—";

    lines.forEach(function (el, i) {
      setTimeout(function () {
        var state = el.getAttribute("data-state");
        applyState(el);
        counts[state] = (counts[state] || 0) + 1;
        updateStatusBar();
      }, i * 220 + 300);
    });
  }

  var mock = document.getElementById("editor-mock");
  var hasRun = false;
  if ("IntersectionObserver" in window) {
    var mockIo = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && !hasRun) {
            hasRun = true;
            runScan();
          }
        });
      },
      { threshold: 0.4 }
    );
    if (mock) mockIo.observe(mock);
  } else {
    runScan();
  }
})();
