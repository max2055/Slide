import { normalizeOptionalString } from "../shared/string-coerce.js";
import { findMarkdownCodeRegions } from "../markdown/code-regions.js";
import { prepareAssistantMarkdown } from "../shared/text/reasoning-tags.js";

export type InlineDirectiveParseResult = {
  text: string;
  replyToId?: string;
  replyToExplicitId?: string;
  replyToCurrent: boolean;
  hasAudioTag: boolean;
  hasReplyTag: boolean;
};

type InlineDirectiveParseOptions = {
  currentMessageId?: string;
  stripAudioTag?: boolean;
  stripReplyTags?: boolean;
  onStripReplyTag?: (start: number, end: number, replacement: string) => void;
};

const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;
const INLINE_DIRECTIVE_TAG_WITH_PADDING_RE =
  /\s*\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]\s*/gi;
// Only tidy whitespace touching a removed directive.
const REPLY_TAG_REMOVAL_RE =
  /^[ \t]*\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\][ \t]*(?:\r?\n|$)|[ \t]*\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\][ \t]*/gim;

function replacementPreservesWordBoundary(source: string, offset: number, length: number): string {
  const before = source[offset - 1];
  const after = source[offset + length];
  return before && after && !/\s/u.test(before) && !/\s/u.test(after) ? " " : "";
}

type StripInlineDirectiveTagsResult = {
  text: string;
  changed: boolean;
};

type MessageTextPart = {
  type: "text";
  text: string;
} & Record<string, unknown>;

type MessagePart = Record<string, unknown> | null | undefined;

export type DisplayMessageWithContent = {
  content?: unknown;
} & Record<string, unknown>;

export function stripInlineDirectiveTagsForDisplay(text: string): StripInlineDirectiveTagsResult {
  if (!text) {
    return { text, changed: false };
  }
  const stripped = text.replace(REPLY_TAG_RE, "");
  return {
    text: stripped,
    changed: stripped !== text,
  };
}

export function stripInlineDirectiveTagsForDelivery(text: string): StripInlineDirectiveTagsResult {
  if (!text) {
    return { text, changed: false };
  }
  const stripped = text.replace(INLINE_DIRECTIVE_TAG_WITH_PADDING_RE, " ");
  const changed = stripped !== text;
  return {
    text: changed ? stripped.trim() : text,
    changed,
  };
}

function isMessageTextPart(part: MessagePart): part is MessageTextPart {
  return Boolean(part) && part?.type === "text" && typeof part.text === "string";
}

/**
 * Strips inline directive tags from message text blocks while preserving message shape.
 * Empty post-strip text stays empty-string to preserve caller semantics.
 */
export function stripInlineDirectiveTagsFromMessageForDisplay(
  message: DisplayMessageWithContent | undefined,
): DisplayMessageWithContent | undefined {
  if (!message) {
    return message;
  }
  if (!Array.isArray(message.content)) {
    return message;
  }
  const cleaned = message.content.map((part) => {
    if (!part || typeof part !== "object") {
      return part;
    }
    const record = part as MessagePart;
    if (!isMessageTextPart(record)) {
      return part;
    }
    return { ...record, text: stripInlineDirectiveTagsForDisplay(record.text).text };
  });
  return { ...message, content: cleaned };
}

export function parseInlineDirectives(
  text?: string,
  options: InlineDirectiveParseOptions = {},
): InlineDirectiveParseResult {
  const { currentMessageId, stripReplyTags = true, onStripReplyTag } = options;
  if (!text) {
    return {
      text: "",
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }
  if (!text.includes("[[")) {
    return {
      text,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }

  const deletions: Array<{ start: number; length: number }> = [];
  const markdown = prepareAssistantMarkdown(text, (start, end) => {
    deletions.push({ start, length: end - start });
  });
  const codeRegions = findMarkdownCodeRegions(markdown);
  const sourceOffset = (offset: number) => {
    // Undo trimming and scaffolding removals in reverse order.
    for (let index = deletions.length - 1; index >= 0; index--) {
      const { start, length } = deletions[index];
      if (offset >= start) offset += length;
    }
    return offset;
  };

  const directiveStarts = new Set<number>();
  let sawCurrent = false;
  let lastExplicitId: string | undefined;
  for (const match of markdown.matchAll(REPLY_TAG_RE)) {
    const end = match.index + match[0].length;
    if (codeRegions.some(region => match.index < region.end && end > region.start)) continue;
    const start = sourceOffset(match.index);
    // Only remove complete directives present in the source text.
    if (sourceOffset(end - 1) - start + 1 !== match[0].length) continue;
    directiveStarts.add(start);
    const idRaw = match[1];
    if (idRaw === undefined) {
      sawCurrent = true;
    } else {
      const id = idRaw.trim();
      if (id) {
        lastExplicitId = id;
      }
    }
  }

  const hasReplyTag = directiveStarts.size > 0;
  const cleaned = stripReplyTags && hasReplyTag
    ? text.replace(REPLY_TAG_REMOVAL_RE, (match, offset: number) => {
        if (!directiveStarts.has(offset + match.indexOf("[["))) return match;
        const replacement = replacementPreservesWordBoundary(text, offset, match.length);
        onStripReplyTag?.(offset, offset + match.length, replacement);
        return replacement;
      })
    : text;

  const replyToId =
    lastExplicitId ?? (sawCurrent ? normalizeOptionalString(currentMessageId) : undefined);

  return {
    text: cleaned,
    replyToId,
    replyToExplicitId: lastExplicitId,
    replyToCurrent: sawCurrent,
    hasAudioTag: false,
    hasReplyTag,
  };
}
