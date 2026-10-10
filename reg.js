const { loadAccounts, resolveAccountsPath, saveAccounts } = require("./lib/accounts");

const API = process.env.API_URL || "https://lagoslife.eliysites.com/api";
const GOAL = Number(process.env.REGISTER_GOAL || 300);
const WORKERS = Number(process.env.REGISTER_WORKERS || 10);
const FLUSH_EVERY = Number(process.env.REGISTER_FLUSH_EVERY || 25);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const FIRST = [
  "Tunde", "Ayo", "Kemi", "Chidi", "Amaka", "Emeka", "Folake", "Ibrahim", "Ngozi", "Segun",
  "Bisi", "Uche", "Kelechi", "Yemi", "Funke", "Obi", "Aisha", "Musa", "Chinedu", "Bola",
  "Tayo", "Damilola", "Nkechi", "Sule", "Halima", "Ekene", "Ronke", "Dele", "Zainab", "Femi",
  "ola", "bamidele", "chinaza", "ifeoma", "ademola", "bukola", "chukwuemeka", "yetunde", "oluwaseun", "nnamdi",
  "Precious", "Gift", "Blessing", "Victory", "Success", "Divine", "Marvelous", "Chiamaka", "Oluwaseun", "Kehinde"
];

const LAST = [
  "Adeyemi", "Okafor", "Balogun", "Nwosu", "Ibrahim", "Eze", "Obi", "Bello", "Adeleke", "Uche",
  "Olawale", "Mensah", "Adebayo", "Okonkwo", "Bakare", "Nwachukwu", "Oyelaran", "Danjuma", "Egwu", "Umar",
  "olanrewaju", "adeleke", "nwankwo", "okoye", "ibrahim", "suleiman", "olayinka", "ezeani", "omotola", "balogun",
  "olu", "ade", "nwosu", "ekong", "yusuf", "aderinto", "olaniyi", "chukwu", "musa", "ogundele"
];

const pick = values => values[Math.floor(Math.random() * values.length)];

function makeName() {
  const first = pick(FIRST);
  const last = pick(LAST);
  const style = Math.random();
  let name;

  if (style < 0.28) {
    name = first + last;
  } else if (style < 0.5) {
    name = `${first}_${last}`;
  } else if (style < 0.68) {
    name = first.toLowerCase() + last.toLowerCase();
  } else if (style < 0.85) {
    name = first + last.slice(0, 3);
  } else {
    name = pick(FIRST) + pick(LAST).slice(0, 4);
  }

  if (!/\d/.test(name)) {
    name += Math.floor(10 + Math.random() * 989);
  }
  return name;
}

function nextName(used) {
  let name = makeName();
  let tries = 0;

  while (used.has(name) && tries < 20) {
    name = makeName();
    tries += 1;
  }

  if (used.has(name)) {
    name += Math.floor(10 + Math.random() * 89);
  }

  used.add(name);
  return name;
}

async function main() {
  const accountsPath = resolveAccountsPath();
  const ledger = await loadAccounts(accountsPath);
  const used = new Set(ledger.map(account => account.u));
  let created = ledger.length;
  let fail = 0;
  let taken = 0;
  let throttled = 0;
  let sinceFlush = 0;
  let inFlight = 0;
  let running = true;

  async function flush() {
    await saveAccounts(ledger, accountsPath);
    sinceFlush = 0;
  }

  function claimSlot() {
    if (!running || created + inFlight >= GOAL) {
      return false;
    }

    inFlight += 1;
    return true;
  }

  console.log(`parallel register: ${created} -> ${GOAL}, ${WORKERS} workers`);
  console.log(`accounts file: ${accountsPath}`);
  const start = Date.now();

  async function worker() {
    while (claimSlot()) {
      const username = nextName(used);
      const password = `W${Math.random().toString(36).slice(2)}9!`;
      const name = username.replace(/[_0-9]/g, "").slice(0, 24) || username;

      try {
        const response = await fetch(`${API}/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password, name, adult: true, born: "2000-01-01" })
        });

        if (response.status === 409) {
          taken += 1;
          used.delete(username);
          if (taken % 200 === 0) {
            console.log(`collisions with server: ${taken}`);
          }
          await sleep(150);
          continue;
        }

        if (response.status === 429) {
          throttled += 1;
          used.delete(username);
          const wait = Math.min(60000, 5000 * throttled);
          if (throttled % 3 === 1) {
            console.log(`429 backoff ${wait / 1000}s (${throttled})`);
          }
          await sleep(wait);
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          fail += 1;
          used.delete(username);
          if (fail <= 10) {
            console.log("REG FAIL:", response.status, text);
          }
          if (fail > 100) {
            console.log("too many failures, stopping");
            running = false;
            return;
          }
          await sleep(1500);
          continue;
        }

        const body = await response.json();
        if (!body.user) {
          fail += 1;
          used.delete(username);
          continue;
        }

        ledger.push({ u: username, p: password, at: Date.now() });
        created += 1;
        throttled = 0;
        sinceFlush += 1;

        if (sinceFlush >= FLUSH_EVERY) {
          await flush();
        }

        if (created % 25 === 0 || created === GOAL) {
          const elapsed = (Date.now() - start) / 1000;
          const rate = created / Math.max(elapsed, 1);
          console.log(`${created}/${GOAL} | ${rate.toFixed(1)}/s | collisions:${taken} throttles:${throttled}`);
        }

        await sleep(20 + Math.random() * 60);
      } catch (error) {
        used.delete(username);
        fail += 1;
        if (fail <= 10) {
          console.log("REG ERROR:", error.message);
        }
        await sleep(2000);
      } finally {
        inFlight -= 1;
      }
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, () => worker()));
  await flush();

  const mins = ((Date.now() - start) / 60000).toFixed(1);
  console.log(`REGISTER DONE in ${mins}min | total:${ledger.length} fails:${fail} collisions:${taken} throttles:${throttled}`);

  if (!running) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error("register job crashed:", error);
  process.exitCode = 1;
});
