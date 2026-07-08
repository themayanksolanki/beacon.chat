import { getConversationById, insertConversation } from "./db/database";

/**
 * A local-only fake conversation for exercising the Chat screen (bubbles,
 * persistence, send/receive UI) without a second registered device. ChatScreen
 * special-cases this id to skip encryption/socket and echo messages back.
 */
export const TEST_BOT_CONVERSATION_ID = "test-bot";
export const TEST_BOT_NAME = "Test Bot";

export function ensureTestBotConversation() {
  if (!getConversationById(TEST_BOT_CONVERSATION_ID)) {
    insertConversation({
      id: TEST_BOT_CONVERSATION_ID,
      peer_public_key: TEST_BOT_CONVERSATION_ID,
      display_name: TEST_BOT_NAME,
      created_at: Date.now(),
    });
  }
}
