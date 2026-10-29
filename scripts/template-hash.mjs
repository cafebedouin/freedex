import { ErgoTree } from "@fleet-sdk/core";
import { hex, sha256, blake2b256 } from "@fleet-sdk/crypto";
import { LimitOrder } from "@nautls/machinafi-sdk";
import { ErgoAddress } from "@fleet-sdk/core";
// build a throwaway order to get the E2T proposition
const owner = ErgoAddress.fromBase58("9fRAWhdxEsTcdb8PhGNrZfwqa65zfkuYHAMmkQLcic1gdLSV5vA");
const ob = LimitOrder.create({
  owner,
  type: "buy",
  price: 1n,
  assets: {
    base: { tokenId: "ERG", amount: 0n },
    quote: { tokenId: "03faf2cb329f2e90d6d23b58d91bbb6c046aa143261cc21f52fbe2824bfcbf04", amount: 1n },
  },
});
const tree = new ErgoTree(ob.ergoTree);
const tpl = tree.template;
console.log("tree bytes", ob.ergoTree.length / 2, "template bytes", tpl.length);
console.log("sha256(template)  ", hex.encode(sha256(tpl)));
console.log("blake2b(template) ", hex.encode(blake2b256(tpl)));
