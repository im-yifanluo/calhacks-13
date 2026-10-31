import { t } from "spacetimedb/server";
import db from "../schema";
import { fail, text, updateProfile } from "../helpers";

/** A display name labels the signed-in sender; it never selects another account, and a name registered to a
 *  password (register_account) stays fixed. */
export const setDisplayName = db.reducer({ displayName: t.string() }, (ctx, { displayName }) => {
  updateProfile(ctx);
  const name = text(displayName, 40);
  const profile = ctx.db.profile.identity.find(ctx.sender)!;
  if (profile.provider === "key" && profile.displayName !== name)
    fail("This password already belongs to a registered name");
  ctx.db.profile.identity.update({ ...profile, displayName: name });
});
export const registerAccount = db.reducer({ name: t.string() }, (ctx, { name }) => {
  updateProfile(ctx);
  name = text(name, 40);
  const existing = ctx.db.profile.identity.find(ctx.sender)!;
  if (existing.provider === "key" && existing.displayName !== name)
    fail("This password already belongs to a registered name");
  ctx.db.profile.identity.update({ ...existing, provider: "key", displayName: name });
  const p = ctx.db.player.identity.find(ctx.sender);
  if (p) ctx.db.player.identity.update({ ...p, name });
});
