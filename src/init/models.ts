import type { AgentName } from "../config/schema.js";
import type { PricingTable } from "../cost.js";

/**
 * Sentinel `select()` value meaning "drop to free-text so I can type a
 * model that isn't in the list". Picked deliberately unlikely to collide
 * with a real model id.
 */
export const CUSTOM_MODEL_VALUE = "__custom__";

export type ModelOption = {
	readonly value: string;
	readonly label: string;
};

/**
 * Build the `ralph init` model-picker options for `agent`: every model in
 * the pricing table tagged with that agent (in table order), followed by a
 * "Custom…" escape hatch. The escape hatch keeps a not-yet-priced model
 * from ever blocking init — the agent CLI validates it and cost degrades
 * to $0 + a warning (see src/cost.ts).
 */
export function modelOptionsForAgent(
	agent: AgentName,
	pricing: PricingTable,
): ReadonlyArray<ModelOption> {
	const models = Object.entries(pricing.models)
		.filter(([, rates]) => rates.agent === agent)
		.map(([id]) => ({ value: id, label: id }));
	return [...models, { value: CUSTOM_MODEL_VALUE, label: "Custom…" }];
}

/**
 * The model pre-highlighted in the picker for `agent`: the first model of
 * that agent in the pricing table. Table order encodes the sensible
 * default (see src/pricing/pricing.json). Falls back to the Custom
 * sentinel when the table prices no model for the agent, so the picker
 * still opens on something selectable.
 */
export function defaultModelForAgent(
	agent: AgentName,
	pricing: PricingTable,
): string {
	const first = Object.entries(pricing.models).find(
		([, rates]) => rates.agent === agent,
	);
	return first === undefined ? CUSTOM_MODEL_VALUE : first[0];
}
