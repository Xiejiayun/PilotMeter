import type { AccountModels } from './models.js';

/** Browser DTOs never contain OAuth credentials, SDK selection IDs, or credential paths. */
export interface GitHubProfile {
  id: string;
  login: string;
  host: string;
  status: 'connected' | 'reauth-required' | 'error';
  createdAt: string;
  checkedAt: string | null;
}

export interface AccountQuotaBucket {
  key: string;
  label: string;
  unit: 'ai-credits' | 'premium-requests' | 'unspecified';
  used: string | null;
  limit: string | null;
  remainingPercentage: string | null;
  usedPercentage: string | null;
  unlimited: boolean;
  resetAt: string | null;
}

export interface PersonalQuota {
  accountId: string;
  state: 'available' | 'unavailable' | 'error';
  scope: 'signed-in-user';
  fetchedAt: string | null;
  stale: boolean;
  buckets: AccountQuotaBucket[];
  error: { code: string; message: string } | null;
}

export interface AccountLogin {
  id: string;
  status: 'starting' | 'pending' | 'verifying' | 'complete' | 'cancelled' | 'failed' | 'expired';
  host: string;
  verificationUri: string | null;
  userCode: string | null;
  expiresAt: string | null;
  /** Existing local profile being reauthorized; never proof of completed identity. */
  targetAccountId?: string | null;
  accountId: string | null;
  error: { code: string; message: string } | null;
}

export interface AccountsOverview {
  accounts: GitHubProfile[];
  activeAccountId: string | null;
  quota: PersonalQuota | null;
  models: AccountModels | null;
  login: AccountLogin | null;
  refreshing: boolean;
  enabled: boolean;
  /** Display this command; browser pages never receive the daemon management capability. */
  runCommand: string;
}
