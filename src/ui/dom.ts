// DOM helpers shared by the tabs. Everything that reaches the page is a text node: token names, addresses and
// error messages come from the chain or a wallet and are never parsed as HTML.

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** A table cell from text only. */
export function td(text: string, cls?: string): HTMLTableCellElement {
  const el = document.createElement("td");
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

/** A cell showing a shortened id or address with the full one as a tooltip, plus optional trailing text. */
export function tdCode(full: string, short: string, suffix = ""): HTMLTableCellElement {
  const el = document.createElement("td");
  const code = document.createElement("code");
  code.title = full;
  code.textContent = short;
  el.append(code, suffix);
  return el;
}

export function thead(table: HTMLTableElement, heads: string[]) {
  const h = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const t of heads) {
    const th = document.createElement("th");
    th.textContent = t;
    tr.append(th);
  }
  h.append(tr);
  table.append(h);
}

/** A definition list of label/value rows, replacing what was there. */
export function dl(el: HTMLDListElement, rows: [string, string][]) {
  el.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    el.append(dt, dd);
  }
}

/** A heading element with text. */
export function h(tag: "h2" | "h3", text: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

/** A table with a header row and a body of rows. */
export function table(heads: string[], rows: HTMLTableRowElement[]): HTMLTableElement {
  const t = document.createElement("table");
  thead(t, heads);
  const tb = document.createElement("tbody");
  tb.append(...rows);
  t.append(tb);
  return t;
}

export function log(msg: string) {
  const logEl = $<HTMLDivElement>("log");
  logEl.textContent = `${new Date().toISOString().slice(11, 19)} ${msg}\n` + logEl.textContent;
}

export const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A select option with text and value. */
export function option(text: string, value: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.textContent = text;
  o.value = value;
  return o;
}
