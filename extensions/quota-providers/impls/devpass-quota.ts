import type { QuotaSource } from "../lib/types.js";

/** DevPass usage source for monthly and premium-weekly quota windows. */
const devpassQuota: QuotaSource = {
	async getUsage(_context) {
		throw new Error("not implemented");
	},
};

export default devpassQuota;
