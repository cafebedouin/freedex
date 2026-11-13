// The contract registry (src/registry.json) as the modules read it: every tree and template hash the page builds
// against comes from here, so a change to a contract is a change to one file, and test/hashes.test.ts checks every
// entry against its bytes.
import registry from "./registry.json" with { type: "json" };

export interface RegistryEntry {
  protocol: string;
  what: string;
  /** tree: fixed bytes; template: bytes with {placeholder} constants; sdk: built at runtime, a sample kept; recipient: an address paid, never spent; data-input: read, never spent; parameterized: a sample tree whose named constants are replaced per box; context-var: bytes a spend passes in a context variable */
  kind: "tree" | "template" | "sdk" | "recipient" | "data-input" | "parameterized" | "context-var";
  network: string;
  tree?: string;
  template?: string;
  placeholders?: Record<string, string>;
  sampleTree?: string;
  /** parameterized: term name to its index among the sample tree's segregated constants */
  parameters?: Record<string, number>;
  /** context-var: the bytes, and their blake2b256 (what the script checks) */
  value?: string;
  blake2b256?: string;
  /** SHA-256 of the ErgoTree template, what the explorer's unspent search takes (none for a context-var) */
  templateSha256: string;
  nft?: string;
  source: Record<string, unknown>;
  licence: string;
  usedBy: string[];
  liveBoxCheckedOn: string | null;
}

export const REGISTRY: Record<string, RegistryEntry> = registry.contracts as unknown as Record<string, RegistryEntry>;

export function contract(id: string): RegistryEntry {
  const e = REGISTRY[id];
  if (!e) throw new Error(`registry: no contract "${id}"`);
  return e;
}

/** The fixed tree of an entry. */
export function treeOf(id: string): string {
  const e = contract(id);
  if (!e.tree) throw new Error(`registry: "${id}" has no fixed tree`);
  return e.tree;
}

export function hashOf(id: string): string {
  return contract(id).templateSha256;
}

/** A template's placeholders filled; refuses a missing one. */
export function fillTemplate(id: string, vars: Record<string, string>): string {
  const e = contract(id);
  if (!e.template) throw new Error(`registry: "${id}" is not a template`);
  return e.template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`registry: "${id}" needs {${k}}`);
    return v;
  });
}
