import { describe, expect, it } from "bun:test";
import { en, Faker } from "@faker-js/faker";
import { randomLcg } from "d3-random";
import { referenceAlgorithm } from "../../scenarios/brute-force-login/reference";
import type { GenContext } from "../endpoint";
import { authV1 } from "./formats/auth-v1";
import { type AuthRecord, generateAuth } from "./internal";

/** A seeded GenContext, the way the Scenario builds one. */
function context(seed: number, over: Partial<GenContext> = {}): GenContext {
  const faker = new Faker({ locale: en });
  faker.seed(seed);
  return {
    rng: randomLcg(seed),
    faker,
    ts: 0,
    account: "root",
    outcome: "fail",
    ...over,
  };
}

describe("generateAuth", () => {
  it("is deterministic for a seed and intent", () => {
    const a = generateAuth(context(7));
    const b = generateAuth(context(7));
    expect(a).toEqual(b);
  });

  it("renders the intent's identity, time, and outcome", () => {
    const r = generateAuth(context(7, { ts: 42, account: "alice", outcome: "fail" }));
    expect(r.ts).toBe(42);
    expect(r.account).toBe("alice");
    expect(r.outcome).toBe("fail");
    expect(r.sourceIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe("authV1.format", () => {
  const record: AuthRecord = { ts: 42, account: "root", sourceIp: "10.0.0.1", outcome: "fail" };

  it("has the endpoint id", () => {
    expect(authV1.id).toBe("auth-v1");
  });

  it("maps every field, uppercasing the outcome", () => {
    expect(authV1.format(record)).toEqual({ t: 42, u: "root", src: "10.0.0.1", res: "FAILURE" });
    expect(authV1.format({ ...record, outcome: "success" }).res).toBe("SUCCESS");
  });
});

describe("reference normalize round trip", () => {
  it("recovers user, sourceIp, and outcome from an auth-v1 record", () => {
    const record: AuthRecord = { ts: 5, account: "root", sourceIp: "10.0.0.1", outcome: "fail" };
    const raw = authV1.format(record);
    expect(referenceAlgorithm.normalize(raw)).toEqual({
      user: "root",
      sourceIp: "10.0.0.1",
      outcome: "fail",
    });
    const ok = authV1.format({ ...record, outcome: "success" });
    expect(referenceAlgorithm.normalize(ok).outcome).toBe("success");
  });
});
