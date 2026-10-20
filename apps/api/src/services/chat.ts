import type { ChatMessageDTO } from "@plusone/shared";
import { and, desc, eq, or } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { chatMessages } from "../db/schema.js";

type MessageRow = typeof chatMessages.$inferSelect;
type NewMessage = typeof chatMessages.$inferInsert;

export const ASSISTANT_NAME = "PlusOne";

export function toMessageDTO(row: MessageRow): ChatMessageDTO {
  return {
    id: row.id,
    seq: row.seq,
    sessionId: row.sessionId,
    authorKind: row.authorKind,
    authorName: row.authorName,
    buyerId: row.buyerId,
    visibility: row.visibility,
    body: row.body,
    options: row.options ?? null,
    replyToId: row.replyToId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function insertMessage(tx: Tx, values: NewMessage): Promise<MessageRow> {
  const [row] = await tx.insert(chatMessages).values(values).returning();
  if (!row) throw new Error("Could not save message");
  return row;
}

/**
 * Recent chat as one viewer sees it: every public message plus private ones
 * addressed to them. The seller sees everything.
 */
export async function recentMessages(
  tx: Tx,
  sessionId: string,
  viewer: { buyerId?: string; isSeller?: boolean },
  limit = 100,
): Promise<ChatMessageDTO[]> {
  const visible = viewer.isSeller
    ? eq(chatMessages.sessionId, sessionId)
    : and(
        eq(chatMessages.sessionId, sessionId),
        viewer.buyerId
          ? or(eq(chatMessages.visibility, "public"), eq(chatMessages.buyerId, viewer.buyerId))
          : eq(chatMessages.visibility, "public"),
      );
  const rows = await tx
    .select()
    .from(chatMessages)
    .where(visible)
    .orderBy(desc(chatMessages.seq))
    .limit(limit);
  return rows.reverse().map(toMessageDTO);
}
