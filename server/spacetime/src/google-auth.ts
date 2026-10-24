export const isGoogleIssuer = (issuer: string) =>
  issuer === "https://accounts.google.com" || issuer === "accounts.google.com";

/** SpacetimeDB verifies the OIDC signature. The module still must check our app's audience. */
export function googleClaimError(
  issuer: string,
  audience: readonly string[],
  claims: Record<string, unknown>,
  nowSeconds: number,
  clientId: string,
): string | undefined {
  if (!isGoogleIssuer(issuer)) return;
  if (!clientId || !audience.includes(clientId))
    return "Google token is for a different app";
  if (claims.azp !== undefined && claims.azp !== clientId)
    return "Invalid Google authorized party";
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds)
    return "Google session expired; sign in again";
  if (typeof claims.sub !== "string" || !claims.sub)
    return "Missing Google subject";
}
