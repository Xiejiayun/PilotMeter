/** Small, read-only desktop view. No account IDs, credentials, paths, or source contexts. */
export interface WidgetSnapshot {
  state: 'ready' | 'needs-login' | 'waiting' | 'error';
  title: string;
  value: string;
  detail: string;
  /** Confirmed display unit; null when unknown or no amount is selected. */
  unitLabel: 'AI Credits' | 'Premium Requests' | null;
  unitUnspecified: boolean;
  /** A known display ratio in [0, 100]. Unknown, unlimited, zero-limit and overage ratios are null. */
  percentage: number | null;
  accountLogin: string | null;
  /** Time of the displayed quota snapshot, or local summary; empty only for invalid input. */
  updatedAt: string;
}

/** Bind each response to the daemon already verified by the desktop host. */
export interface WidgetResponse extends WidgetSnapshot {
  app: 'pilotmeter';
  version: string;
  instanceId: string;
  /** Local profile identity for rejecting mixed-account responses; never an SDK selection ID. */
  accountId: string | null;
}

export const WIDGET_TEXT_LIMITS = { title: 48, value: 48, detail: 220, accountLogin: 128 } as const;
