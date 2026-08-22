import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  agyFailureMessage,
  classifyAgyErrorText,
  classifyAgyFailure,
  detectConversationMismatch,
  detectPermissionEvidence,
  isRetryableAgyFailure,
  parseAgyRun
} from "../plugins/agy-plugin-codex/src/agy-cli.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

/** The `error` field of a recorded run document -- where agy actually puts the reason. */
function recordedErrorText(name: string): string {
  const parsed = parseAgyRun(fixture(name));
  if (!parsed?.errorText) throw new Error(`fixture ${name} has no error text`);
  return parsed.errorText;
}

const MODEL_NOT_FOUND_ERROR = recordedErrorText("agy-model-not-found.json");
const PERMISSION_DENIED_ERROR = recordedErrorText("agy-permission-denied.json");
const PROTECTED_BOUNDARY_ERROR = recordedErrorText("agy-answered-then-errored.jsonl");

describe("classifyAgyFailure precedence", () => {
  it("calls a timed-out run a timeout whatever else the channels say", () => {
    expect(
      classifyAgyFailure({
        timedOut: true,
        signal: "SIGKILL",
        exitCode: 1,
        stderr: "401 not authenticated",
        errorText: MODEL_NOT_FOUND_ERROR
      })
    ).toBe("timeout");
  });

  it("calls a signalled run terminated, never an auth or model verdict", () => {
    // A non-null signal means something outside agy ended it. That is never a
    // statement about the model or the account.
    expect(classifyAgyFailure({ signal: "SIGTERM", exitCode: null, stderr: "401 unauthenticated" })).toBe(
      "terminated"
    );
    expect(classifyAgyFailure({ signal: "SIGKILL", exitCode: null, errorText: MODEL_NOT_FOUND_ERROR })).toBe(
      "terminated"
    );
  });

  it("reads agy's own error text even when stderr is empty", () => {
    // Measured and load-bearing: an unrecognised --model exits 1 with an EMPTY stderr
    // and the whole explanation inside the result document's `error` field, so a
    // classifier that reads stderr alone files every real agy failure as unknown.
    expect(classifyAgyFailure({ exitCode: 1, stderr: "", errorText: MODEL_NOT_FOUND_ERROR })).toBe(
      "model_not_found"
    );
  });

  it("recognises a headless run carrying a tool-call permission denial", () => {
    expect(classifyAgyFailure({ exitCode: 1, stderr: "", errorText: PERMISSION_DENIED_ERROR })).toBe(
      "permission_denied"
    );
  });

  it("recognises agy's own print-timeout wording", () => {
    expect(classifyAgyFailure({ exitCode: 1, stderr: "", errorText: "timeout waiting for response" })).toBe(
      "timeout"
    );
  });

  it("says unknown when a clean exit left no evidence at all", () => {
    expect(classifyAgyFailure({ exitCode: 0, stderr: "", errorText: "" })).toBe("unknown");
    expect(classifyAgyFailure({ exitCode: 0 })).toBe("unknown");
  });

  it("falls back to agy_failed for a non-zero exit with nothing recognisable in it", () => {
    expect(classifyAgyFailure({ exitCode: 2, stderr: "", errorText: "" })).toBe("agy_failed");
    expect(classifyAgyFailure({ exitCode: 1, stderr: "something odd happened" })).toBe("agy_failed");
  });
});

describe("classifyAgyErrorText", () => {
  it("classifies nothing for empty input", () => {
    expect(classifyAgyErrorText("")).toBeUndefined();
    expect(classifyAgyErrorText("   \n ")).toBeUndefined();
  });

  it("does not read ordinary model prose as a missing-model error", () => {
    // agy's own hint names an id ("did you mean: gemini-3.7-flash-low"). A bare
    // "did you mean" is ordinary English and a model asking it is not an error.
    expect(classifyAgyErrorText("Did you mean to run the tests first?")).not.toBe("model_not_found");
    expect(classifyAgyErrorText("Did you mean to run the tests first?")).toBeUndefined();
  });

  it("does not read a passing mention of billing as an exhausted quota", () => {
    expect(classifyAgyErrorText("I reviewed the billing module and it looks fine.")).not.toBe(
      "quota_exhausted"
    );
    expect(classifyAgyErrorText("The invoice mentions billing for last month.")).toBeUndefined();
  });

  it("still classifies the wordings agy really emits", () => {
    expect(classifyAgyErrorText(MODEL_NOT_FOUND_ERROR)).toBe("model_not_found");
    expect(classifyAgyErrorText(PERMISSION_DENIED_ERROR)).toBe("permission_denied");
    expect(classifyAgyErrorText("timeout waiting for response")).toBe("timeout");
  });
});

describe("isRetryableAgyFailure", () => {
  it("refuses to retry a class that provably cannot succeed unchanged", () => {
    for (const errorClass of [
      "quota_exhausted",
      "auth_required",
      "model_unauthorized",
      "model_not_found",
      "permission_denied"
    ]) {
      expect(isRetryableAgyFailure(errorClass)).toBe(false);
    }
  });

  it("allows a retry for anything that could plausibly go differently", () => {
    for (const errorClass of ["rate_limited", "network_error", "timeout", "provider_error", "agy_failed"]) {
      expect(isRetryableAgyFailure(errorClass)).toBe(true);
    }
  });

  it("does not invite a retry when there is no class at all", () => {
    expect(isRetryableAgyFailure(undefined)).toBe(false);
  });
});

describe("agyFailureMessage", () => {
  const CLASSES = [
    "quota_exhausted",
    "auth_required",
    "model_unauthorized",
    "model_not_found",
    "rate_limited",
    "network_error",
    "provider_error",
    "permission_denied",
    "terminated",
    "timeout",
    "stalled",
    "agy_failed"
  ];

  it("gives every named class its own non-empty sentence", () => {
    const messages = CLASSES.map((errorClass) => agyFailureMessage(errorClass));

    for (const message of messages) {
      expect(message.trim().length).toBeGreaterThan(0);
      expect(message.trim().endsWith(".")).toBe(true);
    }
    // A shared sentence would tell the caller to do the same thing about an exhausted
    // balance and a transient overload.
    expect(new Set(messages).size).toBe(CLASSES.length);
  });

  it("falls back to a generic sentence for a class it does not know", () => {
    const fallback = agyFailureMessage("not_a_real_class");

    expect(fallback).toBe("agy exited without a usable final result.");
    expect(CLASSES.map((errorClass) => agyFailureMessage(errorClass))).not.toContain(fallback);
  });
});

describe("detectPermissionEvidence", () => {
  it("finds a denied tool call in the run document when stderr is empty", () => {
    // Measured: the evidence is in the run document's `error` field on stdout, with
    // stderr empty -- the opposite of where a stderr-only guard would look.
    const evidence = detectPermissionEvidence("", { errorText: PERMISSION_DENIED_ERROR });

    expect(evidence).toHaveLength(1);
    expect(evidence[0].class).toBe("permission_auto_denied");
    // The whole quoted command, not just its first word: a message naming `cat`
    // when agy was denied `cat a.txt` sends the reader looking for a problem with a
    // program rather than with a path.
    expect(evidence[0].target).toBe("cat a.txt");
    expect(evidence[0].message).toContain("cat");
    expect(evidence[0].message).toContain("--dangerously-skip-permissions");
  });

  it("finds a path agy protects regardless of --dangerously-skip-permissions", () => {
    const evidence = detectPermissionEvidence("", { errorText: PROTECTED_BOUNDARY_ERROR });

    expect(evidence).toHaveLength(1);
    expect(evidence[0].class).toBe("protected_path_blocked");
    expect(evidence[0].target).toBe("/Users/x/.gemini/antigravity-cli/brain/n.txt");
    expect(evidence[0].message).toContain("read_file");
  });

  it("reports one entry per distinct target however often it repeats", () => {
    const repeated = [PERMISSION_DENIED_ERROR, PERMISSION_DENIED_ERROR, PERMISSION_DENIED_ERROR].join("\n");
    const evidence = detectPermissionEvidence(repeated, { errorText: repeated });

    expect(evidence).toHaveLength(1);
  });

  it("flags a run that was never pointed at the workspace it was meant to see", () => {
    const evidence = detectPermissionEvidence("a.txt does not exist in the current working directory", {
      cwd: "/repo"
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0].class).toBe("workspace_not_targeted");
    expect(evidence[0].target).toBe("/repo");
    expect(evidence[0].message).toContain("--add-dir");
  });

  it("stays silent when the workspace is unknown or nothing went wrong", () => {
    // Without a cwd there is nothing to name, so the note would be advice with no
    // subject.
    expect(
      detectPermissionEvidence("a.txt does not exist in the current working directory")
    ).toEqual([]);
    expect(detectPermissionEvidence("", { errorText: "" })).toEqual([]);
  });
});

describe("detectConversationMismatch", () => {
  it("has nothing to say when no conversation was requested", () => {
    expect(detectConversationMismatch({})).toBeNull();
    expect(detectConversationMismatch({ observedConversationId: "b", stderr: "" })).toBeNull();
  });

  it("has nothing to say when the resume landed where it asked to", () => {
    expect(
      detectConversationMismatch({
        requestedConversationId: "a",
        observedConversationId: "a",
        stderr: ""
      })
    ).toBeNull();
  });

  it("reports agy's own not-found warning on stderr", () => {
    const message = detectConversationMismatch({
      requestedConversationId: "5347faf1-5d39-4a25-8034-502a185fdaf4",
      stderr: 'warning: conversation "5347faf1-5d39-4a25-8034-502a185fdaf4" not found\n'
    });

    expect(message).toContain("conversation_not_found");
    expect(message).toContain("5347faf1-5d39-4a25-8034-502a185fdaf4");
  });

  it("reports a drifted id even when stderr is empty", () => {
    // This is the case that matters: an unknown --conversation does NOT fail. agy
    // exits 0, reports SUCCESS, and answers from a FRESH conversation with none of
    // the context the caller thinks it has. Comparing ids is the only detection.
    const message = detectConversationMismatch({
      requestedConversationId: "aaaaaaaa-0000-4000-8000-000000000001",
      observedConversationId: "bbbbbbbb-0000-4000-8000-000000000002",
      stderr: ""
    });

    expect(message).toContain("conversation_not_found");
    expect(message).toContain("aaaaaaaa-0000-4000-8000-000000000001");
    expect(message).toContain("bbbbbbbb-0000-4000-8000-000000000002");
    expect(message).toContain("SUCCESS");
  });
});
