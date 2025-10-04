import axios from "axios";
import { ethers } from "ethers";
import dotenv from "dotenv";
import RpcEndpoint from "../db/models/RpcEndpoint.js";
import { STATIC_CHAINS } from "../config/chainsStatic.js";
import { pickHttpsRpc, uniq, sleep } from "./utils.js";
dotenv.config();

const RPC_TIMEOUT_MS = parseInt(process.env.RPC_TIMEOUT_MS || "7000", 10);

export async function bootstrapRpcFromChainlist() {
  // 1) Static env first
  for (const c of STATIC_CHAINS) {
    const envUrl = process.env[c.env];
    if (envUrl) {
      await RpcEndpoint.findOrCreate({
        where: { chain_id: c.chainId, rpc_url: envUrl },
        defaults: { chain_id: c.chainId, chain_name: c.name, rpc_url: envUrl, priority: 1 }
      });
    }
  }

  // 2) Fetch chainlist
  let chains = [];
  try {
    const { data } = await axios.get("https://chainid.network/chains.json", { timeout: 20000 });
    chains = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn("Chainlist fetch failed:", e.message);
  }

  // 3) Insert HTTPS RPCs
  for (const ch of chains) {
    if (!ch?.chainId || !Array.isArray(ch.rpc)) continue;
    const httpsRpcs = pickHttpsRpc(ch.rpc);
    if (!httpsRpcs.length) continue;
    const name = ch.name || `Chain ${ch.chainId}`;
    for (const url of uniq(httpsRpcs).slice(0, 5)) { // simpan maksimal 5 per chain
      await RpcEndpoint.findOrCreate({
        where: { chain_id: ch.chainId, rpc_url: url },
        defaults: { chain_id: ch.chainId, chain_name: name, rpc_url: url }
      });
    }
  }
}

async function probeOne(rpcRow) {
  const started = Date.now();
  try {
    const provider = new ethers.JsonRpcProvider(rpcRow.rpc_url, { staticNetwork: false });
    const block = await Promise.race([
      provider.getBlockNumber(),
      sleep(RPC_TIMEOUT_MS).then(() => { throw new Error("timeout"); })
    ]);
    const latency = Date.now() - started;
    const status = latency < 1500 ? "ok" : "slow";
    await rpcRow.update({ status, latency_ms: latency, last_checked: new Date() });
    return { ok: true, latency, block };
  } catch (e) {
    await rpcRow.update({ status: "down", latency_ms: null, last_checked: new Date() });
    return { ok: false, error: e.message };
  }
}

export async function refreshAllRpcStatus(logger = console.log) {
  const all = await RpcEndpoint.findAll();
  for (const row of all) {
    const r = await probeOne(row);
    if (r.ok) logger(`✅ [${row.chain_name}] ${row.rpc_url} ${row.latency_ms ?? r.latency}ms`);
    else logger(`❌ [${row.chain_name}] ${row.rpc_url} ${r.error}`);
  }
}

export async function getBestProvider(chainId) {
  // Order by status + latency + priority
  const rows = await RpcEndpoint.findAll({
    where: { chain_id: chainId },
    order: [
      // status ok first, then slow, then down
      [RpcEndpoint.sequelize.literal("FIELD(status,'ok','slow','down')"), "ASC"],
      ["latency_ms", "ASC"],
      ["priority", "ASC"]
    ]
  });
  for (const r of rows) {
    if (r.status === "down") continue;
    try {
      const provider = new ethers.JsonRpcProvider(r.rpc_url, { staticNetwork: false });
      // quick probe small: getBlockNumber with short timeout
      const block = await Promise.race([
        provider.getBlockNumber(),
        sleep(2500).then(() => { throw new Error("timeout"); })
      ]);
      // occasional live check update
      await r.update({ status: (r.status === "ok" ? "ok" : "slow"), last_checked: new Date() });
      return provider; // first healthy
    } catch (e) {
      await r.update({ status: "down", last_checked: new Date() });
      continue;
    }
  }
  throw new Error(`No healthy RPC for chainId ${chainId}`);
}

export async function providerWithFailover(chainId) {
  // returns function that retries across candidates if call fails
  let candidateRows = await RpcEndpoint.findAll({
    where: { chain_id: chainId },
    order: [
      [RpcEndpoint.sequelize.literal("FIELD(status,'ok','slow','down')"), "ASC"],
      ["latency_ms", "ASC"],
      ["priority", "ASC"]
    ]
  });
  if (!candidateRows.length) throw new Error(`No RPC configured for chain ${chainId}`);

  async function tryProvider() {
    for (const r of candidateRows) {
      if (r.status === "down") continue;
      try {
        const p = new ethers.JsonRpcProvider(r.rpc_url, { staticNetwork: false });
        await Promise.race([p.getBlockNumber(), sleep(2500).then(()=>{throw new Error("timeout");})]);
        return p;
      } catch {
        await r.update({ status: "down", last_checked: new Date() });
      }
    }
    // refetch list and retry
    candidateRows = await RpcEndpoint.findAll({ where: { chain_id: chainId } });
    throw new Error("All RPC down");
  }

  return await tryProvider();
}
