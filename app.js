import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import ejsLayouts from "express-ejs-layouts";
import { Server as IOServer } from "socket.io";
import sequelize from "./db/index.js";
import RpcEndpoint from "./db/models/RpcEndpoint.js";
import { bootstrapRpcFromChainlist, refreshAllRpcStatus } from "./lib/rpcManager.js";
import { scanApprovals } from "./lib/scanner.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

// Views
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(ejsLayouts);                // pakai layout default
app.set("layout", "layouts/main");  // tidak perlu layout('layout') di file view
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Halaman utama
app.get("/", async (req, res) => {
  const chains = await RpcEndpoint.findAll({
    attributes: ["chain_id", "chain_name"],
    group: ["chain_id", "chain_name"],
    order: [["chain_id", "ASC"]]
  });
  res.render("index", { title: "Revoke Approvals — Multi-Chain Failover", chains });
});

// API: start scans on selected chains
app.post("/api/scan", async (req, res) => {
  const { address, chainIds } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });
  const list = Array.isArray(chainIds) && chainIds.length ? chainIds.map(Number) : [];

  list.forEach((cid) => {
    scanApprovals({
      chainId: cid,
      address: address.toLowerCase(),
      onEvent: (evt) => io.to(address.toLowerCase()).emit("scan:update", evt)
    }).catch((e) =>
      io.to(address.toLowerCase()).emit("scan:error", { chainId: cid, msg: e.message })
    );
  });

  res.json({ status: "started", chainIds: list });
});

// API: manual allowance check (ERC20)
app.post("/api/allowance", async (req, res) => {
  try {
    const { chainId, token, owner, spender } = req.body;
    if (!chainId || !token || !owner || !spender) return res.status(400).json({ error: "missing params" });
    const { ethers } = await import("ethers");
    const { providerWithFailover } = await import("./lib/rpcManager.js");

    const provider = await providerWithFailover(Number(chainId));
    const abi = [
      "function allowance(address owner, address spender) view returns (uint256)",
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)"
    ];
    const c = new ethers.Contract(token, abi, provider);
    const [allowance, decimals, symbol] = await Promise.all([
      c.allowance(owner, spender),
      c.decimals().catch(()=>18),
      c.symbol().catch(()=> "")
    ]);
    res.json({ allowance: allowance.toString(), decimals, symbol });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Socket rooms
io.on("connection", (socket) => {
  socket.on("join", (addr) => addr && socket.join(addr.toLowerCase()));
  socket.on("leave", (addr) => addr && socket.leave(addr.toLowerCase()));
});

// Bootstrap
(async () => {
  await sequelize.sync();
  await bootstrapRpcFromChainlist();
  // initial health check
  await refreshAllRpcStatus((m) => console.log(m));

  // schedule periodic health checks
  const everySec = parseInt(process.env.RPC_RECHECK_INTERVAL_SEC || "300", 10);
  setInterval(() => refreshAllRpcStatus((m) => console.log(m)), everySec * 1000);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
})();
