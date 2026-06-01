/**
 * Slim reply-payload helpers — extracted from OpenClaw plugin-sdk.
 * Only contains the functions actually used by the Slide frontend.
 */

export type SendableOutboundReplyParts = {
  text: string;
  trimmedText: string;
  mediaUrls: string[];
  mediaCount: number;
  hasText: boolean;
  hasMedia: boolean;
  hasContent: boolean;
};

function resolveOutboundMediaUrls(payload: {
  mediaUrls?: string[];
  mediaUrl?: string;
}): string[] {
  if (payload.mediaUrls?.length) {
    return payload.mediaUrls;
  }
  if (payload.mediaUrl) {
    return [payload.mediaUrl];
  }
  return [];
}

function countOutboundMedia(payload: { mediaUrls?: string[]; mediaUrl?: string }): number {
  return resolveOutboundMediaUrls(payload).length;
}

function hasOutboundMedia(payload: { mediaUrls?: string[]; mediaUrl?: string }): boolean {
  return countOutboundMedia(payload) > 0;
}

function hasOutboundText(payload: { text?: string }, options?: { trim?: boolean }): boolean {
  const text = options?.trim ? payload.text?.trim() : payload.text;
  return Boolean(text);
}

export function hasOutboundReplyContent(
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
  options?: { trimText?: boolean },
): boolean {
  return hasOutboundText(payload, { trim: options?.trimText }) || hasOutboundMedia(payload);
}

export function resolveSendableOutboundReplyParts(
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
  options?: { text?: string },
): SendableOutboundReplyParts {
  const text = options?.text ?? payload.text ?? "";
  const trimmedText = text.trim();
  const mediaUrls = resolveOutboundMediaUrls(payload)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const mediaCount = mediaUrls.length;
  const hasText = Boolean(trimmedText);
  const hasMedia = mediaCount > 0;
  return {
    text,
    trimmedText,
    mediaUrls,
    mediaCount,
    hasText,
    hasMedia,
    hasContent: hasText || hasMedia,
  };
}
