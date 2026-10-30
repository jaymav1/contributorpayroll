// What the agent can prove from the chain. A plan's spec is JSON like:
//   {"title":"Weekly ambassador work","checks":[
//     {"type":"erc20","token":"0x...","direction":"out","minAmount":"1","minCount":1},        // contributor sent >= 1 token in the week
//     {"type":"log","contract":"0x...","topic0":"0x...","topicIndex":1,"min":3}                 // >= 3 events from a contract that name the contributor
//   ]}
// Ready-made checks for real activity:
//   {"type":"aave_supply","asset":"0x...","minAmount":"1","decimals":6,"minCount":1}   // contributor supplied >= 1 of the asset on Aave V3 Metis (optional "pool")
//   {"type":"swap","pair":"0x...","minCount":1}                                          // >= 1 swap on a Netswap pair that paid out to the contributor
// {"type":"manual"} (or a spec that is plain text) means only the admin can decide that plan: the agent leaves it alone.
import { ethers } from 'ethers';
import { rpc } from './lib.js';

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const SUPPLY = ethers.id('Supply(address,address,address,uint256,uint16)');            // Aave V3: topics = event, reserve, onBehalfOf, referralCode
const SWAP = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');       // Uniswap V2 / Netswap pair: topics = event, sender, to
const AAVE_POOL = '0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57';                         // Aave V3 Metis pool (Aave address book); the agent refuses to decide if it has no code
const posInt = (v, d) => { if (v === undefined || v === '') return d; const n = Number(v); if (!Number.isInteger(n) || n <= 0) { console.error('❌ invalid setting', v, '(must be a positive whole number)'); process.exit(1); } return n; };
const MAX_BLOCKS = posInt(process.env.MAX_SCAN_BLOCKS, 3_000_000); // refuse to scan more than this per check
const CHUNK = posInt(process.env.LOG_CHUNK, 2000);                  // public RPCs cap the log range
const PARALLEL = 4;

export function parseSpec(text) {
  let s; try { s = JSON.parse(text); } catch { return { manual: true, why: 'spec is plain text' }; }
  if (!s || !Array.isArray(s.checks) || s.checks.length === 0 || s.checks.length > 5) return { manual: true, why: 'spec has no checks list' };
  const checks = [];
  for (const c of s.checks) {
    if (!c || c.type === 'manual') return { manual: true, why: 'spec asks for admin sign-off' };
    if (c.type === 'log') {
      if (!ethers.isAddress(c.contract) || !/^0x[0-9a-fA-F]{64}$/.test(c.topic0 || '') || ![1, 2, 3].includes(Number(c.topicIndex)) || !(Number(c.min) >= 1)) return { bad: 'invalid log check' };
      checks.push({ type: 'log', contract: ethers.getAddress(c.contract.toLowerCase()), topic0: c.topic0, topicIndex: Number(c.topicIndex), min: Math.floor(Number(c.min)) });
    } else if (c.type === 'erc20') {
      if (!ethers.isAddress(c.token) || !['in', 'out'].includes(c.direction) || !/^\d+(\.\d+)?$/.test(String(c.minAmount ?? '0'))) return { bad: 'invalid erc20 check' };
      const dec = c.decimals === undefined ? 6 : Number(c.decimals);
      if (!Number.isInteger(dec) || dec < 0 || dec > 18) return { bad: 'invalid decimals' };
      let min; try { min = ethers.parseUnits(String(c.minAmount ?? '0'), dec); } catch { return { bad: 'minAmount has more decimals than the token' }; }
      checks.push({ type: 'erc20', token: ethers.getAddress(c.token.toLowerCase()), direction: c.direction, min, dec, minCount: Math.max(1, Math.floor(Number(c.minCount || 1))) });
    } else if (c.type === 'aave_supply') {
      if (!ethers.isAddress(c.asset) || (c.pool !== undefined && !ethers.isAddress(c.pool)) || !/^\d+(\.\d+)?$/.test(String(c.minAmount ?? '0'))) return { bad: 'invalid aave_supply check' };
      const dec = c.decimals === undefined ? 6 : Number(c.decimals);
      if (!Number.isInteger(dec) || dec < 0 || dec > 18) return { bad: 'invalid decimals' };
      let min; try { min = ethers.parseUnits(String(c.minAmount ?? '0'), dec); } catch { return { bad: 'minAmount has more decimals than the token' }; }
      checks.push({ type: 'aave_supply', pool: ethers.getAddress((c.pool || AAVE_POOL).toLowerCase()), asset: ethers.getAddress(c.asset.toLowerCase()), min, dec, minCount: Math.max(1, Math.floor(Number(c.minCount || 1))) });
    } else if (c.type === 'swap') {
      if (!ethers.isAddress(c.pair)) return { bad: 'invalid swap check' };
      checks.push({ type: 'swap', pair: ethers.getAddress(c.pair.toLowerCase()), minCount: Math.max(1, Math.floor(Number(c.minCount || 1))) });
    } else return { bad: 'unknown check type ' + c.type };
  }
  return { checks };
}

// first block whose timestamp is >= ts (head+1 if none)
const tsCache = new Map();
async function blockTs(n) { if (!tsCache.has(n)) tsCache.set(n, (await rpc.getBlock(n)).timestamp); return tsCache.get(n); }
export async function blockAtOrAfter(ts, head) {
  let lo = 0, hi = head + 1;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if ((await blockTs(mid)) >= ts) hi = mid; else lo = mid + 1; }
  return lo;
}

async function getLogsChunked(filter, from, to) {
  const ranges = []; for (let a = from; a <= to; a += CHUNK) ranges.push([a, Math.min(a + CHUNK - 1, to)]);
  const out = [];
  for (let i = 0; i < ranges.length; i += PARALLEL) {
    const parts = await Promise.all(ranges.slice(i, i + PARALLEL).map(([a, b]) => rpc.getLogs({ ...filter, fromBlock: a, toBlock: b })));
    parts.forEach((p) => out.push(...p));
  }
  return out;
}

const pad = (a) => ethers.zeroPadValue(a, 32);

// Runs every check for one contributor and one week. Returns { ok, notes } or throws if the chain could not be read (caller retries later).
export async function runChecks(checks, contributor, weekStart, weekEnd) {
  const head = await rpc.getBlockNumber();
  if ((await blockTs(head)) < weekEnd) throw new Error('chain head is behind the end of the week');
  const from = await blockAtOrAfter(weekStart, head), to = (await blockAtOrAfter(weekEnd, head)) - 1;
  if (to < from) throw new Error('no blocks found in the period (chain outage?): not deciding');
  if (to - from + 1 > MAX_BLOCKS) throw new Error(`week spans ${to - from + 1} blocks, above MAX_SCAN_BLOCKS`);
  const notes = []; let ok = true; const txs = [];
  const need = async (a) => { if ((await rpc.getCode(a)) === '0x') throw new Error('no contract at ' + a + ' (wrong address?): not deciding'); };
  const proofTxs = (logs) => { for (const l of logs.slice(0, 2)) if (txs.length < 4 && !txs.includes(l.transactionHash)) txs.push(l.transactionHash); };
  for (const c of checks) {
    if (c.type === 'log') {
      await need(c.contract);
      const topics = [c.topic0]; for (let i = 1; i < c.topicIndex; i++) topics.push(null); topics.push(pad(contributor));
      const logs = await getLogsChunked({ address: c.contract, topics }, from, to);
      const pass = logs.length >= c.min; ok &&= pass; proofTxs(logs);
      notes.push(`log ${logs.length}/${c.min} ${pass ? 'ok' : 'short'}`);
    } else if (c.type === 'swap') {
      await need(c.pair);
      const logs = await getLogsChunked({ address: c.pair, topics: [SWAP, null, pad(contributor)] }, from, to);
      const pass = logs.length >= c.minCount; ok &&= pass; proofTxs(logs);
      notes.push(`swaps ${logs.length}/${c.minCount} ${pass ? 'ok' : 'short'}`);
    } else if (c.type === 'aave_supply') {
      await need(c.pool);
      const logs = (await getLogsChunked({ address: c.pool, topics: [SUPPLY, pad(c.asset), pad(contributor)] }, from, to)).filter((l) => l.data.length >= 130);
      const total = logs.reduce((n, l) => n + BigInt('0x' + l.data.slice(66, 130)), 0n); // data = (address user, uint256 amount)
      const pass = total >= c.min && logs.length >= c.minCount; ok &&= pass; proofTxs(logs);
      notes.push(`aave supply ${ethers.formatUnits(total, c.dec)}/${ethers.formatUnits(c.min, c.dec)} in ${logs.length} ${pass ? 'ok' : 'short'}`);
    } else {
      await need(c.token);
      const topics = c.direction === 'out' ? [TRANSFER, pad(contributor)] : [TRANSFER, null, pad(contributor)];
      const logs = await getLogsChunked({ address: c.token, topics }, from, to);
      const good = logs.filter((l) => l.topics.length === 3 && l.data.length === 66); // real ERC-20 transfers only (ERC-721 has no data)
      const total = good.reduce((n, l) => n + BigInt(l.data), 0n);
      const pass = total >= c.min && good.length >= c.minCount; ok &&= pass; proofTxs(good);
      notes.push(`erc20 ${c.direction} ${ethers.formatUnits(total, c.dec)}/${ethers.formatUnits(c.min, c.dec)} in ${good.length} transfers ${pass ? 'ok' : 'short'}`);
    }
  }
  return { ok, notes: [...notes, `blocks ${from}-${to}`, ...(txs.length ? ['txs ' + txs.join(',')] : [])] }; // tx hashes last: they let anyone re-check
}
