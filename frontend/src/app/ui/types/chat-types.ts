/**
 * Slide - Chat Message Types for UI Layer
 * Derived from upstream chat-types.ts
 */

/** Union type for items in the chat thread */
export type ChatItem =
  | { kind: "message"; key: string; message: unknown }
  | { kind: "divider"; key: string; label: string; timestamp: number }
  | { kind: "stream"; key: string; text: string; startedAt: number }
  | { kind: "reading-indicator"; key: string };

/** A group of consecutive messages from the same role (Slack-style layout) */
export type MessageGroup = {
  kind: "group";
  key: string;
  role: string;
  senderLabel?: string | null;
  messages: Array<{ message: unknown; key: string }>;
  timestamp: number;
  isStreaming: boolean;
};

/** Content item types in a normalized message */
export type MessageContentItemBase = {
  type: string;
  text?: string;
  name?: string;
  args?: unknown;
  id?: string;
  url?: string;
  kind?: string;
  label?: string;
  viewId?: string;
  rawText?: string | null;
  preview?: { kind?: string; surface?: string; url?: string; title?: string; preferredHeight?: number; viewId?: string; [key: string]: unknown };
  isVoiceNote?: boolean;
  attachment?: {
    isVoiceNote?: boolean;
    mimeType?: string;
    url: string;
    kind: string;
    label: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type MessageContentItem =
  | (MessageContentItemBase & { type: "text" })
  | (MessageContentItemBase & { type: "tool_call" })
  | (MessageContentItemBase & { type: "tool_result" })
  | (MessageContentItemBase & { type: "attachment" })
  | (MessageContentItemBase & { type: "canvas" });

/** Normalized message structure for rendering */
export type NormalizedMessage = {
  kind?: string;
  role: string;
  content: MessageContentItem[];
  timestamp: number;
  id?: string;
  senderLabel?: string | null;
  replyTarget?: NormalizedMessage | null;
};

/** Tool card representation for tool calls and results */
export type ToolCard = {
  kind: "call" | "result";
  name: string;
  args?: unknown;
  text?: string;
  id?: string;
  outputText?: string;
  inputText?: string;
  preview?: {
    kind?: string;
    surface?: string;
    url?: string;
    title?: string;
    preferredHeight?: number;
    viewId?: string;
    [key: string]: unknown;
  };
};
