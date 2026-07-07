import { File } from "expo-file-system";

import { deleteConversationRecord, getMessages } from "../db/database";
import { deleteImageMessage } from "../media/imageStorage";

/** Deletes a conversation entirely — messages, call history, voice/image files on disk, and the conversation row itself. */
export function deleteConversation(conversationId: string): void {
  for (const message of getMessages(conversationId)) {
    if (message.audio_uri) {
      const file = new File(message.audio_uri);
      if (file.exists) file.delete();
    }
    if (message.image_uri) deleteImageMessage(message.image_uri);
  }
  deleteConversationRecord(conversationId);
}
