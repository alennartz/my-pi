import { describe, expect, it } from "vitest";
import { required } from "./required.js";

describe("required", () => {
	it("returns the value when it is present", () => {
		expect(required("node", "node")).toBe("node");
	});

	it("throws with the requested label when the value is missing", () => {
		expect(() => required(undefined, "node")).toThrow(/node/);
	});
});
