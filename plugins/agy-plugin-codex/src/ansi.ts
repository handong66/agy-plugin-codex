/** The escape byte a TTY-formatting CLI writes even when its output is piped. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/**
 * CSI sequences (`ESC [ ... final`) and OSC strings (`ESC ] ... BEL|ESC \`), built
 * from character codes so the source file stays plain ASCII.
 */
const ANSI_PATTERN = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  "g"
);

/**
 * `agy models` draws its listing for a terminal even when stdout is a pipe, and
 * `agy_check` publishes that listing into the caller's transcript. Escapes are
 * stripped before anything crosses the wire so control bytes are never carried as
 * if they were content.
 */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
