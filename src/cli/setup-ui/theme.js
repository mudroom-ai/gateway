// Apply before the stylesheet loads, including when storage is unavailable.
(() => {
  const key = "gateway-theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const read = () => {
    try {
      const saved = localStorage.getItem(key);
      if (saved === "light" || saved === "dark") return saved;
    } catch { /* Storage is optional. */ }
    return "system";
  };
  let theme = read();
  const apply = () => {
    document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
    const trigger = document.querySelector("#theme-trigger");
    if (!trigger) return;
    trigger.setAttribute("aria-label", `Color theme: ${theme}`);
    document.querySelector("#theme-label").textContent = theme[0].toUpperCase() + theme.slice(1);
    trigger.dataset.themeChoice = theme;
    for (const input of document.querySelectorAll('input[name="theme"]')) input.checked = input.value === theme;
  };
  apply();
  media.addEventListener("change", apply);
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) { theme = read(); apply(); }
  });
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    const menu = document.querySelector("#theme-menu");
    menu.addEventListener("change", (event) => {
      theme = event.target.value;
      try { localStorage.setItem(key, theme); } catch { /* Keep the in-memory choice. */ }
      apply();
    });
  });
})();
