import { GOOGLE_CLIENT_ID } from "../../../server/spacetime/src/google-config";
import {
  googleClaimError,
  isGoogleIssuer,
} from "../../../server/spacetime/src/google-auth";
import type { Multiplayer } from "./net/index";

const KEY = "memreplay-google-credential";
interface Claims {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  nonce?: string;
  name?: string;
}
/** Decode only for expiry/nonce/UI checks. SpacetimeDB verifies the signature and audience. */
export function decodeClaims(token: string): Claims {
  const part = token.split(".")[1];
  if (!part) throw new Error("Invalid Google credential");
  const text = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(
    new TextDecoder().decode(Uint8Array.from(text, (c) => c.charCodeAt(0))),
  );
}
export function validateCredential(
  token: string,
  nonce: string,
  clientId = GOOGLE_CLIENT_ID,
  now = Date.now() / 1000,
): Claims {
  const claims = decodeClaims(token);
  if (!isGoogleIssuer(claims.iss) || claims.nonce !== nonce)
    throw new Error("Google sign-in could not be verified; try again");
  const error = googleClaimError(
    claims.iss,
    Array.isArray(claims.aud) ? claims.aud : [claims.aud],
    claims as unknown as Record<string, unknown>,
    now,
    clientId,
  );
  if (error) throw new Error(error);
  return claims;
}
export function googleCredential(): string | undefined {
  return sessionStorage.getItem(KEY) || undefined;
}
export function credentialExpired(token: string): boolean {
  try {
    return !(decodeClaims(token).exp > Date.now() / 1000 + 5);
  } catch {
    return true;
  }
}
interface GoogleIdentity {
  initialize(config: {
    client_id: string;
    nonce: string;
    auto_select: boolean;
    callback: (response: { credential: string }) => void;
  }): void;
  renderButton(
    element: HTMLElement,
    options: { theme: string; size: string; text: string; shape: string },
  ): void;
  disableAutoSelect(): void;
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdentity } };
  }
}

export function mountAuth(net: Multiplayer): void {
  const label = document.getElementById("auth-status")!;
  const button = document.getElementById("google-signin")!;
  const signout = document.getElementById("auth-signout") as HTMLButtonElement;
  const render = () => {
    const profile =
      net.identity && net.connection?.db.profile.identity.find(net.identity);
    const token = googleCredential();
    label.textContent =
      profile?.provider === "google" && net.ready
        ? `${profile.displayName || "Google account"} · signed in`
        : token
          ? "Google session · sign in again if expired"
          : "Guest · ready to join";
    signout.hidden = !token;
    button.hidden =
      profile?.provider === "google" &&
      net.ready &&
      !!token &&
      !credentialExpired(token);
  };
  net.addEventListener("change", render);
  render();
  signout.onclick = async () => {
    signout.disabled = true;
    if (net.ready && net.room)
      await net.attempt(() => net.connection!.reducers.leaveRoom({}), null);
    net.dispose();
    sessionStorage.removeItem(KEY);
    window.google?.accounts.id.disableAutoSelect();
    location.reload();
  };
  if (!GOOGLE_CLIENT_ID) {
    button.textContent = "Google sign-in · setup required";
    button.setAttribute("aria-disabled", "true");
    const note = document.getElementById("auth-note")!;
    note.textContent =
      "Google client ID isn’t configured. Guest parties work now.";
    return;
  }
  const nonce = crypto.randomUUID();
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.onerror = () => {
    button.textContent =
      "Google unavailable — reload to retry. Guests can still join.";
  };
  script.onload = () => {
    const google = window.google!.accounts.id;
    google.initialize({
      client_id: GOOGLE_CLIENT_ID,
      nonce,
      auto_select: false,
      callback: (response) => {
        void (async () => {
          try {
            const claims = validateCredential(response.credential, nonce);
            if (net.ready && net.room)
              await net.attempt(
                () => net.connection!.reducers.leaveRoom({}),
                null,
              );
            net.dispose();
            sessionStorage.setItem(KEY, response.credential);
            if (claims.name) {
              localStorage.setItem("memreplay-name", claims.name.slice(0, 40));
              sessionStorage.setItem("memreplay-name", claims.name.slice(0, 40));
            }
            // The invite remains in the URL; the new identity joins it after the reload.
            location.reload();
          } catch (error) {
            label.textContent =
              error instanceof Error ? error.message : "Sign-in failed";
          }
        })();
      },
    });
    button.replaceChildren();
    google.renderButton(button, {
      theme: "outline",
      size: "large",
      text: "signin_with",
      shape: "pill",
    });
  };
  document.head.append(script);
}
