/** K45b: prompt select/tokens/tiers live only in core's built compat/v1. */
export {
  TIER_ORDER,
  STANDARD_MIN_WINDOW,
  FULL_MIN_WINDOW,
  DEFAULT_SELECTION_CONFIG,
  isWindowTrusted,
  rank,
  selectPromptTier,
} from "@neo/core-compat/compat/v1";
export type {
  SelectionMode,
  PromptSelectionConfig,
  SelectInput,
  PromptSelection,
} from "@neo/core-compat/compat/v1";
