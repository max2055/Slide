import type { ChatEvent, ChatResult } from './types.js';

/** text_delta contains a cumulative snapshot; thinking_delta is incremental. */
export class ChatResponse {
  private text = '';
  private thinking = '';
  private stopReason?: string;

  observe(event: ChatEvent): void {
    if (event.type === 'text_delta') this.text = event.delta;
    if (event.type === 'thinking_delta') this.thinking += event.delta;
    if (event.type === 'complete' || event.type === 'cancelled' || event.type === 'error') {
      this.text = event.finalContent || this.text;
      this.thinking = event.thinkingContent || this.thinking;
      this.stopReason = event.stopReason || (event.type === 'complete' ? 'completed' : event.type);
    }
  }

  message(result?: ChatResult) {
    const text = result?.finalContent || this.text;
    const thinking = result?.thinkingContent || this.thinking;
    const stopReason = result?.stopReason || this.stopReason || (result?.finalContent ? 'completed' : 'error');
    if (!text.trim() && !thinking.trim()) return null;
    return {
      content: thinking ? `<think>${thinking}</think>\n\n${text}` : text,
      metadata: { interrupted: stopReason !== 'completed', stopReason, usage: result?.usage },
    };
  }
}
