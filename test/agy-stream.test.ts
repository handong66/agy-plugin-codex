import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAgyRun, readStreamProgress } from "../plugins/agy-plugin-codex/src/agy-cli.js";

/** Verbatim recordings of the real agy 1.1.16 CLI. */
function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

describe("parseAgyRun on a successful stream-json run", () => {
  const parsed = parseAgyRun(fixture("agy-run-success.jsonl"));

  it("returns agy's own final answer and verdict", () => {
    expect(parsed).not.toBeNull();
    expect(parsed?.text).toBe("OK");
    expect(parsed?.status).toBe("SUCCESS");
    expect(parsed?.conversationId).toBe("5347faf1-5d39-4a25-8034-502a185fdaf4");
    expect(parsed?.errorText).toBeUndefined();
  });

  it("reports the model and permission posture agy itself named", () => {
    // observedModel is read off the init event, never inferred from the flags this
    // plugin believes it passed.
    expect(parsed?.observedModel).toBe("gemini-3.7-flash-low");
    // "always-proceed" is what --dangerously-skip-permissions produces. In agy
    // 1.1.18 E1, request-review denied a tool call and terminated without an answer.
    expect(parsed?.permissionMode).toBe("always-proceed");
    expect(parsed?.reportedCwd).toBe("/tmp/agy-probe");
  });

  it("counts no tool calls for a run that used no tools", () => {
    expect(parsed?.toolCallCount).toBe(0);
    expect(parsed?.filesInspected).toBe(0);
    expect(parsed?.toolNames).toEqual([]);
  });

  it("records that the terminal result event arrived, with its usage and turn count", () => {
    expect(parsed?.sawResultEvent).toBe(true);
    expect(parsed?.lastEventType).toBe("result");
    expect(parsed?.numTurns).toBe(1);
    expect(parsed?.turnsUsed).toBe(1);
    expect(parsed?.usage).toBeDefined();
    expect(parsed?.usage?.total_tokens).toBe(13743);
    expect(parsed?.durationSeconds).toBe(3.030426);
  });

  it("tallies every event type it saw", () => {
    expect(parsed?.eventCounts).toEqual({ init: 1, step_update: 3, result: 1 });
  });
});

describe("parseAgyRun on a run that used tools", () => {
  const parsed = parseAgyRun(fixture("agy-run-tool-calls.jsonl"));

  it("counts a tool call once, not once per ACTIVE/DONE emission", () => {
    // Measured: agy emits every tool call TWICE under the same step_index -- ACTIVE
    // with the parameters, then DONE with the output. The recording holds four tool
    // step_updates for two calls, and the tool-call count is what decides whether a
    // review is evidence or an opinion.
    expect(parsed?.toolCallCount).toBe(2);
    expect(parsed?.eventCounts.step_update).toBe(8);
  });

  it("keeps the tool names in call order without repeating them", () => {
    expect(parsed?.toolNames).toEqual(["view_file", "run_command"]);
  });

  it("counts only parameters that name a file, not every tool argument", () => {
    // view_file's AbsolutePath is a path; run_command's CommandLine is a shell line
    // and is deliberately not counted as an inspected file. Undercounting evidence
    // makes a review look thinner than it was, never richer.
    expect(parsed?.filesInspected).toBe(1);
  });

  it("prefers the result document's response over the streamed deltas", () => {
    expect(parsed?.text).toBe("The file contains: hello-agy");
    expect(parsed?.status).toBe("SUCCESS");
    expect(parsed?.numTurns).toBe(2);
  });
});

describe("parseAgyRun when no result event ever arrives", () => {
  // An ACTIVE agent_response delta that ends mid-word, continued by its DONE delta,
  // and nothing else: the shape a run killed before its result event leaves behind.
  const stream = [
    JSON.stringify({
      event: "init",
      conversation_id: "c0ffee00-0000-4000-8000-000000000001",
      init: { model: "gemini-3.7-flash-low", cwd: "/tmp/agy-probe", permission_mode: "always-proceed" }
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "c0ffee00-0000-4000-8000-000000000001",
        step_index: 2,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "The file contains: hello-"
      }
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "c0ffee00-0000-4000-8000-000000000001",
        step_index: 2,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "agy"
      }
    })
  ].join("\n");

  const parsed = parseAgyRun(stream);

  it("concatenates the deltas in order, because they are incremental and not cumulative", () => {
    // Measured: an ACTIVE step ended mid-word and its DONE step continued from the
    // next character, and concatenating every delta in order reproduces
    // result.response exactly. Taking the last delta alone would return "agy".
    expect(parsed?.text).toBe("The file contains: hello-agy");
  });

  it("says the run never reached its terminal event", () => {
    expect(parsed?.sawResultEvent).toBe(false);
    expect(parsed?.status).toBeUndefined();
    // The conversation id still comes off the init event, so the work is resumable.
    expect(parsed?.conversationId).toBe("c0ffee00-0000-4000-8000-000000000001");
    expect(parsed?.turnsUsed).toBe(1);
  });
});

describe("parseAgyRun on the plain --output-format json form", () => {
  const parsed = parseAgyRun(fixture("agy-permission-denied.json"));

  it("reads a bare result document that has no event envelope", () => {
    expect(parsed).not.toBeNull();
    expect(parsed?.status).toBe("ERROR");
    expect(parsed?.text).toBe("");
    expect(parsed?.errorText).toBe(
      'permission check failed for command "cat a.txt": user denied permission to run command:\ncat a.txt'
    );
    expect(parsed?.conversationId).toBe("8ad688a0-0a59-48a6-9554-1ef7f0f87c66");
    expect(parsed?.sawResultEvent).toBe(true);
    expect(parsed?.eventCounts).toEqual({ result: 1 });
  });
});

describe("parseAgyRun on unusable stdout", () => {
  it("returns null rather than an empty run for output it cannot read", () => {
    expect(parseAgyRun("")).toBeNull();
    expect(parseAgyRun("   \n  \n")).toBeNull();
    expect(parseAgyRun("not json at all")).toBeNull();
  });

  it("skips malformed lines in the middle of a good stream without losing the result", () => {
    const lines = fixture("agy-run-success.jsonl").trim().split("\n");
    const corrupted = [
      lines[0],
      "{ this line is not json }",
      lines[1],
      "agy: a bare log line on stdout",
      lines[2],
      lines[3],
      lines[4]
    ].join("\n");

    const parsed = parseAgyRun(corrupted);

    expect(parsed?.text).toBe("OK");
    expect(parsed?.status).toBe("SUCCESS");
    expect(parsed?.sawResultEvent).toBe(true);
    // The unreadable lines are dropped, not counted as events of an unknown type.
    expect(parsed?.eventCounts).toEqual({ init: 1, step_update: 3, result: 1 });
  });
});

describe("readStreamProgress", () => {
  const lines = fixture("agy-run-tool-calls.jsonl").trim().split("\n");

  it("agrees with the whole-run parse on how many tool calls happened", () => {
    const total = lines.reduce((sum, line) => sum + readStreamProgress(line).toolCalls, 0);

    // The incremental counter and parseAgyRun must not disagree: both count the DONE
    // emission only, so the live status of a job matches its finished record.
    expect(total).toBe(2);
    expect(total).toBe(parseAgyRun(fixture("agy-run-tool-calls.jsonl"))?.toolCallCount);
  });

  it("reports the model and permission mode off the init line", () => {
    const progress = readStreamProgress(lines[0]);

    expect(progress.model).toBe("gemini-3.7-flash-low");
    expect(progress.permissionMode).toBe("always-proceed");
    expect(progress.conversationId).toBe("23953eab-a613-4b7a-a647-ae24ec519f38");
    expect(progress.toolCalls).toBe(0);
    expect(progress.terminal).toBeUndefined();
  });

  it("marks the result line terminal", () => {
    const progress = readStreamProgress(lines[lines.length - 1]);

    expect(progress.terminal).toBe(true);
    expect(progress.conversationId).toBe("23953eab-a613-4b7a-a647-ae24ec519f38");
    expect(progress.toolCalls).toBe(0);
  });

  it("counts the DONE half of a tool call and not the ACTIVE half", () => {
    // Lines 3 and 4 of the recording are the same view_file call, ACTIVE then DONE.
    expect(readStreamProgress(lines[3]).toolCalls).toBe(0);
    expect(readStreamProgress(lines[4]).toolCalls).toBe(1);
  });

  it("ignores a blank line and a malformed line instead of throwing", () => {
    expect(readStreamProgress("")).toEqual({ toolCalls: 0 });
    expect(readStreamProgress("   ")).toEqual({ toolCalls: 0 });
    expect(readStreamProgress("{ half a json object")).toEqual({ toolCalls: 0 });
    expect(readStreamProgress("agy: a bare log line")).toEqual({ toolCalls: 0 });
  });
});

describe("parseAgyRun on agy's own --print-timeout", () => {
  const parsed = parseAgyRun(fixture("agy-print-timeout.jsonl"));

  it("files the run as an error carrying agy's own timeout wording", () => {
    expect(parsed?.status).toBe("ERROR");
    expect(parsed?.errorText).toBe("timeout waiting for response");
    expect(parsed?.text).toBe("");
  });

  it("still yields a conversation id, so the work is resumable", () => {
    // Measured: --print-timeout exits 1 with an empty stderr and a complete result
    // document, and the conversation id is allocated even though no answer arrived.
    expect(parsed?.conversationId).toBe("ab64fdc8-c0d1-4b7b-974f-2bf5336579e8");
    expect(parsed?.sawResultEvent).toBe(true);
  });
});
