// @vitest-environment happy-dom
// The page carries no inline handlers or scripts, and no source file reaches for innerHTML.
import { describe, expect, it } from "vitest";
import HTML from "../../index.html?raw";

// every source file under src/, as text
const sources = import.meta.glob("../../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

describe("index.html", () => {
  it("has no on* attribute and no inline script, and sets a Content-Security-Policy", () => {
    document.open();
    document.write(HTML.replace(/<script[^>]*><\/script>/g, ""));
    document.close();
    // the scripts, from the source text: each must load a file and carry no inline code
    const scripts = [...HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBe(1);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc="[^"]+"/);
      expect(body.trim()).toBe("");
    }
    const offenders: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      for (const a of el.getAttributeNames())
        if (a.toLowerCase().startsWith("on")) offenders.push(`${el.tagName.toLowerCase()}[${a}]`);
      if (el.tagName === "A" && (el.getAttribute("href") ?? "").toLowerCase().startsWith("javascript:"))
        offenders.push("javascript: link");
    }
    expect(offenders).toEqual([]);
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it("no source file assigns innerHTML or outerHTML, or uses document.write", () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(20);
    const hits = files.filter((f) => /innerHTML|outerHTML|document\.write|insertAdjacentHTML/.test(sources[f]));
    expect(hits).toEqual([]);
    expect(HTML).not.toMatch(/innerHTML/);
  });
});
