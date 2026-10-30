// The checking agent. Each poll it looks at every plan that names its wallet as `agent`, and decides finished weeks from on-chain proof.
// Plans whose spec needs a human (plain text or "manual") are left to the admin.
//   needs: PAYROLL, TOKEN, AGENT_KEY   optional: POLL_SECONDS (default 600), DRY_RUN=1
import { ethers } from 'ethers';
import { env, rpc, potAt, preflight, explorer } from './lib.js';
import { parseSpec, runChecks } from './checks.js';

await preflight(['PAYROLL', 'TOKEN', 'AGENT_KEY']);
const key = env.AGENT_KEY.trim(), wallet = new ethers.Wallet(key.startsWith('0x') ? key : '0x' + key, rpc);
const pot = potAt(wallet), view = potAt(rpc);
const DRY = env.DRY_RUN === '1';
const ps = Number(env.POLL_SECONDS || 600), POLL = (Number.isFinite(ps) ? Math.max(60, ps) : 600) * 1000;
const warned = new Set();
const warnOnce = (k, m) => { if (!warned.has(k)) { warned.add(k); console.log(m); } };
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e?.message || e));
console.log('agent wallet', wallet.address, DRY ? '(DRY RUN: nothing is sent)' : '');
if ((await rpc.getBalance(wallet.address)) < ethers.parseEther('0.01')) console.error('⚠️ low METIS in the agent wallet: it pays gas for each decision');

async function handleWeek(id, p, spec, w) {
  const period = Number(p.period), start = Number(p.start) + w * period, end = start + period;
  const r = await runChecks(spec.checks, p.contributor, start, end);
  const proof = `agent check (${r.notes.join('; ')})`.slice(0, 480); // <= 500 bytes: only ASCII here
  console.log(`plan ${id} week ${w}: ${r.ok ? 'APPROVE' : 'REJECT'} | ${proof}`);
  if (DRY) return;
  const tx = await pot.decide(id, w, r.ok, proof);
  const rc = await tx.wait(1, 180000); // give up waiting after 3 minutes (the next poll re-checks the real state)
  console.log('   decided', explorer(rc.hash));
}

let busy = false;
async function poll() {
  if (busy) return; busy = true;
  try {
    const n = Number(await view.nextId());
    const now = Math.floor(Date.now() / 1000);
    for (let id = 1; id < n; id++) {
      try {
        const p = await view.plan(id);
        if (p.agent.toLowerCase() !== wallet.address.toLowerCase()) continue;
        const period = Number(p.period);
        if (now > Number(p.start) + Number(p.numWeeks) * period + Math.max(period, 86400)) continue; // every window of this plan is over
        const spec = parseSpec(p.spec);
        if (spec.bad) { warnOnce(id + 'bad', `plan ${id}: ${spec.bad}, skipping (the admin can still decide)`); continue; }
        if (spec.manual) { warnOnce(id + 'man', `plan ${id}: ${spec.why}, leaving it to the admin`); continue; }
        for (let w = 0; w < Number(p.numWeeks); w++) {
          if (Number(await view.weekState(id, w)) !== 1) continue; // only weeks awaiting a decision
          try { await handleWeek(id, p, spec, w); }
          catch (e) { console.error(`plan ${id} week ${w}: ${e.shortMessage || e.message} (will retry next poll)`); }
        }
      } catch (e) { console.error(`plan ${id}:`, e.shortMessage || e.message); }
    }
  } catch (e) { console.error('poll:', e.shortMessage || e.message); } finally { busy = false; }
}
await poll();
const timer = setInterval(poll, POLL);
const stop = () => { clearInterval(timer); process.exit(0); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
console.log('Payroll checker agent running, polling every', POLL / 1000, 's');
