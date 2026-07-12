import {
  deleteMessagesBefore,
  getConversationById,
  getMessages,
  insertConversation,
  insertMessage,
  updateConversationProfile,
  type MessageRow,
} from "./db/database";

/**
 * A local-only fake conversation for exercising the Chat screen (bubbles,
 * persistence, send/receive UI) without a second registered device. ChatScreen
 * special-cases this id to skip encryption/socket and ask the local AI bot.
 */
export const TEST_BOT_CONVERSATION_ID = "test-bot";
export const TEST_BOT_NAME = "Dora";
export const TEST_BOT_INTRO_MESSAGE = "Hey! I'm Dora. Ready when you are. 😊";
export const TEST_BOT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

export function cleanupExpiredTestBotMessages(now = Date.now()) {
  deleteMessagesBefore(TEST_BOT_CONVERSATION_ID, now - TEST_BOT_MESSAGE_TTL_MS);
}

function createIntroMessage(): MessageRow {
  return {
    id: `${TEST_BOT_CONVERSATION_ID}-intro`,
    conversation_id: TEST_BOT_CONVERSATION_ID,
    direction: "incoming",
    plaintext: TEST_BOT_INTRO_MESSAGE,
    sent_at: Date.now(),
    status: "delivered",
    delivered_at: Date.now(),
    read_at: null,
    reply_to_id: null,
    reply_preview: null,
    pinned_at: null,
    deleted_at: null,
    reaction_mine: null,
    reaction_peer: null,
    kind: "text",
    audio_uri: null,
    duration_ms: null,
    waveform: null,
    image_uri: null,
    image_width: null,
    image_height: null,
    gif_url: null,
    gif_width: null,
    gif_height: null,
    video_uri: null,
    video_width: null,
    video_height: null,
    video_duration_ms: null,
    video_size: null,
    file_uri: null,
    file_name: null,
    file_mime: null,
    file_size: null,
    media_url: null,
    media_key: null,
    media_nonce: null,
    media_status: "ready",
    album_id: null,
  };
}

function ensureIntroMessage() {
  if (getMessages(TEST_BOT_CONVERSATION_ID).length === 0) {
    insertMessage(createIntroMessage());
  }
}

function syncTestBotConversationMetadata() {
  const conversation = getConversationById(TEST_BOT_CONVERSATION_ID);
  if (conversation && conversation.display_name !== TEST_BOT_NAME) {
    updateConversationProfile(TEST_BOT_CONVERSATION_ID, TEST_BOT_NAME, conversation.avatar_url, conversation.contact_number);
  }
  return conversation;
}

export function syncTestBotConversationIfPresent() {
  const conversation = syncTestBotConversationMetadata();
  cleanupExpiredTestBotMessages();
  if (conversation) ensureIntroMessage();
}

export function ensureTestBotConversation() {
  const conversation = getConversationById(TEST_BOT_CONVERSATION_ID);
  if (!conversation) {
    insertConversation({
      id: TEST_BOT_CONVERSATION_ID,
      peer_public_key: TEST_BOT_CONVERSATION_ID,
      display_name: TEST_BOT_NAME,
      avatar_url: null,
      created_at: Date.now(),
      status: "accepted",
      contact_number: null,
    });
  } else {
    syncTestBotConversationMetadata();
  }
  cleanupExpiredTestBotMessages();
  ensureIntroMessage();
}
