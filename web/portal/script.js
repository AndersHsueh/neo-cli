(() => {
  "use strict";

  const feedbackTimers = new WeakMap();

  function selectCode(code) {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Copy unavailable");
  }

  function initCopyButtons() {
    document.querySelectorAll("button[data-copy-target]").forEach((button) => {
      const targetId = button.getAttribute("data-copy-target");
      const code = targetId ? document.getElementById(targetId) : null;
      if (!code) return;

      const figure = button.closest("figure");
      const feedback = figure ? figure.querySelector("[data-copy-feedback]") : null;

      button.addEventListener("click", async () => {
        if (!feedback) return;
        const previousTimer = feedbackTimers.get(feedback);
        if (previousTimer) window.clearTimeout(previousTimer);

        try {
          await copyText(code.textContent.trim());
          feedback.textContent = "已复制";
        } catch (_error) {
          selectCode(code);
          feedback.textContent = "复制失败，请手动选择";
        }

        const timer = window.setTimeout(() => {
          feedback.textContent = "";
        }, 2500);
        feedbackTimers.set(feedback, timer);
      });

      button.hidden = false;
    });
  }

  function initMatrixRain() {
    const canvas = document.querySelector(".matrix-rain");
    const hero = document.querySelector(".hero");
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!canvas || !hero || typeof window.requestAnimationFrame !== "function") return;

    const context = canvas.getContext("2d");
    if (!context || typeof window.IntersectionObserver !== "function") return;

    const glyphs = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ<>/{}[]#$+-*";
    const frameInterval = 1000 / 24;
    const fontSize = 16;
    const tailLength = 7;
    let width = 0;
    let height = 0;
    let columns = [];
    let frameId = 0;
    let resizeTimer = 0;
    let lastFrame = 0;
    let running = false;
    let heroVisible = false;

    function resizeCanvas() {
      const rect = hero.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.font = `${fontSize}px ui-monospace, monospace`;
      context.textBaseline = "top";
      context.fillStyle = "#66f2a3";

      const limit = width < 768 ? 24 : 36;
      const count = Math.max(1, Math.min(limit, Math.floor(width / 22)));
      const spacing = width / count;
      columns = Array.from({ length: count }, (_, index) => ({
        x: spacing * index + spacing / 2,
        head: Math.random() * (height / fontSize + tailLength),
        speed: 0.22 + Math.random() * 0.24,
        offset: Math.floor(Math.random() * glyphs.length)
      }));
      context.clearRect(0, 0, width, height);
    }

    function draw() {
      context.clearRect(0, 0, width, height);
      const rows = Math.ceil(height / fontSize) + tailLength;

      columns.forEach((column, columnIndex) => {
        column.head = (column.head + column.speed) % rows;
        for (let tail = 0; tail < tailLength; tail += 1) {
          const row = Math.floor(column.head) - tail;
          if (row < 0 || row * fontSize > height) continue;
          const glyphIndex = (column.offset + row * 7 + columnIndex * 11) % glyphs.length;
          context.globalAlpha = Math.max(0.16, 1 - tail / tailLength);
          context.fillText(glyphs[glyphIndex], column.x, row * fontSize);
        }
      });
      context.globalAlpha = 1;
    }

    function frame(timestamp) {
      frameId = 0;
      if (!running) return;
      if (timestamp - lastFrame >= frameInterval) {
        draw();
        lastFrame = timestamp;
      }
      frameId = window.requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
      if (frameId) window.cancelAnimationFrame(frameId);
      frameId = 0;
    }

    function sync() {
      const shouldRun = !motionQuery.matches && heroVisible && document.visibilityState === "visible";
      if (shouldRun && !running) {
        running = true;
        lastFrame = 0;
        frameId = window.requestAnimationFrame(frame);
      } else if (!shouldRun) {
        stop();
      }
    }

    resizeCanvas();
    canvas.dataset.ready = "true";

    const observer = new IntersectionObserver((entries) => {
      heroVisible = entries.some((entry) => entry.isIntersecting);
      sync();
    }, { threshold: 0 });
    observer.observe(hero);

    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", sync);
    motionQuery.addEventListener("change", sync);
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resizeCanvas, 120);
    }, { passive: true });
  }

  try {
    initCopyButtons();
    initMatrixRain();
    document.documentElement.classList.add("js");
  } catch (_error) {
    document.querySelectorAll(".matrix-rain").forEach((canvas) => {
      canvas.dataset.ready = "false";
    });
  }
})();
