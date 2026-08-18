import { TurnContext } from 'botbuilder';

export abstract class SSOCommand {
  // Define abstract methods that need to be implemented by subclasses
  abstract execute(context: TurnContext): void;
}

// Lowercase, trim, collapse runs of whitespace and drop trailing sentence
// punctuation so users don't have to type a command character-perfect:
// "Send zap." and "send zap" are the same request.
export const normalizeCommandText = (text: string): string =>
  text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();

export class SSOCommandMap {
  private static commands: Map<string, SSOCommand> = new Map();

  public static register(commandName: string, command: SSOCommand): void {
    this.commands.set(commandName, command);
  }

  public static get(commandName: string): SSOCommand | undefined {
    return this.commands.get(commandName);
  }

  // Tolerant lookup: an exact (normalized) match wins, otherwise a message
  // that starts with a known command name — on a word boundary — counts as
  // that command (e.g. "send zap to bob" runs "send zap").
  public static match(text: string): SSOCommand | undefined {
    const normalized = normalizeCommandText(text);
    if (!normalized) {
      return undefined;
    }
    const exact = this.commands.get(normalized);
    if (exact) {
      return exact;
    }
    for (const [name, command] of this.commands) {
      if (normalized.startsWith(`${name} `)) {
        return command;
      }
    }
    return undefined;
  }

  public static commandNames(): string[] {
    return [...this.commands.keys()];
  }
}
