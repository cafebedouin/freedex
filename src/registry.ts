// The contract registry (src/registry.json) as the modules read it: every tree and template hash the page builds
// against comes from here, so a change to a contract is a change to one file, and test/hashes.test.ts checks every
// entry against its bytes.
import registry from "./registry.json" with { type: "json" };

export interface RegistryEntry {
  protocol: string;
  what: string;
  /** tree: fixed bytes; template: bytes with {placeholder} constants; sdk: built at runtime, a sample kept; recipient: an address paid, never spent; data-input: read, never spent */
  kind: "tree" | "template" | "sdk" | "recipient" | "data-input";
  network: string;
  tree?: string;
  template?: string;
  placeholders?: Record<string, string>;
  sampleTree?: string;
  /** SHA-256 of the ErgoTree template, what the explorer's unspent search takes */
  templateSha256: string;
  nft?: string;
  source: Record<string, unknown>;
  licence: string;
  usedBy: string[];
  liveBoxCheckedOn: string | null;
}

export const REGISTRY: Record<string, RegistryEntry> = registry.contracts as Record<string, RegistryEntry>;

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
