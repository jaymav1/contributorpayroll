// Shared helpers for Verified Contributor Payroll. Node 20, ethers v6.
import 'dotenv/config';
import { ethers } from 'ethers';

export const env = process.env;
export const rpc = new ethers.JsonRpcProvider(env.RPC_URL || 'https://andromeda.metis.io/?owner=1088', 1088, { staticNetwork: true });
const PLAN = 'tuple(address funder,address contributor,address agent,address admin,uint128 weekly,uint64 start,uint32 period,uint8 numWeeks,uint32 approved,uint32 rejected,uint32 claimed,uint32 reclaimed,string spec)';
export const ABI = [
  'function token() view returns (address)',
  'function nextId() view returns (uint256)',
  `function plan(uint256 id) view returns (${PLAN})`,
  'function weekState(uint256 id,uint8 week) view returns (uint8)',
  'function weekEnd(uint256 id,uint8 week) view returns (uint256)',
  'function claimable(uint256 id) view returns (uint256)',
  'function reclaimable(uint256 id) view returns (uint256)',
  'function createPlan(tuple(address contributor,address agent,address admin,uint128 weekly,uint8 numWeeks,uint32 period,uint64 start,string spec) p) returns (uint256)',
  'function decide(uint256 id,uint8 week,bool approve,string proof)',
  'function claim(uint256 id)',
  'function reclaim(uint256 id)',
  'event PlanCreated(uint256 indexed id,address indexed funder,address indexed contributor,string spec)',
  'event WeekDecided(uint256 indexed id,uint8 week,bool approved,address indexed by,string proof)',
  'event Claimed(uint256 indexed id,address indexed contributor,uint256 amount)',
  'event Reclaimed(uint256 indexed id,address indexed funder,uint256 amount)',
];
export const STATES = ['upcoming', 'awaiting decision', 'approved, not claimed yet', 'claimed', 'rejected (returns to funder)', 'not decided in time (returns to funder)', 'returned to funder'];
export const potAt = (s) => new ethers.Contract(env.PAYROLL, ABI, s);
export const explorer = (h) => `https://explorer.metis.io/tx/${h}`;
export const usdc = (v) => ethers.formatUnits(v, 6);

// Startup self-check. Prints clear problems (useful when deploying from a phone).
export async function preflight(need = ['PAYROLL', 'TOKEN']) {
  const missing = need.filter((k) => !env[k] || /^0x_|^<|^$/.test(env[k]));
  if (missing.length) { console.error('❌ Missing or placeholder env vars:', missing.join(', ')); process.exit(1); }
  const bad = [];
  try {
    if (BigInt(await rpc.send('eth_chainId', [])) !== 1088n) bad.push('RPC is not Metis Andromeda (chain 1088)');
    if ((await rpc.getCode(env.PAYROLL)) === '0x') bad.push('PAYROLL has no contract code at that address (wrong address or wrong network)');
    else if ((await potAt(rpc).token()).toLowerCase() !== env.TOKEN.toLowerCase()) bad.push('PAYROLL was deployed with a different token than TOKEN');
    const dec = Number(await new ethers.Contract(env.TOKEN, ['function decimals() view returns (uint8)'], rpc).decimals());
    if (dec !== 6) bad.push(`TOKEN has ${dec} decimals, this code assumes 6`);
  } catch (e) { bad.push('check failed: ' + (e.shortMessage || e.message)); }
  if (bad.length) { bad.forEach((b) => console.error('❌', b)); process.exit(1); }
  console.log('✅ self-check passed');
}
