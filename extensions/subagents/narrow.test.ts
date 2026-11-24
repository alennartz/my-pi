import { describe, expect, it } from "vitest";
import { asRecord, booleanField, numberField, stringArrayField, stringField } from "./narrow.js";

describe("asRecord", () => {
	it("returns a record for plain objects", () => {
		expect(asRecord({ a: 1 })).toEqual({ a: 1 });
	});

	it("returns undefined for arrays, null, and primitives", () => {
		expect(asRecord([1])).toBeUndefined();
		expect(asRecord(null)).toBeUndefined();
		expect(asRecord("text")).toBeUndefined();
	});
});

describe("field readers", () => {
	const value = { text: "alpha", count: 3, flag: true, names: ["a", 2, "b"] };

	it("reads fields that match the requested type", () => {
		expect(stringField(value, "text")).toBe("alpha");
		expect(numberField(value, "count")).toBe(3);
		expect(booleanField(value, "flag")).toBe(true);
		expect(stringArrayField(value, "names")).toEqual(["a", "b"]);
	});

	it("returns undefined for a missing field or a wrong type", () => {
		expect(stringField(value, "count")).toBeUndefined();
		expect(numberField(value, "text")).toBeUndefined();
		expect(booleanField(value, "text")).toBeUndefined();
		expect(stringArrayField(value, "text")).toBeUndefined();
		expect(stringField(undefined, "text")).toBeUndefined();
	});
});
