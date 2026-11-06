import type { QuotaSource } from "../lib/types.js";

const source: QuotaSource = {
	async getUsage() {
		return {
			snapshots: [{
				limitId: "monthly",
				label: "Monthly",
				spend: 12,
				quota: 100,
				windowStart: 0,
				windowEnd: 10_000,
				asOf: 9_000,
			}],
			modelLimitIds: {
				"premium-model": ["monthly", "premium-weekly"],
			},
		};
	},
};

export default source;
