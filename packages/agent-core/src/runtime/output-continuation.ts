import type { Message } from '../types.js';

/** Only exact suffix/prefix overlap is removed; content is never paraphrased. */
export class OutputContinuation {
  constructor(public content = '') {}
  append(fragment: string): string {
    const prefix = new Uint32Array(fragment.length);
    for (let i = 1, matched = 0; i < fragment.length; i++) {
      while (matched && fragment[i] !== fragment[matched]) matched = prefix[matched - 1];
      if (fragment[i] === fragment[matched]) matched++;
      prefix[i] = matched;
    }
    let overlap = 0;
    for (const char of this.content.slice(-fragment.length).split('')) {
      while (overlap && (overlap === fragment.length || char !== fragment[overlap])) overlap = prefix[overlap - 1];
      if (char === fragment[overlap]) overlap++;
    }
    this.content += fragment.slice(overlap);
    return this.content;
  }
  project(messages: Message[]): Message[] {
    return this.content ? [...messages, { role: 'assistant', content: this.content },
      { role: 'user', content: '[Runtime: Your previous response was truncated due to output length. Please continue from where you left off.]' }] : messages;
  }
  clear(): void { this.content = ''; }
}
