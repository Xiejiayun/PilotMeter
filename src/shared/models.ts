/** Account-scoped metadata from the official CLI. No tokens, terms, or opaque account selectors. */
export interface AccountModel {
  id: string;
  name: string;
  status: 'available' | 'disabled' | 'unknown';
  reason: string;
  policyState: 'enabled' | 'disabled' | 'unconfigured' | null;
  vision: boolean | null;
  reasoningEffort: boolean | null;
  contextWindowTokens: number | null;
  /** Explicit upstream billing multiplier; not a price, balance or per-model allowance. */
  multiplier: string | null;
}

export interface AccountModels {
  accountId: string;
  state: 'available' | 'unavailable' | 'error';
  source: 'copilot-cli-models.list';
  fetchedAt: string | null;
  stale: boolean;
  refreshing: boolean;
  items: AccountModel[];
  error: { code: string; message: string } | null;
}
