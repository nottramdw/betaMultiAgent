import { PROTOCOL_VERSION } from "@betamultiagent/core";
import { describe, expect, it } from "vitest";

describe("workspace resolution", () => {
  it("resolves internal packages to source without a build", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
