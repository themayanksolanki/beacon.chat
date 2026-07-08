import { File } from "expo-file-system";

import { clearMessages, getMessages } from "../db/database";

/** Deletes every message in a conversation, including voice clips on disk, but keeps the conversation itself. */
export function clearConversation(conversationId: string): void {
  for (const message of getMessages(conversationId)) {
    if (!message.audio_uri) continue;
    const file = new File(message.audio_uri);
    if (file.exists) file.delete();
  }
  clearMessages(conversationId);
}
