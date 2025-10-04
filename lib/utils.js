export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function pickHttpsRpc(list = []) {
  const httpsOnly = list.filter(u => typeof u === "string" && u.startsWith("https://"));
  // buang yang mengandung ${} (butuh key) agar publik dulu
  const cleaned = httpsOnly.filter(u => !u.includes("${"));
  return cleaned;
}

export function uniq(arr) {
  return Array.from(new Set(arr));
}
