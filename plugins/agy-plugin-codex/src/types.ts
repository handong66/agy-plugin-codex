export type ToolResult<T> = {
  ok: boolean;
  data?: T;
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ProcessResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut?: boolean;
};
