// Tracks which conversation, if any, is currently on screen — read by the
// notification pipeline (see notificationService.ts) to decide whether an
// incoming message for that conversation should produce a notification.
// Plain module state rather than React context because it needs to be read
// from MessagingContext's socket handlers, which aren't components.
let activeConversationId: string | null = null;

export function setActiveConversationId(conversationId: string | null): void {
  activeConversationId = conversationId;
}

export function getActiveConversationId(): string | null {
  return activeConversationId;
}
