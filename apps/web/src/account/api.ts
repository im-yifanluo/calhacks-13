import { databaseSettings, decodeAccountKey, type AccountKey } from "./key";

export const isPassword = (value: unknown): value is string =>
  typeof value === "string" && value.length === 6 && /^[0-9]{6}$/.test(value);
const base = () => (import.meta.env.VITE_UPLOAD_API || "").replace(/\/$/, "");
async function request(path: string, body?: object, account?: AccountKey) {
  const response = await fetch(`${base()}/api/account${path}`, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(account ? { Authorization: `Bearer ${account.token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error || "Account service unavailable. Please retry.");
  return value;
}
async function checkDestination() {
  const config = await request("/config");
  const expected = databaseSettings();
  if (config.server !== expected.server || config.database !== expected.database)
    throw new Error("The account service uses a different database. Check the server settings.");
  if (config.passwordLength !== 6) throw new Error("Update the upload service to enable six-digit passwords.");
}
function verifiedResponse(value: Partial<Record<string, unknown>>) {
  if (typeof value?.personalKey !== "string") throw new Error("The account service returned an invalid account.");
  const account = decodeAccountKey(value.personalKey);
  if (
    value?.identity !== account.identity ||
    value?.token !== account.token ||
    value?.provider !== "key" ||
    typeof value?.displayName !== "string" ||
    !value.displayName ||
    !isPassword(value.password)
  )
    throw new Error("The account service returned an invalid account.");
  return { account: { ...account, password: value.password }, name: value.displayName };
}
export async function createPasswordAccount(name: string, account: AccountKey) {
  await checkDestination();
  const result = verifiedResponse(await request("", { identity: account.identity, displayName: name }, account));
  if (result.account.identity !== account.identity) throw new Error("Account identity mismatch");
  return result;
}
export async function restorePassword(input: string) {
  const password = input.trim();
  if (!isPassword(password)) throw new Error("Enter exactly six digits.");
  await checkDestination();
  return verifiedResponse(await request("", { password }));
}
export async function accountPassword(account: AccountKey) {
  if (isPassword(account.password)) return account.password;
  await checkDestination();
  const value = await request("/password", { identity: account.identity }, account);
  if (!isPassword(value?.password)) throw new Error("The server did not return a six-digit password.");
  return value.password;
}
