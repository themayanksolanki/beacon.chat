// Fired whenever something that should re-sort/refresh the conversation list
// happens outside of MessagingContext's own socket events — currently just
// call activity (see CallContext's insertCall/updateCallOutcome call sites).
// MessagingContext's `revision` counter (what ConversationListScreen
// re-queries on) already covers message/reaction/contact events; this lets
// call activity feed into that same counter without CallContext importing
// MessagingContext directly. Plain module state/pub-sub rather than a React
// context because it's called from CallContext, a sibling provider, not a
// descendant — same "bridge between contexts via module state" approach as
// notifications/activeChatTracker.ts.
type Listener = () => void;
const listeners = new Set<Listener>();

export function notifyConversationActivity(): void {
  listeners.forEach((listener) => listener());
}

export function subscribeConversationActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
