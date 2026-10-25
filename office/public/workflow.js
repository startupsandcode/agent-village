"use strict";
(() => {
  const advance = document.getElementById("advance");
  const cancel = document.getElementById("cancel");
  const reset = document.getElementById("reset");
  const status = document.getElementById("mission-status");
  const message = document.getElementById("status-message");
  const counter = document.getElementById("retry-count");
  let failures = 0;
  let cancelled = false;
  function render(text) {
    message.textContent = text;
    counter.textContent = `Retries used: ${Math.max(0, failures - 1)} of 2.`;
    advance.disabled = cancelled || failures === 3;
    cancel.disabled = cancelled;
  }
  advance.addEventListener("click", () => {
    if (cancelled || failures >= 3) return;
    failures += 1;
    render(failures === 3
      ? "Retry limit reached. Maya must review the outcome before work continues."
      : `Check failed. Retry available: ${failures} of 2.`);
    if (advance.disabled) status.focus();
  });
  cancel.addEventListener("click", () => {
    if (cancelled) return;
    cancelled = true;
    render("Cancelled. No further attempts will run.");
    status.focus();
  });
  reset.addEventListener("click", () => {
    failures = 0;
    cancelled = false;
    render("Ready. This illustration allows two retries after an initial failed check.");
  });
})();
