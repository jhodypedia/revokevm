import { ethers } from "ethers";
import dotenv from "dotenv";
import { providerWithFailover } from "./rpcManager.js";
dotenv.config();

const APPROVAL_TOPIC = ethers.id("Approval(address,address,uint256)");
const APPROVAL_FOR_ALL_TOPIC = ethers.id("ApprovalForAll(address,address,bool)");
const CHUNK = parseInt(process.env.SCAN_CHUNK_BLOCKS || "20000", 10);
const LOOKBACK = parseInt(process.env.DEFAULT_LOOKBACK_BLOCKS || "300000", 10);

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];
const ERC721_ABI = [
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function name() view returns (string)"
];

const topicToAddress = (t) => ethers.getAddress("0x" + t.slice(-40));

export async function scanApprovals({ chainId, address, onEvent = () => {} }) {
  const provider = await providerWithFailover(chainId);
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - LOOKBACK);
  const padded = ethers.hexZeroPad(address.toLowerCase(), 32);

  onEvent({ type: "info", chainId, msg: `Scan blocks ${fromBlock}..${latest}` });

  for (let start = fromBlock; start <= latest; start += CHUNK) {
    const end = Math.min(latest, start + CHUNK - 1);
    onEvent({ type: "info", chainId, msg: `Range ${start}..${end}` });

    let approvalLogs = [], approvalAllLogs = [];
    try {
      approvalLogs = await provider.getLogs({ fromBlock: start, toBlock: end, topics: [APPROVAL_TOPIC, padded] });
    } catch (e) {
      onEvent({ type: "error", chainId, msg: "getLogs Approval error " + e.message });
    }
    try {
      approvalAllLogs = await provider.getLogs({ fromBlock: start, toBlock: end, topics: [APPROVAL_FOR_ALL_TOPIC, padded] });
    } catch (e) {
      onEvent({ type: "error", chainId, msg: "getLogs ApprovalForAll error " + e.message });
    }

    for (const log of approvalLogs) {
      const contract = log.address;
      const spender = topicToAddress(log.topics[2]);

      // Try ERC20
      try {
        const c20 = new ethers.Contract(contract, ERC20_ABI, provider);
        const decimals = await c20.decimals().catch(()=>null);
        if (decimals !== null) {
          const [allowance, symbol] = await Promise.all([
            c20.allowance(address, spender),
            c20.symbol().catch(()=> "")
          ]);
          onEvent({
            type: "found",
            chainId,
            contract,
            kind: "erc20",
            details: { spender, allowance: allowance.toString(), decimals, symbol }
          });
          continue;
        }
      } catch {}

      // Try ERC721 single
      try {
        const c721 = new ethers.Contract(contract, ERC721_ABI, provider);
        const name = await c721.name().catch(()=>null);
        if (name !== null) {
          let tokenId = null;
          try {
            const [decoded] = ethers.AbiCoder.defaultAbiCoder.decode(["uint256"], log.data);
            tokenId = decoded.toString();
          } catch {}
          onEvent({ type: "found", chainId, contract, kind: "erc721", details: { spender, tokenId, name } });
          continue;
        }
      } catch {}

      onEvent({ type: "found", chainId, contract, kind: "unknown", details: { spender } });
    }

    for (const log of approvalAllLogs) {
      const contract = log.address;
      const operator = topicToAddress(log.topics[2]);
      try {
        const c721 = new ethers.Contract(contract, ERC721_ABI, provider);
        const isApproved = await c721.isApprovedForAll(address, operator).catch(()=>null);
        onEvent({
          type: "found",
          chainId,
          contract,
          kind: "approval_for_all",
          details: { operator, isApproved: isApproved === true }
        });
      } catch {
        onEvent({ type: "found", chainId, contract, kind: "approval_for_all", details: { operator } });
      }
    }
  }
  onEvent({ type: "info", chainId, msg: "Scan complete." });
}
