const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
  "WebChat",
  "WhatsApp",
  "Telegram",
  "Signal",
  "Slack",
  "Discord",
  "Google Chat",
  "iMessage",
  "Teams",
  "Matrix",
  "Zalo",
  "Zalo Personal",
  "BlueBubbles",
];

const MESSAGE_ID_LINE = /^\s*\[message_id:\s*[^\]]+\]\s*$/i;

function looksLikeEnvelopeHeader(header: string): boolean {
  // Date-only envelopes must occupy the entire header, not a fragment of user prose.
  if (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}Z| \d{2}:\d{2}(?: GMT[+-]\d{1,2})?)$/.test(header)) {
    return true;
  }
  return ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `));
}

export function stripEnvelope(text: string): string {
  let remaining = text;
  for (;;) {
    const match = remaining.match(ENVELOPE_PREFIX);
    if (!match || !looksLikeEnvelopeHeader(match[1] ?? "")) {
      return remaining;
    }
    remaining = remaining.slice(match[0].length);
  }
}

export function stripMessageIdHints(text: string): string {
  if (!/\[message_id:/i.test(text)) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !MESSAGE_ID_LINE.test(line));
  return filtered.length === lines.length ? text : filtered.join("\n");
}
