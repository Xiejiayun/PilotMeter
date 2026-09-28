import type { AccountLogin, GitHubProfile, PersonalQuota } from './accounts.js';
import type { AccountModels } from './models.js';
import type { LocalUsage, SessionSummary } from './types.js';
import type { PersonalQuotaProjection } from '../domain/personal-quota.js';

export interface DesktopLocal extends LocalUsage {
  accountId: string | null;
  source: 'local-otel';
  scope: string;
  retained: boolean;
  updatedAt: string;
}
export interface DesktopRecord extends Omit<SessionSummary, 'sourceContext' | 'coverage'> {
  credits: string | null;
  unitVerified: boolean;
}
export interface DesktopIdentity { app: 'pilotmeter'; version: string; instanceId: string }
export interface DesktopResponse extends DesktopIdentity {
  accounts: GitHubProfile[];
  activeAccountId: string | null;
  login: AccountLogin | null;
  enabled: boolean;
  refreshing: boolean;
  quota: Pick<PersonalQuota, 'accountId' | 'state' | 'fetchedAt' | 'stale' | 'error'> | null;
  presentation: PersonalQuotaProjection;
  models: AccountModels | null;
  local: DesktopLocal;
}
export interface DesktopRecordsResponse extends DesktopIdentity {
  accountId: string | null;
  period: string;
  source: 'local-otel';
  scope: string;
  coverage: 'partial';
  retained: boolean;
  updatedAt: string;
  items: DesktopRecord[];
  nextCursor: string | null;
}
