// A listing container's states while its tab reads the explorer: loading (showing the explorer's retry status for as
// long as it lasts), failed (the reason and a retry button), loaded. In place of a silent empty table.
import { err } from "./dom";
import type { Store } from "./store";

export interface Listing {
  /** Show the loading text (the explorer's retrying state while it lasts). */
  start(): void;
  /** The tab rendered its own content. */
  done(): void;
  /** Show why, with a retry button. */
  fail(e: unknown): void;
}

export function listing(store: Store, el: HTMLElement, retry: () => void): Listing {
  let loading = false;
  const render = () => {
    if (loading) el.textContent = store.explorerLabel();
  };
  store.subscribe("explorer", render);
  return {
    start() {
      loading = true;
      render();
    },
    done() {
      loading = false;
    },
    fail(e) {
      loading = false;
      const b = document.createElement("button");
      b.textContent = "retry";
      b.onclick = retry;
      el.replaceChildren(`explorer unavailable (${err(e)}) `, b);
    },
  };
}
