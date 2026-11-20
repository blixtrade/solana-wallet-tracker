import { SOL_MINT, USDC_MINT, USDT_MINT, getJson } from "./core.js";

const STABLES = new Set([USDC_MINT, USDT_MINT]);
// Opening a token account costs about 0.002 SOL of rent. Smaller SOL moves than this are
// treated as rent and fees, not as payment for a trade.
const MIN_SOL_MOVE = 0.0025;
const MIN_STABLE_MOVE = 0.01;

/**
 * Read what one transaction did to one wallet.
 * Returns null if the transaction failed or moved no tokens for this wallet.
 *
 * type is "buy" (token in, SOL or stablecoin out), "sell" (the reverse),
 * "swap" (one token for another), "transfer_in" or "transfer_out".
 */
export function parseWalletTx(tx, wallet) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const index = keys.indexOf(wallet);

  const deltas = new Map();
  const apply = (list, sign) => {
    for (const b of list || []) {
      if (b.owner !== wallet) continue;
      const amount = Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0);
      deltas.set(b.mint, (deltas.get(b.mint) || 0) + sign * amount);
    }
  };
  apply(tx.meta.preTokenBalances, -1);
  apply(tx.meta.postTokenBalances, 1);

  const fee = index === 0 ? (tx.meta.fee || 0) / 1e9 : 0;
  let sol = index >= 0 ? (tx.meta.postBalances[index] - tx.meta.preBalances[index]) / 1e9 + fee : 0;
  sol += deltas.get(SOL_MINT) || 0; // wrapped SOL counts as SOL
  let stable = 0;
  for (const mint of STABLES) stable += deltas.get(mint) || 0;

  const tokens = [...deltas].filter(([mint, d]) => mint !== SOL_MINT && !STABLES.has(mint) && Math.abs(d) > 0);
  if (!tokens.length) return null;
  const gained = tokens.filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]);
  const lost = tokens.filter(([, d]) => d < 0).sort((a, b) => a[1] - b[1]);

  const base = { signature: tx.transaction?.signatures?.[0] || null, time: tx.blockTime ? tx.blockTime * 1000 : null, wallet, fee };
  const paidSol = sol < -MIN_SOL_MOVE, gotSol = sol > MIN_SOL_MOVE;
  const paidStable = stable < -MIN_STABLE_MOVE, gotStable = stable > MIN_STABLE_MOVE;

  if (gained.length && lost.length) {
    return { ...base, type: "swap", mint: gained[0][0], tokenAmount: gained[0][1], fromMint: lost[0][0], fromAmount: -lost[0][1], quote: null, quoteAmount: 0 };
  }
  const [mint, delta] = (gained[0] || lost[0]);
  const amount = Math.abs(delta);
  // Stablecoins are checked first: a stablecoin trade often also moves a little SOL
  // (account rent, tips) that can pass MIN_SOL_MOVE, while stablecoins never move by accident.
  if (delta > 0) {
    if (paidStable) return { ...base, type: "buy", mint, tokenAmount: amount, quote: "USD", quoteAmount: -stable };
    if (paidSol) return { ...base, type: "buy", mint, tokenAmount: amount, quote: "SOL", quoteAmount: -sol };
    return { ...base, type: "transfer_in", mint, tokenAmount: amount, quote: null, quoteAmount: 0 };
  }
  if (gotStable) return { ...base, type: "sell", mint, tokenAmount: amount, quote: "USD", quoteAmount: stable };
  if (gotSol) return { ...base, type: "sell", mint, tokenAmount: amount, quote: "SOL", quoteAmount: sol };
  return { ...base, type: "transfer_out", mint, tokenAmount: amount, quote: null, quoteAmount: 0 };
}

const tokenCache = new Map();
// The tracker can run for days, and memecoin prices move fast, so cached prices expire.
// A failed lookup expires sooner, so one bad request does not hide a token's name for long.
const TOKEN_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 60_000;

/** Ticker, name and USD price for a list of mints, from DexScreener. Cached for a few minutes. */
export async function tokenInfo(mints) {
  const now = Date.now();
  const fresh = (m) => { const e = tokenCache.get(m); return e && now - e.at < (e.priceUsd === null ? MISS_TTL_MS : TOKEN_TTL_MS); };
  const missing = [...new Set(mints)].filter((m) => !fresh(m));
  for (let i = 0; i < missing.length; i += 30) {
    const chunk = missing.slice(i, i + 30);
    const found = new Map();
    try {
      const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`, { retries: 2 });
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const mint = p.baseToken?.address;
        const prev = found.get(mint);
        if (!mint || (prev && (prev.liquidity || 0) >= (p.liquidity?.usd || 0))) continue;
        found.set(mint, { symbol: p.baseToken.symbol, name: p.baseToken.name, priceUsd: Number(p.priceUsd) || null, liquidity: p.liquidity?.usd || 0, at: now });
      }
    } catch { /* prices are optional */ }
    for (const [m, e] of found) tokenCache.set(m, e);
    // Not found or the request failed: keep what we knew before, like solUsd does.
    for (const m of chunk) if (!found.has(m)) tokenCache.set(m, { symbol: null, name: null, priceUsd: null, liquidity: 0, ...tokenCache.get(m), at: now });
  }
  return new Map(mints.map((m) => [m, tokenCache.get(m)]));
}

let solPrice = { at: 0, usd: null };

/** Current SOL price in USD, cached for a minute. */
export async function solUsd() {
  if (Date.now() - solPrice.at < 60_000 && solPrice.usd) return solPrice.usd;
  try {
    const res = await getJson(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, { retries: 2 });
    const usd = Number(res?.[SOL_MINT]?.usdPrice);
    if (usd > 0) solPrice = { at: Date.now(), usd };
  } catch { /* keep the last known price */ }
  return solPrice.usd;
}
