// A stand-in for the sigma-rust binding with the few classes `reduceTransaction` touches, so the page's phone path
// can be walked in happy-dom without the 2.7 MB WASM. The real reduction has test/ergopay.test.ts (Node binding)
// and scripts/reduce.ts (mainnet headers).
import type { ErgoLibModule } from "../src/ergopay";

export function fakeErgoLib(txId: string, bytes: Uint8Array) {
  const calls = { headers: [] as unknown[], inputs: 0, dataInputs: 0, json: "" };
  let boxesCall = 0;
  const lib = {
    BlockHeaders: {
      from_json: (h: unknown[]) => {
        calls.headers = h;
        return { get: () => ({}), len: () => h.length };
      },
    },
    PreHeader: { from_block_header: () => ({}) },
    ErgoStateContext: class {},
    Parameters: { default_parameters: () => ({}) },
    ErgoBoxes: {
      from_boxes_json: (b: unknown[]) => {
        if (boxesCall++ % 2 === 0) calls.inputs = b.length;
        else calls.dataInputs = b.length;
        return { len: () => b.length };
      },
    },
    UnsignedTransaction: {
      from_json: (j: string) => {
        calls.json = j;
        return { id: () => ({ to_str: () => txId }) };
      },
    },
    ReducedTransaction: { from_unsigned_tx: () => ({ sigma_serialize_bytes: () => bytes }) },
  };
  return { lib: lib as unknown as ErgoLibModule, calls };
}
