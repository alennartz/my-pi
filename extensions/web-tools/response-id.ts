import { randomBytes } from "node:crypto";

/** Short random id identifying a search response for follow-up retrieval. */
export function newResponseId(): string {
	return randomBytes(6).toString("hex");
}
