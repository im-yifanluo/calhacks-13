import { DbConnection, tables } from "./module_bindings";
import type { Multiplayer } from "./net/index";
import { accountStorageKey, databaseSettings, decodeAccountKey, encodeAccountKey, forgetAccount, saveAccount, savedAccount, type AccountKey } from "./account-key";

/** Verify with the configured host before replacing any currently signed-in identity. */
export function verifySignInKey(input: string, timeoutMs = 15000): Promise<{ account: AccountKey; name: string }> {
  const account = decodeAccountKey(input);
  const { uri, database } = databaseSettings();
  return new Promise((resolve, reject) => {
    let connection: DbConnection | undefined;
    let done = false;
    const finish = (error?: string, name?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      connection?.disconnect();
      error ? reject(new Error(error)) : resolve({ account, name: name! });
    };
    const timer = setTimeout(() => finish("Could not verify the key. Check your connection and try again."), timeoutMs);
    try {
      connection = DbConnection.builder().withUri(uri).withDatabaseName(database).withToken(account.token)
        .onConnect((conn, identity) => {
          if (done) return;
          if (identity.toHexString() !== account.identity) return finish("This key could not be verified.");
          conn.subscriptionBuilder()
            .onApplied(() => {
              const profile = conn.db.profile.identity.find(identity);
              if (profile?.provider !== "key" || !profile.displayName) return finish("This key has no registered name on this server.");
              finish(undefined, profile.displayName);
            })
            .onError(() => finish("Could not read this account. Try again when connected."))
            .subscribe(tables.profile.where(row => row.identity.eq(identity)));
        })
        .onConnectError(() => finish("The key was rejected or the server is unreachable. Check the complete key and your connection."))
        .onDisconnect(() => finish("Connection lost while checking the key. Try again."))
        .build();
    } catch { finish("Could not verify the key. Please try again."); }
  });
}

export function mountAuth(net: Multiplayer): void {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const status = element("auth-status"), notice = element("auth-notice");
  const create = element<HTMLFormElement>("account-create");
  const login = element<HTMLFormElement>("account-login");
  const name = element<HTMLInputElement>("account-name");
  const key = element<HTMLInputElement>("account-key-input");
  const signout = element<HTMLButtonElement>("auth-signout");
  const signedIn = element("account-signed-in"), signedOut = element("account-signed-out");
  // The viewer has an editable guest name; standalone pages share auth without that field.
  const playerName = document.querySelector<HTMLInputElement>("#player-name");
  let busy = false;
  let rememberedName = playerName?.value ?? "";
  const show = (text: string, error = false) => {
    notice.textContent = text;
    notice.classList.toggle("error", error);
  };
  const rememberName = (value: string) => {
    rememberedName = value;
    sessionStorage.setItem("memreplay-name", value);
    try { localStorage.setItem("memreplay-name", value); } catch { /* private mode */ }
    if (playerName) playerName.value = value;
  };
  const render = () => {
    const account = savedAccount();
    const profile = net.identity && net.connection?.db.profile.identity.find(net.identity);
    const registered = net.ready && profile?.provider === "key";
    status.textContent = registered ? `${profile.displayName} · signed in` : account ? "Saved account · connecting…" : "Guest";
    signedIn.hidden = !registered && !account;
    signedOut.hidden = registered || !!account;
    signout.hidden = !registered && !account;
    signout.disabled = busy;
    if (playerName) playerName.readOnly = registered || !!account;
    if (registered) {
      if ((playerName?.value ?? rememberedName) !== profile.displayName) rememberName(profile.displayName);
      element("account-id").textContent = `Your ID: ${net.identity!.toHexString().slice(0, 12)}`;
    }
    document.querySelectorAll<HTMLButtonElement>("#auth-bar button[data-account-action]").forEach(button => { button.disabled = busy; });
  };
  net.addEventListener("change", render);
  name.value = playerName?.value && playerName.value !== "Guest" ? playerName.value : "";
  render();
  create.onsubmit = event => {
    event.preventDefault();
    if (busy) return;
    const displayName = name.value.trim();
    if (!displayName || displayName.length > 40) return show("Enter a name from 1 to 40 characters.", true);
    busy = true; render(); show("Creating your personal key…");
    void (async () => {
      try {
        await net.callConnected(() => net.connection!.reducers.registerAccount({ name: displayName }));
        const { server, database } = databaseSettings();
        const account = { server, database, identity: net.identity!.toHexString(), token: net.token };
        const persistent = saveAccount(account);
        window.dispatchEvent(new Event('memos-account-changed'));
        rememberName(displayName);
        show(persistent ? "Signed in. Save your personal key to sign in on another device." : "Signed in for this tab. Save your key; this browser could not remember it for later.");
      } catch (error) { show(error instanceof Error ? error.message : "Could not create your key.", true); }
      finally { busy = false; render(); }
    })();
  };
  login.onsubmit = event => {
    event.preventDefault();
    if (busy) return;
    busy = true; render(); show("Checking your personal key…");
    void (async () => {
      try {
        const verified = await verifySignInKey(key.value);
        // Invalid keys never sign out the existing guest or account.
        if (net.ready && net.room) await net.attempt(() => net.connection!.reducers.leaveRoom({}), null);
        saveAccount(verified.account);
        rememberName(verified.name);
        key.value = "";
        net.dispose();
        location.reload(); // the invite path remains intact
      } catch (error) { show(error instanceof Error ? error.message : "Could not sign in.", true); }
      finally { busy = false; render(); }
    })();
  };
  const personalKey = () => {
    const account = savedAccount();
    if (account) return encodeAccountKey(account);
    const profile = net.identity && net.connection?.db.profile.identity.find(net.identity);
    if (!net.ready || profile?.provider !== "key") throw new Error("Save a name first to create your personal key.");
    const { server, database } = databaseSettings();
    return encodeAccountKey({ server, database, identity: net.identity!.toHexString(), token: net.token });
  };
  element<HTMLButtonElement>("account-copy-key").onclick = () => {
    void (async () => {
      try { await navigator.clipboard.writeText(personalKey()); show("Personal key copied. Keep it private, like a password."); }
      catch { show("Copy is unavailable here. Use Save key file instead.", true); }
    })();
  };
  element<HTMLButtonElement>("account-save-key").onclick = () => {
    try {
      const url = URL.createObjectURL(new Blob([personalKey() + "\n"], { type: "text/plain" }));
      const link = document.createElement("a");
      link.href = url; link.download = "memos-personal-key.txt"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      show("Key file downloaded. Store it somewhere private.");
    } catch (error) { show(error instanceof Error ? error.message : "Could not save your key.", true); }
  };
  signout.onclick = () => {
    if (busy) return;
    busy = true; render();
    void (async () => {
      if (net.ready && net.room) await net.attempt(() => net.connection!.reducers.leaveRoom({}), null);
      forgetAccount();
      sessionStorage.removeItem("memreplay-name");
      try { localStorage.removeItem("memreplay-name"); } catch { /* unavailable */ }
      net.dispose();
      location.reload();
    })();
  };
  window.addEventListener("storage", event => {
    if (event.key !== accountStorageKey()) return;
    sessionStorage.removeItem(event.key);
    sessionStorage.removeItem(`memreplay-token:${databaseSettings().database}`);
    net.dispose();
    location.reload();
  });
}
