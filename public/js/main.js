const socket = io();
let provider, signer, userAddr;

// UI refs
const connectBtn = document.getElementById("connectBtn");
const walletInfo = document.getElementById("walletInfo");
const startScanBtn = document.getElementById("startScanBtn");
const resultsBox = document.getElementById("results");
const chainsBox = document.getElementById("chainsBox");

// Connect wallet
connectBtn.onclick = async () => {
  if (!window.ethereum) return alert("Install MetaMask.");
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner();
  userAddr = await signer.getAddress();
  const net = await provider.getNetwork();
  walletInfo.innerHTML = `Connected: <b>${userAddr}</b> (chainId: ${Number(net.chainId)})`;
  socket.emit("join", userAddr.toLowerCase());
  startScanBtn.disabled = false;
};

// Start scan
startScanBtn.onclick = async () => {
  const chainIds = Array.from(chainsBox.querySelectorAll("input:checked")).map(i => Number(i.value));
  if (!userAddr) return alert("Connect wallet dulu.");
  if (!chainIds.length) return alert("Pilih minimal 1 chain.");
  startScanBtn.disabled = true;
  addInfo(`Mulai scan: ${chainIds.join(", ")}`);

  await fetch("/api/scan", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ address: userAddr, chainIds })
  }).then(r=>r.json()).catch(e=>addError(e.message));
};

// Socket updates
socket.on("scan:update", (evt) => {
  if (evt.type === "info") return addInfo(`[${evt.chainId}] ${evt.msg}`);
  if (evt.type === "error") return addError(`[${evt.chainId}] ${evt.msg}`);
  if (evt.type === "found") return renderFinding(evt);
});

function addInfo(msg) {
  const div = document.createElement("div");
  div.className = "line info";
  div.textContent = msg;
  resultsBox.prepend(div);
}
function addError(msg) {
  const div = document.createElement("div");
  div.className = "line error";
  div.textContent = msg;
  resultsBox.prepend(div);
}

function formatUnitsBI(v, decimals=18) {
  try {
    const bi = BigInt(v);
    const base = BigInt(10)**BigInt(decimals);
    const whole = bi / base;
    const frac = (bi % base).toString().padStart(decimals, "0").slice(0,6);
    return `${whole}.${frac}`;
  } catch { return String(v); }
}

function renderFinding(evt) {
  const row = document.createElement("div");
  row.className = "found";
  let html = `<div class="found-head">
    <span class="tag">#${evt.chainId}</span>
    <code class="addr">${evt.contract}</code>
    <span class="kind ${evt.kind}">${evt.kind}</span>
  </div><div class="found-body">`;

  if (evt.kind === "erc20") {
    const a = evt.details.allowance || "0";
    const d = evt.details.decimals ?? 18;
    const sym = evt.details.symbol || "";
    html += `Spender: <code>${evt.details.spender}</code><br/>
    Allowance: <b>${formatUnitsBI(a, d)}</b> ${sym}
    <div class="btns">
      <button class="btn small danger" data-type="erc20" data-contract="${evt.contract}" data-spender="${evt.details.spender}">Revoke</button>
    </div>`;
  } else if (evt.kind === "approval_for_all") {
    html += `Operator: <code>${evt.details.operator}</code> — isApproved: <b>${evt.details.isApproved}</b>
    <div class="btns">
      <button class="btn small danger" data-type="revokeAll" data-contract="${evt.contract}" data-operator="${evt.details.operator}">RevokeAll</button>
    </div>`;
  } else if (evt.kind === "erc721") {
    html += `Spender: <code>${evt.details.spender}</code> — TokenId: <b>${evt.details.tokenId || "unknown"}</b>
    <div class="btns">
      <button class="btn small danger" data-type="erc721" data-contract="${evt.contract}" data-tokenid="${evt.details.tokenId||""}">Revoke</button>
    </div>`;
  } else {
    html += `Details: <pre>${JSON.stringify(evt.details,null,2)}</pre>`;
  }

  html += "</div>";
  row.innerHTML = html;
  resultsBox.prepend(row);

  // Attach handlers
  row.querySelectorAll("button[data-type]").forEach(btn => {
    btn.onclick = onRevokeClick;
  });
}

// Revoke actions (signed in wallet)
async function onRevokeClick(e) {
  if (!provider || !signer) return alert("Connect wallet dulu.");
  const btn = e.currentTarget;
  const type = btn.dataset.type;
  const contract = btn.dataset.contract;

  if (type === "erc20") {
    const spender = btn.dataset.spender;
    if (!confirm(`Revoke allowance ke ${spender}?`)) return;
    const c = new ethers.Contract(contract, ["function approve(address spender, uint256 value) returns (bool)"], provider);
    const tx = await c.connect(signer).approve(spender, 0);
    addInfo("Tx sent: " + tx.hash);
    await tx.wait();
    addInfo("Revoke confirmed: " + tx.hash);
  } else if (type === "revokeAll") {
    const operator = btn.dataset.operator;
    if (!confirm(`Revoke operator ${operator}?`)) return;
    const c = new ethers.Contract(contract, ["function setApprovalForAll(address operator, bool approved)"], provider);
    const tx = await c.connect(signer).setApprovalForAll(operator, false);
    addInfo("Tx sent: " + tx.hash);
    await tx.wait();
    addInfo("RevokeAll confirmed: " + tx.hash);
  } else if (type === "erc721") {
    const tokenId = btn.dataset.tokenid;
    if (!tokenId) return addError("TokenId tidak diketahui untuk revoke single.");
    if (!confirm(`Revoke approve tokenId ${tokenId}?`)) return;
    const c = new ethers.Contract(contract, ["function approve(address to, uint256 tokenId)"], provider);
    const tx = await c.connect(signer).approve(ethers.ZeroAddress, tokenId);
    addInfo("Tx sent: " + tx.hash);
    await tx.wait();
    addInfo("Revoke721 confirmed: " + tx.hash);
  }
}

// Manual allowance check
document.getElementById("checkAllowanceBtn").onclick = async () => {
  const chainId = Number(document.getElementById("mChainId").value.trim());
  const token = document.getElementById("mToken").value.trim();
  const spender = document.getElementById("mSpender").value.trim();
  if (!userAddr || !chainId || !token || !spender) return alert("Lengkapi field dan connect wallet.");

  const res = await fetch("/api/allowance", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ chainId, token, owner: userAddr, spender })
  }).then(r=>r.json()).catch(e=>({error:e.message}));

  const box = document.getElementById("manualResult");
  if (res.error) {
    box.textContent = "Error: " + res.error;
    document.getElementById("manualRevokeBtn").style.display = "none";
  } else {
    box.textContent = `Allowance: ${res.allowance} (decimals ${res.decimals}) ${res.symbol||""}`;
    const btn = document.getElementById("manualRevokeBtn");
    btn.style.display = "inline-block";
    btn.onclick = async () => {
      if (!confirm(`Revoke allowance pada ${token} ke ${spender}?`)) return;
      const c = new ethers.Contract(token, ["function approve(address spender, uint256 value) returns (bool)"], provider);
      const tx = await c.connect(signer).approve(spender, 0);
      addInfo("Tx sent: " + tx.hash);
      await tx.wait();
      addInfo("Manual revoke confirmed: " + tx.hash);
    };
  }
};
