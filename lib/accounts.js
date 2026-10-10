const fs = require("fs/promises");
const path = require("path");

function resolveAccountsPath(filePath = process.env.ACCOUNTS_FILE || "accs.json") {
  return path.resolve(filePath);
}

async function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

async function loadAccounts(filePath = resolveAccountsPath()) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function saveAccounts(accounts, filePath = resolveAccountsPath()) {
  await ensureParentDir(filePath);
  await fs.writeFile(filePath, JSON.stringify(accounts, null, 2));
}

module.exports = {
  loadAccounts,
  resolveAccountsPath,
  saveAccounts
};
