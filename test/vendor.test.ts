// The vendored ergo-lib-wasm 0.29.0 (vendor/ergo-lib-wasm-0.29.0-688511df/): the installed .wasm of each binding is
// the one whose sha256 the vendor README records, and package.json installs exactly those tarballs. npm ci checks
// each tarball against package-lock.json's integrity; this checks the binary the page ships against the record.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = "vendor/ergo-lib-wasm-0.29.0-688511df";
const readme = readFileSync(`${DIR}/README.md`, "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** `| tarball | package@version | built from | sha256 |` rows of the README's table. */
const rows = [...readme.matchAll(/^\| `([^`]+\.tgz)` \| `([^`@]+)@([^`]+)` \| [^|]+ \| `([0-9a-f]{64})` \|$/gm)].map(
  ([, tarball, name, version, sha256]) => ({ tarball, name, version, sha256 }),
);
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("vendored ergo-lib-wasm", () => {
  it("the README records both bindings", () => {
    expect(rows.map((r) => r.name).sort()).toEqual(["ergo-lib-wasm-browser", "ergo-lib-wasm-nodejs"]);
  });

  for (const r of rows)
    it(`${r.name}: package.json installs ${r.tarball}, and its installed .wasm has the recorded sha256`, () => {
      expect({ ...pkg.dependencies, ...pkg.devDependencies }[r.name]).toBe(`file:${DIR}/${r.tarball}`);
      const installed = JSON.parse(readFileSync(`node_modules/${r.name}/package.json`, "utf8")) as { version: string };
      expect(installed.version).toBe(r.version);
      expect(sha256(`node_modules/${r.name}/ergo_lib_wasm_bg.wasm`)).toBe(r.sha256);
    });
});
