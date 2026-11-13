// The vendored ergo-lib-wasm 0.29.0 (vendor/ergo-lib-wasm-0.29.0-688511df/): the installed .wasm of each binding is
// the one whose sha256 the vendor README records, and package.json installs exactly those tarballs. npm ci checks
// each tarball against package-lock.json's integrity; this checks the binary the page ships against the record.
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import readme from "../vendor/ergo-lib-wasm-0.29.0-688511df/README.md?raw";

// the binary is read through Node's fs, loaded by name: the project's type set is the browser's (tsconfig "types")
const NODE_FS: string = "node:fs";
const fs = (await import(/* @vite-ignore */ NODE_FS)) as {
  readFileSync(path: string): Uint8Array<ArrayBuffer>;
  readFileSync(path: string, encoding: "utf8"): string;
};
const DIR = "vendor/ergo-lib-wasm-0.29.0-688511df";
const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };

/** `| tarball | package@version | built from | sha256 |` rows of the README's table. */
const rows = [...readme.matchAll(/^\| `([^`]+\.tgz)` \| `([^`@]+)@([^`]+)` \| [^|]+ \| `([0-9a-f]{64})` \|$/gm)].map(
  ([, tarball, name, version, sha256]) => ({ tarball, name, version, sha256 }),
);
const sha256 = async (path: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", fs.readFileSync(path)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

describe("vendored ergo-lib-wasm", () => {
  it("the README records both bindings", () => {
    expect(rows.map((r) => r.name).sort()).toEqual(["ergo-lib-wasm-browser", "ergo-lib-wasm-nodejs"]);
  });

  for (const r of rows)
    it(`${r.name}: package.json installs ${r.tarball}, and its installed .wasm has the recorded sha256`, async () => {
      expect(deps[r.name]).toBe(`file:${DIR}/${r.tarball}`);
      const installed = JSON.parse(fs.readFileSync(`node_modules/${r.name}/package.json`, "utf8")) as {
        version: string;
      };
      expect(installed.version).toBe(r.version);
      expect(await sha256(`node_modules/${r.name}/ergo_lib_wasm_bg.wasm`)).toBe(r.sha256);
    });
});
