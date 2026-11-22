import MarkdownIt from "markdown-it";

export function createChatMarkdownParser() {
  return new MarkdownIt({ html: true, breaks: true, linkify: true }).enable("strikethrough");
}
