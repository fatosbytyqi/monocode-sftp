/** Commands to type into a terminal once its shell starts (e.g. "Open SSH in Terminal"). */
const pending = new Map<string, string>();

export function setStartupCommand(terminalId: string, command: string) {
  pending.set(terminalId, command);
}

export function takeStartupCommand(terminalId: string): string | undefined {
  const command = pending.get(terminalId);
  pending.delete(terminalId);
  return command;
}

/** Fired on `window` to open a new terminal tab running a command. */
export const OPEN_TERMINAL_COMMAND_EVENT = "monocode:open-terminal-command";

export type OpenTerminalCommandDetail = {
  cwd: string;
  command: string;
  title?: string;
};
