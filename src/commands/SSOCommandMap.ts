import { TurnContext } from "botbuilder";

export abstract class SSOCommand {
  // Define abstract methods that need to be implemented by subclasses
  abstract execute(context: TurnContext): void;
}

export class SSOCommandMap {
  private static commands: Map<string, SSOCommand> = new Map();

  public static register(commandName: string, command: SSOCommand): void {
    this.commands.set(commandName, command);
  }

  public static get(commandName: string): SSOCommand | undefined {
    return this.commands.get(commandName);
  }
}