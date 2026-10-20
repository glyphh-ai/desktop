/**
 * Jev decisions: every call is GlyphhRouter's POST /v1/systemone on the member's
 * gateway key, in TypeSafe's shape; requests are checked before they leave;
 * 429/529 back off and retry; routing is a pure function of the answer.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  SystemOneClient, jevDecide, jevRoute, pickBranch, routeRequest, validateDecideRequest, decisionSummary, decisionLine,
  type JevChoiceAnswer, type JevNoulAnswer, type JevScoreAnswer,
} from "../../src/resources/systemone.js";
import { ApiError, AuthError, ConnectError, ProtocolError, ValidationError } from "../../src/core/errors.js";
import type { GatewayClient } from "../../src/resources/gateway.js";

type Call = { url: string; init: RequestInit };

function fetcher(replies: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies.shift();
    if (!r) throw new Error("no reply scripted");
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, ...(r.headers ? { headers: r.headers } : {}) });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const conn = (impl: typeof fetch, extra: object = {}) => ({ baseUrl: "https://gw.example/", token: "sk-member", fetch: impl, sleep: async () => {}, ...extra });

const choiceAnswer = (probabilities: Record<string, number>, confidence = 0.9, choice?: string) => ({
  type: "choice", choice: choice ?? Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0], probabilities, confidence,
});

const ok = (answers: Record<string, unknown>) => ({ body: { model: "jev-1.13.0", answers, usage: { input_tokens: 300, output_tokens: 18 } } });

describe("jevDecide", () => {
  it("POSTs TypeSafe's shape to GlyphhRouter's /v1/systemone on the bearer, and types the answers from the questions", async () => {
    const { impl, calls } = fetcher([ok({
      urgent: { type: "noul", noul: 0.93 },
      team: choiceAnswer({ billing: 0.8, tech: 0.2 }),
      anger: { type: "score", score: 1.1, legend: { 0: "Calm", 1: "Upset", 2: "Furious" }, probabilities: { 0: 0.02, 1: 0.86, 2: 0.12 }, confidence: 0.85 },
    })]);
    const res = await jevDecide(conn(impl), {
      state: "Checkout keeps crashing and I need this fixed today.",
      questions: {
        urgent: { type: "noul", instructions: "Is this urgent?" },
        team: { type: "choice", instructions: "Which team?", criteria: { billing: "money", tech: null } },
        anger: { type: "score", instructions: "How upset?", criteria: ["Calm", "Upset", "Furious"] },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gw.example/v1/systemone");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-member");
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.model).toBe("jev-latest");
    expect(sent.questions.team).toEqual({ type: "choice", instructions: "Which team?", criteria: { billing: "money", tech: null } });
    expect(res.model).toBe("jev-1.13.0");
    expect(res.answers.urgent.noul).toBe(0.93);
    expect(res.answers.team.choice).toBe("billing");
    expect(res.answers.anger.score).toBe(1.1);
    expect(res.usage).toEqual({ input_tokens: 300, output_tokens: 18 });
    expectTypeOf(res.answers.urgent).toEqualTypeOf<JevNoulAnswer>();
    expectTypeOf(res.answers.team).toEqualTypeOf<JevChoiceAnswer<"billing" | "tech">>();
    expectTypeOf(res.answers.anger).toEqualTypeOf<JevScoreAnswer>();
    // the log form: chosen values + confidence, nothing else
    expect(decisionSummary(res.answers)).toEqual({
      urgent: { type: "noul", noul: 0.93 }, team: { type: "choice", choice: "billing", confidence: 0.9 }, anger: { type: "score", score: 1.1, confidence: 0.85 },
    });
    expect(decisionLine(res.answers)).toBe("urgent=0.93, team=billing (0.90), anger=1.10 (0.85)");
  });

  it("refuses a malformed request before sending it", async () => {
    const { impl, calls } = fetcher([]);
    const bad = [
      { state: "x", questions: {} },
      { state: "x", questions: { q: { type: "Choice", instructions: "pick", criteria: { a: null } } } },
      { state: "x", questions: { q: { type: "choice", instructions: "pick" } } },
      { state: "x", questions: { q: { type: "choice", instructions: "pick", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null])) } } },
      { state: "x", questions: { q: { type: "score", instructions: "rate", criteria: ["only one"] } } },
      { state: "x", questions: { q: { type: "score", instructions: "rate", criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) } } },
      { state: "x", questions: { q: { type: "noul", instructions: "yes?", criteria: { maybe: "x" } } } },
      { state: "x", questions: { q: { type: "noul", instructions: "" } } },
      { questions: { q: { type: "noul", instructions: "yes?" } } },
    ];
    for (const req of bad) {
      await expect(jevDecide(conn(impl), req as never)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
    // the limits themselves are allowed
    expect(() => validateDecideRequest({ state: { a: 1 }, questions: { q: { type: "choice", instructions: "pick", criteria: Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`o${i}`, null])) } } })).not.toThrow();
    expect(() => validateDecideRequest({ state: ["a"], questions: { q: { type: "score", instructions: { ask: "rate" }, criteria: ["lo", "hi"] } } })).not.toThrow();
  });

  it("backs off and retries 429/529, then gives up as a retryable ApiError", async () => {
    const waits: number[] = [];
    const { impl, calls } = fetcher([
      { status: 429, body: { error: "slow down" } },
      { status: 529, body: { error: "overloaded" } },
      ok({ q: { type: "noul", noul: 1 } }),
    ]);
    const res = await jevDecide(conn(impl, { sleep: async (ms: number) => { waits.push(ms); }, retryBaseMs: 100 }), { state: "s", questions: { q: { type: "noul", instructions: "yes?" } } });
    expect(res.answers.q.noul).toBe(1);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([100, 200]);

    const { impl: busy } = fetcher([{ status: 529, body: "busy" }, { status: 529, body: "busy" }]);
    const err = await jevDecide(conn(busy, { retries: 1 }), { state: "s", questions: { q: { type: "noul", instructions: "yes?" } } }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ httpStatus: 529, code: "E_OVERLOADED", retryable: true });
  });

  it("maps 402 to the budget wall, 422 to ValidationError, 401 to AuthError; a dead socket is ConnectError; a missing answer is a ProtocolError", async () => {
    const req = { state: "s", questions: { q: { type: "noul" as const, instructions: "yes?" } } };
    const wall = await jevDecide(conn(fetcher([{ status: 402, body: { error: { message: "budget reached" } } }]).impl), req).catch((e) => e);
    expect(wall).toMatchObject({ code: "E_PAYMENT", httpStatus: 402, message: "budget reached" });
    const v = await jevDecide(conn(fetcher([{ status: 422, body: { detail: "questions.q.criteria" } }]).impl), req).catch((e) => e);
    expect(v).toBeInstanceOf(ValidationError);
    expect(v.message).toContain("questions.q.criteria");
    expect(await jevDecide(conn(fetcher([{ status: 401, body: {} }]).impl), req).catch((e) => e)).toBeInstanceOf(AuthError);
    const dead = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await jevDecide(conn(dead), req).catch((e) => e)).toBeInstanceOf(ConnectError);
    expect(await jevDecide(conn(fetcher([ok({})]).impl), req).catch((e) => e)).toBeInstanceOf(ProtocolError);
  });
});

describe("routing — deterministic", () => {
  const branches = ["refund", "escalate", "ignore"] as const;

  it("the highest probability wins; a tie goes to the branch listed first; the same answer always gives the same branch", () => {
    expect(pickBranch(choiceAnswer({ refund: 0.2, escalate: 0.7, ignore: 0.1 }) as JevChoiceAnswer, branches).branch).toBe("escalate");
    const tie = choiceAnswer({ refund: 0.1, escalate: 0.45, ignore: 0.45 }, 0.5, "ignore") as JevChoiceAnswer;
    expect(pickBranch(tie, branches).branch).toBe("escalate");
    expect(pickBranch(tie, ["ignore", "escalate", "refund"]).branch).toBe("ignore");
    const runs = Array.from({ length: 20 }, () => pickBranch(tie, branches).branch);
    expect(new Set(runs).size).toBe(1);
    // every branch is listed in probabilities, absent ones as 0
    expect(pickBranch(choiceAnswer({ refund: 1 }) as JevChoiceAnswer, branches).probabilities).toEqual({ refund: 1, escalate: 0, ignore: 0 });
  });

  it("under minConfidence the fallback is taken", () => {
    const shaky = choiceAnswer({ refund: 0.4, escalate: 0.35, ignore: 0.25 }, 0.4) as JevChoiceAnswer;
    expect(pickBranch(shaky, branches, { minConfidence: 0.6, fallback: "human" })).toMatchObject({ branch: "human", fellBack: true, confidence: 0.4 });
    expect(pickBranch(shaky, branches, { minConfidence: 0.3, fallback: "human" })).toMatchObject({ branch: "refund", fellBack: false });
  });

  it("route asks one choice question whose options are the branches, and returns the winner", async () => {
    const { impl, calls } = fetcher([ok({ route: choiceAnswer({ refund: 0.1, escalate: 0.8, ignore: 0.1 }, 0.82) })]);
    const r = await jevRoute(conn(impl), { ticket: "charged twice" }, { refund: "money back", escalate: "a human looks", ignore: null }, { instructions: "What should support do?" });
    expect(r).toMatchObject({ branch: "escalate", confidence: 0.82, fellBack: false, model: "jev-1.13.0" });
    expectTypeOf(r.branch).toEqualTypeOf<"refund" | "escalate" | "ignore">();
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toEqual({
      model: "jev-latest",
      state: { ticket: "charged twice" },
      questions: { route: { type: "choice", instructions: "What should support do?", criteria: { refund: "money back", escalate: "a human looks", ignore: null } } },
    });
    expect(routeRequest("s", ["a", "b"]).questions.route.criteria).toEqual({ a: null, b: null });
  });

  it("route refuses fewer than two branches, duplicates, and minConfidence without a fallback", async () => {
    const { impl, calls } = fetcher([]);
    await expect(jevRoute(conn(impl), "s", ["only"])).rejects.toBeInstanceOf(ValidationError);
    await expect(jevRoute(conn(impl), "s", ["a", "a"])).rejects.toBeInstanceOf(ValidationError);
    await expect(jevRoute(conn(impl), "s", ["a", "b"], { minConfidence: 0.5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(jevRoute(conn(impl), "s", ["a", "b"], { minConfidence: 2, fallback: "a" })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("SystemOneClient (client.decide / client.route)", () => {
  function gateway(token: { baseUrl: string; token: string; gateway?: boolean } = { baseUrl: "https://gw.example", token: "sk-member", gateway: true }) {
    let minted = 0;
    const gw = { token: async () => { minted++; return token; } } as unknown as GatewayClient;
    return { gw, minted: () => minted };
  }

  it("mints the gateway credential once, and drops it on a 401", async () => {
    const { gw, minted } = gateway();
    const { impl, calls } = fetcher([
      ok({ q: { type: "noul", noul: 0 } }),
      ok({ route: choiceAnswer({ a: 0.6, b: 0.4 }) }),
      { status: 401, body: { error: "expired" } },
      ok({ q: { type: "noul", noul: 1 } }),
    ]);
    const so = new SystemOneClient(gw, impl, { sleep: async () => {} });
    const q = { q: { type: "noul" as const, instructions: "yes?" } };
    expect((await so.decide({ state: "s", questions: q })).answers.q.noul).toBe(0);
    expect((await so.route("s", ["a", "b"])).branch).toBe("a");
    expect(minted()).toBe(1);
    await expect(so.decide({ state: "s", questions: q })).rejects.toBeInstanceOf(AuthError);
    expect((await so.decide({ state: "s", questions: q })).answers.q.noul).toBe(1);
    expect(minted()).toBe(2);
    expect(calls.every((c) => c.url === "https://gw.example/v1/systemone")).toBe(true);
  });

  it("refuses when GlyphhRouter is off for the org", async () => {
    const { gw } = gateway({ baseUrl: "https://gw.example", token: "sk", gateway: false });
    const err = await new SystemOneClient(gw, fetcher([]).impl).decide({ state: "s", questions: { q: { type: "noul", instructions: "yes?" } } }).catch((e) => e);
    expect(err).toMatchObject({ code: "E_ENTITLEMENT", message: expect.stringContaining("GlyphhRouter") });
  });
});
