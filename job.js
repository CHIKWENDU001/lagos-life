const { ApiSession } = require("./lib/api-session");
const { loadAccounts, resolveAccountsPath } = require("./lib/accounts");

const API = process.env.API_URL || "https://lagoslife.eliysites.com/api";
const TO = process.env.TARGET_GAME_ID || "IDSSEND";
const FEE = Number(process.env.SEND_FEE || 50);
const MIN = Number(process.env.MIN_SEND_AMOUNT || 100);
const SEED = Number(process.env.SEED_MONEY || 1095950);
const TEMPLATE = {
  u: process.env.TEMPLATE_USERNAME || "CHANGE_ME",
  p: process.env.TEMPLATE_PASSWORD || "CHANGE_ME"
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deepClone = value => JSON.parse(JSON.stringify(value));
const ROOT_BINDING_KEYS = new Set(["id", "_id", "gameId", "owner", "ownerId", "accountId", "userId", "phoneId", "deviceId"]);
const SIM_BINDING_KEYS = new Set(["id", "_id", "gameId", "owner", "ownerId", "accountId", "userId", "phoneId", "deviceId", "username"]);
const OWNER_ABORT_THRESHOLD = Number(process.env.OWNER_ABORT_THRESHOLD || 5);

function stripKeys(target, keys) {
  if (!target || typeof target !== "object") {
    return;
  }

  for (const key of keys) {
    delete target[key];
  }
}

function makeBootGame(template, username, scrubOwnerBinding = false) {
  const game = deepClone(template);

  if (scrubOwnerBinding) {
    stripKeys(game, ROOT_BINDING_KEYS);
    stripKeys(game.sim, SIM_BINDING_KEYS);
  }

  if (game?.sim) {
    game.sim.name = username;
  }

  game.money = SEED;
  return game;
}

async function main() {
  const accountsPath = resolveAccountsPath();
  const ledger = await loadAccounts(accountsPath);
  if (!ledger.length) {
    console.log("ledger empty, run reg.js first");
    process.exitCode = 1;
    return;
  }

  if (!process.env.TARGET_GAME_ID || !process.env.TEMPLATE_USERNAME || !process.env.TEMPLATE_PASSWORD) {
    console.log("Missing TARGET_GAME_ID, TEMPLATE_USERNAME, or TEMPLATE_PASSWORD");
    process.exitCode = 1;
    return;
  }

  const session = new ApiSession(API);

  const login = (username, password) => session.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  const getSave = async () => {
    const response = await session.request("/save");
    return response.ok ? response.json() : null;
  };

  const putSave = (game, base) => session.request("/save", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ game, base })
  });

  const getMe = async () => {
    const response = await session.request("/auth/me");
    return response.ok ? response.json() : null;
  };

  if (!(await login(TEMPLATE.u, TEMPLATE.p)).ok) {
    console.log("template login failed, check TEMPLATE_USERNAME and TEMPLATE_PASSWORD");
    process.exitCode = 1;
    return;
  }

  let clean = (await getSave())?.game;
  if (!clean) {
    console.log("template account has no game state");
    process.exitCode = 1;
    return;
  }

  clean = deepClone(clean);
  clean.money = SEED;
  console.log("template ready, drain armed,", ledger.length, "accounts");
  console.log(`accounts file: ${accountsPath}`);

  let booted = 0;
  let repaired = 0;
  let drained = 0;
  let broke = 0;
  let fail = 0;
  let total = 0;
  let ownerConflicts = 0;
  const start = Date.now();

  for (let i = 0; i < ledger.length; i += 1) {
    const account = ledger[i];

    try {
      const loginResponse = await login(account.u, account.p);
      if (!loginResponse.ok) {
        fail += 1;
        continue;
      }

      let save = await getSave();

      if (!save?.game) {
        const me = await getMe();
        if (me?.user?.username !== account.u) {
          await login(account.u, account.p);
          await sleep(200);
          save = await getSave();
        }

        if (!save?.game) {
          const bootBase = save?.updatedAt ?? save?.now ?? Date.now();
          let lastBootStatus = 0;
          let lastBootError = "";
          let ownerBlocked = false;

          for (const scrubOwnerBinding of [false, true]) {
            const game = makeBootGame(clean, account.u, scrubOwnerBinding);
            const bootResponse = await putSave(game, bootBase);

            if (bootResponse.ok) {
              booted += 1;
              ownerConflicts = 0;
              await sleep(150);
              save = await getSave();
              break;
            }

            lastBootStatus = bootResponse.status;
            lastBootError = await bootResponse.text();

            if (lastBootError.includes("stale")) {
              save = await getSave();
              if (save?.game) {
                ownerConflicts = 0;
                break;
              }
              continue;
            }

            const ownerConflict = bootResponse.status === 409
              && (lastBootError.includes('"code":"owner"') || /belongs to another account/i.test(lastBootError));

            if (ownerConflict && !scrubOwnerBinding) {
              console.log(`BOOT RETRY: ${account.u} owner-bound template detected, scrubbing template ids`);
              continue;
            }

            ownerBlocked = ownerConflict;
            break;
          }

          if (!save?.game) {
            ownerConflicts = ownerBlocked ? ownerConflicts + 1 : 0;
            console.log("BOOT FAIL:", account.u, lastBootStatus, lastBootError.slice(0, 120));
            fail += 1;

            if (ownerConflicts >= OWNER_ABORT_THRESHOLD) {
              console.log(`owner conflict hit ${ownerConflicts} times in a row; template save is still bound to another account`);
              process.exitCode = 1;
              return;
            }

            continue;
          }
        }
      }

      if (!save?.game) {
        fail += 1;
        continue;
      }

      if (Number(save.game.money) < MIN + FEE) {
        const game = deepClone(save.game);
        game.money = SEED;
        const repairResponse = await putSave(game, save.updatedAt ?? save.now ?? Date.now());

        if (repairResponse.ok) {
          repaired += 1;
          await sleep(150);
          save = await getSave();
        } else {
          broke += 1;
          continue;
        }
      }

      let amount = Math.floor(Number(save.game.money ?? 0)) - FEE;
      if (amount < MIN) {
        broke += 1;
        continue;
      }

      let sent = false;
      for (let tries = 0; tries < 3 && !sent; tries += 1) {
        const sendResponse = await session.request("/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: TO, amount })
        });

        if (sendResponse.ok) {
          sent = true;
          total += amount;
          drained += 1;
          continue;
        }

        const errorText = await sendResponse.text();
        if (errorText.includes("try again")) {
          await sleep(3000);
          continue;
        }

        const have = Number((errorText.match(/have ₦([\d,]+)/) || [])[1]?.replace(/,/g, ""));
        if (have) {
          amount = have - FEE;
          await sleep(800);
          continue;
        }

        console.log("SEND FAIL:", account.u, errorText.slice(0, 80));
        fail += 1;
        break;
      }

      const touched = drained + booted + repaired;
      if (touched > 0 && touched % 50 === 0) {
        const elapsed = (Date.now() - start) / 1000;
        const done = drained + fail + broke;
        const rate = done / Math.max(elapsed, 1);
        const left = ledger.length - i - 1;
        console.log(`progress ${done}/${ledger.length} | drained:${drained} N${total.toLocaleString()} | ${rate.toFixed(1)}/s | ETA ${Math.ceil(left / Math.max(rate, 1))}s`);
      }

      await sleep(50);
    } catch (error) {
      fail += 1;
      console.log("JOB ERROR:", account.u, error.message);
    }
  }

  const mins = ((Date.now() - start) / 60000).toFixed(1);
  console.log(`DONE in ${mins}min | booted:${booted} repaired:${repaired} drained:${drained} broke:${broke} fail:${fail} | N${total.toLocaleString()}`);
}

main().catch(error => {
  console.error("job crashed:", error);
  process.exitCode = 1;
});
