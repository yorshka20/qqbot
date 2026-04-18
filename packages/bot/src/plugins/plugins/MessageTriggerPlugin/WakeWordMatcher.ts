// WakeWordMatcher - wake word / preference trigger matching logic

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { ProactiveConversationService } from '@/conversation/proactive';

export type WakeWordTriggerSource = 'wakeWordPreference' | 'wakeWordConfig';

/**
 * Handles all wake-word matching for MessageTriggerPlugin.
 * Preference-based words (from ProactiveConversationService template keys) are checked
 * before config-level global wake words.
 */
export class WakeWordMatcher {
  constructor(
    private readonly globalWakeWords: string[],
    private readonly promptManager: PromptManager,
    private readonly proactiveConversationService: ProactiveConversationService,
  ) {}

  /**
   * Strip leading segment placeholders (e.g. [Reply:xxx], [Image:xxx]) so that
   * wake-word matching runs against the actual user text.
   */
  getTextForMatch(message: string): string {
    return message.replace(/^(\s*\[[^\]]+\]\s*)+/, '').trim();
  }

  /** Parse a template content string into a list of lowercase trigger words (one per line). */
  private parseTriggerWords(content: string): string[] {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }

  /** Collect all preference-driven wake words for a group. */
  private getGroupPreferenceWords(groupId: string): string[] {
    const preferenceKeys = this.proactiveConversationService?.getGroupPreferenceKeys(groupId) ?? [];
    const words = new Set<string>();
    for (const key of preferenceKeys) {
      const tpl = this.promptManager.getTemplate(`${key}.trigger`);
      for (const word of this.parseTriggerWords(tpl?.content ?? '')) {
        words.add(word);
      }
    }
    return Array.from(words);
  }

  /**
   * Returns which source matched the wake word, or null if none matched.
   * Preference words are checked before config words.
   */
  match(groupId: string | undefined, message: string): WakeWordTriggerSource | null {
    const text = this.getTextForMatch(message).toLowerCase();

    if (groupId) {
      const preferenceWords = this.getGroupPreferenceWords(groupId);
      if (preferenceWords.some((w) => text.includes(w))) {
        return 'wakeWordPreference';
      }
    }

    if (this.globalWakeWords.some((w) => text.includes(w))) {
      return 'wakeWordConfig';
    }

    return null;
  }
}
