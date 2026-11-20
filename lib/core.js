// Shared helpers: HTTP with retry, a throttled Solana JSON-RPC client, and formatting.
// Zero dependencies. Needs Node 22 or newer (built-in fetch and WebSocket).

export const SITE = "https://blixvip.com";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True for a base58 string of the right length to be a Solana address. */
export function isAddress(s) {
  return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

// Free APIs with per-minute limits. Requests to these hosts are spaced out so a burst
// waits its turn. After a 429 the spacing for that host doubles, then eases back.
const BASE_GAP_MS = { "api.geckoterminal.com": 2100, "api.dexscreener.com": 250, "api.rugcheck.xyz": 300 };
const hostGap = new Map();
const hostQueue = new Map();
let warnedAt = 0;

function throttle(host) {
  const gap = hostGap.get(host) ?? BASE_GAP_MS[host];
  if (!gap) return Promise.resolve();
  const turn = (hostQueue.get(host) || Promise.resolve()).then(() => sleep(0));
  hostQueue.set(host, turn.then(() => sleep(hostGap.get(host) ?? gap)));
  return turn;
}

function backOff(host) {
  if (!BASE_GAP_MS[host]) return;
  hostGap.set(host, Math.min(15000, (hostGap.get(host) ?? BASE_GAP_MS[host]) * 2));
}

function easeOff(host) {
  const base = BASE_GAP_MS[host];
  if (!base || !hostGap.has(host)) return;
  const next = hostGap.get(host) * 0.85;
  if (next <= base) hostGap.delete(host); else hostGap.set(host, next);
}

/**
 * GET (or POST) JSON with a timeout. Server errors are retried a few times; rate
 * limits (429) are waited out for up to `patience` ms, since free APIs reset each minute.
 */
export async function getJson(url, { retries = 4, timeout = 20000, headers = {}, method = "GET", body, patience = 90000 } = {}) {
  const host = new URL(url).host;
  const started = Date.now();
  let lastErr;
  let failures = 0;
  for (let attempt = 0; ; attempt++) {
    await throttle(host);
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { accept: "application/json", "user-agent": "blixtrade-tools", ...headers },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 429) {
        lastErr = new Error(`${host} is rate limiting requests. Wait a minute and try again.`);
        backOff(host);
        if (Date.now() - started > patience) throw Object.assign(lastErr, { fatal: true });
        if (Date.now() - warnedAt > 30000 && !process.env.BLIX_QUIET) {
          warnedAt = Date.now();
          process.stderr.write(`[rate limit] ${host} asked us to slow down. Waiting, this can take up to a minute…\n`);
        }
        const hinted = Number(res.headers.get("retry-after")) * 1000;
        await sleep(Math.min(20000, hinted > 0 ? hinted : 5000 * Math.min(attempt + 1, 4)));
        continue;
      }
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} from ${host}`);
        if (++failures > retries) throw lastErr;
        await sleep(800 * 2 ** failures);
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${host}`), { status: res.status, fatal: true });
      easeOff(host);
      return await res.json();
    } catch (err) {
      if (err.fatal) throw err;
      lastErr = err;
      if (++failures > retries) throw lastErr;
      await sleep(500 * 2 ** failures);
    }
  }
}

// One RPC call at a time, spaced out, so the free public endpoint does not rate-limit us.
const RPC_GAP_MS = Number(process.env.SOLANA_RPC_GAP_MS || (process.env.SOLANA_RPC_URL ? 60 : 350));
let rpcQueue = Promise.resolve();
let rpcId = 0;

/** Call a Solana JSON-RPC method. Throttled and retried on rate limits. */
export function rpc(method, params = []) {
  const run = async () => {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await fetch(RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
          signal: AbortSignal.timeout(25000),
        });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        const code = json?.error?.code;
        if (res.status === 429 || code === 429 || res.status >= 500) {
          lastErr = new Error(`Solana RPC rate limit on ${method}. Set SOLANA_RPC_URL to your own endpoint for faster runs.`);
          await sleep(1200 * 2 ** attempt);
          continue;
        }
        if (!json) throw new Error(`Solana RPC returned non-JSON (HTTP ${res.status})`);
        if (json.error) throw Object.assign(new Error(`Solana RPC ${method}: ${json.error.message}`), { fatal: true });
        return json.result;
      } catch (err) {
        if (err.fatal) throw err;
        lastErr = err;
        await sleep(800 * 2 ** attempt);
      }
    }
    throw lastErr;
  };
  const p = rpcQueue.then(run);
  rpcQueue = p.then(() => sleep(RPC_GAP_MS), () => sleep(RPC_GAP_MS));
  return p;
}

// Solana adds new transaction versions over time. Start at 1 and step up if the
// node says a transaction needs a newer one.
let txVersion = 1;

/** Fetch one parsed transaction by signature. */
export async function getTx(signature) {
  try {
    return await rpc("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: txVersion }]);
  } catch (err) {
    const m = /"maxSupportedTransactionVersion": (\d+)/.exec(err.message || "");
    if (m && Number(m[1]) > txVersion) { txVersion = Number(m[1]); return getTx(signature); }
    throw err;
  }
}

/** Parse argv into { _: positionals, flag: value }. `--flag` alone is true; `--no-flag` is false. */
export function parseArgs(argv, { booleans = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    if (key.startsWith("no-")) { out[key.slice(3)] = false; continue; }
    const next = argv[i + 1];
    if (booleans.includes(key) || next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  green: paint(32), red: paint(31), yellow: paint(33), cyan: paint(36),
  dim: paint(2), bold: paint(1), magenta: paint(35),
};

export const short = (addr, n = 4) => (addr && addr.length > n * 2 + 1 ? `${addr.slice(0, n)}…${addr.slice(-n)}` : String(addr ?? ""));

/** 1234567 -> "1.23M". Small numbers keep useful precision. */
const UNITS = [[1e12, "T", 2], [1e9, "B", 2], [1e6, "M", 2], [1e3, "K", 1], [1, "", 2]];

export function compact(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs < 1) {
    const s = n.toPrecision(3);
    return Math.abs(Number(s)) >= 1 ? Number(s).toFixed(2) : s;
  }
  let i = UNITS.findIndex(([div]) => abs >= div);
  // Rounding can carry into the next unit (999,960 would print "1000.0K"), so step up when it does.
  while (i > 0 && Math.abs(Number((n / UNITS[i][0]).toFixed(UNITS[i][2]))) >= 1000) i--;
  const [div, suffix, digits] = UNITS[i];
  return (n / div).toFixed(digits) + suffix;
}

export const usd = (n) => (Number.isFinite(Number(n)) ? "$" + compact(n) : "-");

/** Token prices are often tiny: 0.0000023 -> "$0.0000023". */
export function price(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return "-";
  if (n >= 1) return "$" + n.toFixed(2);
  if (n === 0) return "$0";
  // Strip trailing zeros from the mantissa too, so 1e-7 prints "$1e-7", not "$1.000e-7".
  return "$" + n.toPrecision(4).replace(/(\.\d*?)0+(e|$)/, "$1$2").replace(/\.(e|$)/, "$1");
}

export function pct(n, digits = 1) {
  n = Number(n);
  if (!Number.isFinite(n)) return "-";
  const s = Math.abs(n).toFixed(digits);
  if (Number(s) === 0) return s + "%"; // no "-0.0%"
  return (n > 0 ? "+" : "-") + s + "%";
}

/** Milliseconds -> "3m", "2h", "5d". */
export function age(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = ms / 1000;
  if (s < 60) return Math.round(s) + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return (s / 3600).toFixed(s < 36000 ? 1 : 0) + "h";
  return Math.round(s / 86400) + "d";
}

/** Pad or trim to a fixed visible width (ignores colour codes). */
export function pad(s, width, right = false) {
  s = String(s);
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (width <= 0) return "";
  if (visible.length > width) return visible.slice(0, width - 1) + "…";
  const fill = " ".repeat(width - visible.length);
  return right ? fill + s : s + fill;
}

/** Print a plain-text table. `cols` is [{ title, width, right }]. */
export function table(cols, rows) {
  const line = (cells) => cells.map((cell, i) => pad(cell, cols[i].width, cols[i].right)).join("  ");
  console.log(c.dim(line(cols.map((col) => col.title))));
  for (const row of rows) console.log(line(row));
}

/** The one-line pointer to the full product, printed once at the end of a run. */
export function footer(path, what) {
  if (process.env.BLIX_NO_FOOTER) return;
  console.log(c.dim(`\n${what} in the full BLIX terminal: ${SITE}${path}`));
}

/** Run a CLI entry point with tidy error output. */
export function main(fn) {
  fn().catch((err) => {
    console.error(c.red("Error: ") + (err?.message || err));
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  });
}
