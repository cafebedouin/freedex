// The header's explorer choice and the one-line status when the page is reading from a fallback backend.
import { EXPLORERS, storeExplorer, storedExplorer } from "../explorer";
import { $, option } from "./dom";
import type { Store } from "./store";

const host = (base: string) => base.replace(/^https:\/\//, "");

export function mountHeader(store: Store) {
  const explorer = store.explorer;
  const status = $<HTMLSpanElement>("explorer-status");
  const fallbackLine = () =>
    explorer.base === explorer.bases[0]
      ? ""
      : `reading from ${host(explorer.base)}: ${host(explorer.bases[0])} did not answer`;
  explorer.onBaseChange = () => {
    status.textContent = fallbackLine();
  };
  // while a request is being retried, or after every backend failed, say so on every tab (the header is shared)
  store.subscribe("explorer", () => {
    const s = store.explorerStatus;
    status.textContent = s && s.state !== "ok" ? store.explorerLabel() : fallbackLine();
  });

  const sel = $<HTMLSelectElement>("explorer-pick");
  for (const b of EXPLORERS) sel.append(option(host(b), b));
  const stored = storedExplorer();
  if (stored && !EXPLORERS.includes(stored)) sel.append(option(host(stored), stored));
  sel.append(option("other…", "__other__"));
  sel.value = explorer.base;
  sel.onchange = () => {
    let base = sel.value;
    if (base === "__other__") {
      const typed = window.prompt("Explorer API base URL (an Ergo explorer backend with /api/v1)", "https://");
      if (!typed || !/^https:\/\/[^\s/]+$/.test(typed.trim())) {
        sel.value = explorer.base;
        return;
      }
      base = typed.trim();
    }
    storeExplorer(base === EXPLORERS[0] ? undefined : base);
    location.reload();
  };
}
