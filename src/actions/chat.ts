"use server";

import { z } from "zod";

import { getLeagueMessages } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { ChatMessage } from "@/lib/types";

/**
 * League chat actions.
 *
 * `postLeagueMessage` deliberately returns no message payload — the
 * component's success handler refetches through the same `getLeagueMessages`
 * path the poll already uses, rather than optimistically appending a
 * client-built row. That keeps exactly one source of truth for "what a
 * message looks like," so there is never a shape drift between an optimistic
 * bubble and the real thing, and a moderation delete by someone else stays
 * consistent immediately instead of needing later reconciliation.
 *
 * All ownership/membership checks live in the SQL functions
 * (post_league_message / delete_league_message), not here — same split
 * every other action in this app uses.
 */

const PostSchema = z.object({
  leagueId: z.string().uuid(),
  body: z.string().trim().min(1, "Message cannot be empty.").max(500, "Message is too long."),
  teamId: z.string().uuid().nullable().optional(),
});

export type ChatResult = { ok: true } | { ok: false; error: string };

export async function postLeagueMessage(formData: FormData): Promise<ChatResult> {
  const rawTeamId = formData.get("teamId");
  const parsed = PostSchema.safeParse({
    leagueId: formData.get("leagueId"),
    body: formData.get("body"),
    teamId: rawTeamId ? rawTeamId : null,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid message." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in to chat." };

  const { error } = await supabase.rpc("post_league_message", {
    p_league_id: parsed.data.leagueId,
    p_body: parsed.data.body,
    p_team_id: parsed.data.teamId ?? null,
  });
  if (error) return { ok: false, error: error.message.replace(/^.*?:\s*/, "") };

  return { ok: true };
}

export async function deleteLeagueMessage(messageId: string): Promise<ChatResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in to chat." };

  const { error } = await supabase.rpc("delete_league_message", { p_message_id: messageId });
  if (error) return { ok: false, error: error.message.replace(/^.*?:\s*/, "") };

  return { ok: true };
}

/** Thin read wrapper the client polls. No membership pre-check needed here —
 *  RLS already returns an empty array to a non-member, which is the correct
 *  silent behaviour for a background poll. */
export async function getLeagueMessagesAction(
  leagueId: string,
  teamId: string | null = null,
): Promise<{ ok: true; messages: ChatMessage[] } | { ok: false; error: string }> {
  try {
    const messages = await getLeagueMessages(leagueId, 50, teamId);
    return { ok: true, messages };
  } catch {
    return { ok: false, error: "Could not load messages." };
  }
}
