import { describe, expect, it } from "vitest";
import type { EventRecord } from "./api";
import {
  approvalCommandIsLong,
  parsePendingInteraction,
  questionItemIsAnswered
} from "./pendingInteractions";

function pendingEvent(name: string, pending: Record<string, unknown>): EventRecord {
  return {
    id: "pending-1",
    sessionId: "session-a",
    seq: 1,
    type: "tool.pending",
    data: { name, pending },
    createdAt: "2026-07-16T00:00:00Z"
  };
}

describe("pending interactions", () => {
  it("parses structured single and multiple choice questions", () => {
    const interaction = parsePendingInteraction(pendingEvent("question", {
      kind: "question",
      questions: [
        {
          id: "direction",
          header: "Direction",
          question: "Which direction?",
          multiple: true,
          options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" }
          ]
        }
      ]
    }));

    expect(interaction.kind).toBe("question");
    if (interaction.kind !== "question") return;
    expect(interaction.questionSet.questions[0]).toMatchObject({
      id: "direction",
      multiple: true,
      allowCustom: true
    });
  });

  it("restores legacy plain text questions as freeform input", () => {
    const interaction = parsePendingInteraction(pendingEvent("question", {
      kind: "question",
      question: "What should I use?"
    }));

    expect(interaction.kind).toBe("question");
    if (interaction.kind !== "question") return;
    expect(interaction.questionSet.legacy).toBe(true);
    expect(interaction.questionSet.questions[0]?.options).toEqual([]);
  });

  it("parses legacy plan_exit as a plan to agent transition", () => {
    const interaction = parsePendingInteraction(pendingEvent("plan_exit", {
      kind: "plan_exit",
      reason: "Plan complete"
    }));

    expect(interaction).toEqual({
      kind: "mode_change",
      modeChange: {
        version: 1,
        kind: "mode_change",
        fromMode: "plan",
        targetMode: "agent",
        reason: "Plan complete",
        planPath: null
      }
    });
  });

  it("accepts either a valid selection or supplemental text", () => {
    const question = {
      id: "direction",
      header: "Direction",
      question: "Which direction?",
      multiple: false,
      options: [
        { label: "A", description: "First" },
        { label: "B", description: "Second" }
      ],
      allowCustom: true as const
    };

    expect(questionItemIsAnswered(question, ["A"], "")).toBe(true);
    expect(questionItemIsAnswered(question, [], "Custom direction")).toBe(true);
    expect(questionItemIsAnswered(question, [], " ")).toBe(false);
    expect(questionItemIsAnswered(question, ["A", "B"], "")).toBe(false);
  });

  it("only compacts approval commands beyond the line or character limit", () => {
    expect(approvalCommandIsLong("short command")).toBe(false);
    expect(approvalCommandIsLong(Array.from({ length: 8 }, () => "line").join("\n"))).toBe(false);
    expect(approvalCommandIsLong(Array.from({ length: 9 }, () => "line").join("\n"))).toBe(true);
    expect(approvalCommandIsLong("x".repeat(600))).toBe(false);
    expect(approvalCommandIsLong("x".repeat(601))).toBe(true);
  });
});
