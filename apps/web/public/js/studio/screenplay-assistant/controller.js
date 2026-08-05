import { api } from '../../core/api.js';
import { assistantUiStore, projectStore } from '../../core/store.js';
import { AssistantPanel } from './AssistantPanel.js';

const MAX_MESSAGES = 200;

function newMessage(role, content, extra = {}) {
  return { id: crypto.randomUUID(), role, content, createdAt: new Date().toISOString(), ...extra };
}

export function initScreenplayAssistant({ container }, {
  getCurrentRecord, appendScriptText, getScriptText, getProvider, getFallbackPolicy, setStatus, persist,
} = {}) {
  const getMessages = () => getCurrentRecord?.()?.screenplayAssistant?.messages || [];

  // Mutates the in-memory record directly (matching how saveStoryboard() mutates it elsewhere)
  // and lets `persist` queue the same debounced whole-document sync every other edit already uses.
  const pushMessages = (...added) => {
    const record = getCurrentRecord?.();
    if (!record) return;
    const existing = record.screenplayAssistant?.messages || [];
    record.screenplayAssistant = { version: 1, messages: [...existing, ...added].slice(-MAX_MESSAGES) };
    persist?.();
  };

  const panel = new AssistantPanel({
    container,
    getMessages,
    getState: () => assistantUiStore.get(),
    onOpen: () => assistantUiStore.set({ open: true, minimized: false }),
    onMinimize: () => assistantUiStore.set((state) => ({ minimized: !state.minimized })),
    onClose: () => assistantUiStore.set({ open: false, minimized: false }),
    onSend: async (userMessage) => {
      const record = getCurrentRecord?.();
      if (!record) return;
      const history = getMessages().map(({ role, content }) => ({ role, content }));
      pushMessages(newMessage('user', userMessage));
      panel.render();
      try {
        const response = await api('/api/screenplay-assistant/chat', {
          method: 'POST',
          body: JSON.stringify({
            projectId: record.id,
            scriptText: getScriptText?.() || '',
            messages: history,
            userMessage,
            provider: getProvider?.() || 'gemini',
            fallbackPolicy: getFallbackPolicy?.() || 'local',
          }),
        });
        pushMessages(newMessage('assistant', response.reply));
      } catch (error) {
        setStatus?.(`Assistant unavailable: ${error.message}`);
      }
    },
    onAddLines: async () => {
      const record = getCurrentRecord?.();
      if (!record) return;
      try {
        const response = await api('/api/screenplay-assistant/add-lines', {
          method: 'POST',
          body: JSON.stringify({
            projectId: record.id,
            scriptText: getScriptText?.() || '',
            lineCount: 10,
            provider: getProvider?.() || 'gemini',
            fallbackPolicy: getFallbackPolicy?.() || 'local',
          }),
        });
        if (!response.addedText) {
          setStatus?.('The assistant could not generate a continuation.');
          return;
        }
        appendScriptText?.(response.addedText);
        pushMessages(newMessage('assistant', response.addedText, { insertedIntoScript: true }));
      } catch (error) {
        setStatus?.(`Assistant unavailable: ${error.message}`);
      }
    },
  });

  assistantUiStore.subscribe(() => panel.render());
  // Refreshes the visible transcript when the open project changes (matches the projectStore
  // subscription pattern in shared/workbar.js) so switching projects never shows a stale chat.
  projectStore.subscribe(() => panel.render());

  return { destroy: () => panel.destroy() };
}
