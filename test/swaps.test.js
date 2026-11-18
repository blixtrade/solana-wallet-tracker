import test from "node:test";
import assert from "node:assert/strict";
import { parseWalletTx } from "../lib/swaps.js";

const W = "Wallet1111111111111111111111111111111111111";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const bal = (mint, amount, owner = W) => ({ mint, owner, uiTokenAmount: { uiAmountString: String(amount) } });
const tx = ({ pre = [], post = [], solBefore = 10, solAfter = 10, fee = 5000, payer = W, err = null }) => ({
  blockTime: 1795000000,
  transaction: { signatures: ["sig"], message: { accountKeys: [{ pubkey: payer }, { pubkey: payer === W ? "Other" : W }] } },
  meta: { err, fee, preBalances: payer === W ? [solBefore * 1e9, 0] : [0, solBefore * 1e9], postBalances: payer === W ? [solAfter * 1e9, 0] : [0, solAfter * 1e9], preTokenBalances: pre, postTokenBalances: post },
});

test("SOL out, token in is a buy, with the fee left out of the price", () => {
  const t = parseWalletTx(tx({ post: [bal("MEME", 1000)], solAfter: 9 - 0.000005 }), W);
  assert.equal(t.type, "buy");
  assert.equal(t.mint, "MEME");
  assert.equal(t.tokenAmount, 1000);
  assert.ok(Math.abs(t.quoteAmount - 1) < 1e-9);
  assert.equal(t.time, 1795000000000);
});

test("token out, SOL in is a sell", () => {
  const t = parseWalletTx(tx({ pre: [bal("MEME", 1000)], post: [bal("MEME", 400)], solAfter: 10.5 }), W);
  assert.equal(t.type, "sell");
  assert.equal(t.tokenAmount, 600);
  assert.ok(Math.abs(t.quoteAmount - 0.500005) < 1e-9);
});

test("wrapped SOL counts as SOL", () => {
  const t = parseWalletTx(tx({ pre: [bal(SOL, 2)], post: [bal(SOL, 0.5), bal("MEME", 50)] }), W);
  assert.equal(t.type, "buy");
  assert.ok(Math.abs(t.quoteAmount - 1.5 + 0.000005) < 1e-9);
});

test("stablecoin trades are priced in USD", () => {
  const t = parseWalletTx(tx({ pre: [bal(USDC, 100)], post: [bal(USDC, 40), bal("MEME", 5)] }), W);
  assert.equal(t.type, "buy");
  assert.equal(t.quote, "USD");
  assert.equal(t.quoteAmount, 60);
});

test("a token arriving with only rent paid is a transfer, not a buy", () => {
  assert.equal(parseWalletTx(tx({ post: [bal("MEME", 10)], solAfter: 10 - 0.00204 }), W).type, "transfer_in");
  assert.equal(parseWalletTx(tx({ pre: [bal("MEME", 10)], post: [bal("MEME", 0)], payer: "Someone" }), W).type, "transfer_out");
});

test("token for token is a swap", () => {
  const t = parseWalletTx(tx({ pre: [bal("AAA", 10)], post: [bal("AAA", 0), bal("BBB", 99)] }), W);
  assert.equal(t.type, "swap");
  assert.equal(t.mint, "BBB");
  assert.equal(t.fromMint, "AAA");
});

test("failed, empty and other wallets' transactions are ignored", () => {
  assert.equal(parseWalletTx(tx({ post: [bal("MEME", 10)], err: { InstructionError: [] } }), W), null);
  assert.equal(parseWalletTx(tx({ solAfter: 9 }), W), null);
  assert.equal(parseWalletTx(tx({ post: [bal("MEME", 10, "Stranger")], solAfter: 9 }), W), null);
  assert.equal(parseWalletTx(null, W), null);
});
