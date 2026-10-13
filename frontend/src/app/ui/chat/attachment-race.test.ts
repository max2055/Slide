import { describe, expect, it, vi } from 'vitest';
import { appendChatFiles, clearChatViewCaches } from '../views/chat.ts';
import { chatSessionHost, activateChatSession, clearChatSessions } from '../chat-session-state.ts';

describe('async attachments retain their Session', () => {
  it('out-of-order FileReaders append against the latest captured session and expire safely', () => {
    const readers: Array<{ result: string; complete: () => void }> = [];
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,fixture'; complete = () => {};
      constructor() { readers.push(this); }
      addEventListener(_type: string, listener: () => void) { this.complete = listener; }
      readAsDataURL() {}
    });
    try {
      const root: any = { sessionKey: 'one', chatAttachments: [] };
      const one = chatSessionHost(root);
      appendChatFiles([new File(['one'], 'one.png', { type: 'image/png' }), new File(['two'], 'two.png', { type: 'image/png' })], {
        readAttachments: () => one.chatAttachments, onAttachmentsChange: attachments => one.chatAttachments = attachments,
      });
      activateChatSession(root, 'two');
      readers[1].complete(); readers[0].complete();
      expect(root.chatAttachments).toEqual([]); expect(one.chatAttachments).toHaveLength(2);
      clearChatSessions(root); readers[0].complete(); expect(root.chatAttachments).toEqual([]);
      clearChatViewCaches();
    } finally { vi.unstubAllGlobals(); }
  });
});
