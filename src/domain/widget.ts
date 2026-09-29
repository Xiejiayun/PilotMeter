import type { AccountsOverview } from '../shared/accounts.js';
import type { Summary } from '../shared/types.js';
import { WIDGET_TEXT_LIMITS, type WidgetSnapshot } from '../shared/widget.js';
import { compareDecimals, exactPercentageOf, nonNegativeDecimal } from './decimal.js';
import { timestamp } from './period.js';
import { projectPersonalQuota } from './personal-quota.js';

function quantity(value: unknown): string | null {
  try { return nonNegativeDecimal(nonNegativeDecimal(value)); } catch { return null; }
}

function date(value: unknown): string {
  const parsed = timestamp(value);
  return parsed === null ? '' : new Date(parsed).toISOString();
}

function ratio(value: unknown): { number: number | null; text: string } | null {
  const exact = quantity(value);
  if (exact === null || compareDecimals(exact, '100') > 0) return null;
  const number = Number(exact);
  return { number: number === 100 && exact !== '100' || number === 0 && exact !== '0' ? null : number, text: `${exact}%` };
}

/** A pure projection: use only selected identity and bounded quantities, never upstream free-form text. */
export function buildWidget(summary: Summary, overview: AccountsOverview, selectedKey?: string | null): WidgetSnapshot {
  const summaryAt = date(summary.updatedAt);
  let accountLogin: string | null = null;
  let unitLabel: WidgetSnapshot['unitLabel'] = null;
  let unitUnspecified = false;
  function result(state: WidgetSnapshot['state'], title: string, value: string, detail: string,
    percentage: number | null = null, updatedAt = summaryAt): WidgetSnapshot {
    const valueFits = value.length <= WIDGET_TEXT_LIMITS.value;
    const fullDetail = `${valueFits ? '' : '精确数值较长，请打开主窗口查看。'}${detail}`;
    return {
      state, title: title.slice(0, WIDGET_TEXT_LIMITS.title), value: valueFits ? value : '查看精确用量',
      // A clipped number would look like a different amount. Keep the full text or refer to the main window.
      detail: fullDetail.length <= WIDGET_TEXT_LIMITS.detail ? fullDetail
        : '完整明细较长，请打开主窗口查看完整用量、总额和同步状态；数值不做缩写或舍入。',
      percentage: percentage !== null && Number.isFinite(percentage) && percentage >= 0 && percentage <= 100 ? percentage : null,
      accountLogin, updatedAt, unitLabel, unitUnspecified,
    };
  }
  if (summary.demo || !overview.enabled) return result('waiting', 'PilotMeter 演示', '演示模式', '当前是合成示例；打开普通主窗口登录 GitHub。');
  const profile = overview.accounts.find(item => item.id === overview.activeAccountId);
  if (!profile || typeof profile.login !== 'string' || profile.login.length > WIDGET_TEXT_LIMITS.accountLogin
    || !/^[a-z\d](?:[a-z\d_-]*[a-z\d])?$/i.test(profile.login)) {
    return result('needs-login', 'PilotMeter', '登录 GitHub', '打开主窗口选择或登录 GitHub 账号；个人用量未知。');
  }
  accountLogin = profile.login;
  if (profile.status === 'reauth-required') return result('needs-login', 'GitHub 登录已失效', '重新登录', '打开主窗口重新登录当前账号；个人额度尚未确认。');

  const quota = overview.quota?.accountId === profile.id && overview.quota.scope === 'signed-in-user' ? overview.quota : null;
  const error = profile.status === 'error' || quota?.state === 'error' || !!quota?.error;
  const personal = projectPersonalQuota(quota, summaryAt, selectedKey);
  if (personal.fetchedAt && personal.buckets.length) {
    const state = error ? 'error' : personal.stale || overview.refreshing ? 'waiting' : 'ready';
    const status = error ? '同步失败，显示旧快照；' : personal.stale ? '旧快照，等待同步；' : overview.refreshing ? '正在同步；' : '';
    if (personal.primary) {
      const bucket = personal.primary;
      unitLabel = bucket.unit === 'ai-credits' ? 'AI Credits' : bucket.unit === 'premium-requests' ? 'Premium Requests' : null;
      unitUnspecified = bucket.unit === 'unspecified';
      const left = ratio(bucket.remainingPercentage);
      const value = bucket.remaining !== null ? `${bucket.remaining} 剩余` : left ? `剩余 ${left.text}` : bucket.value;
      return result(bucket.value === '已用未知' && value === bucket.value && !error ? 'waiting' : state, `个人${bucket.label} · 当前周期`, value,
        `${status}${bucket.remaining !== null ? `剩余 ${bucket.remaining} ${bucket.unitLabel}（总额减已用）；` : bucket.unit === 'unspecified' ? '单位未确认；' : ''}${bucket.detail}；个人额度不代表组织总池。`, state === 'ready' ? bucket.percentage : null, personal.fetchedAt);
    }
    if (personal.selection === 'required') {
      return result(error ? 'error' : 'waiting', '个人当前周期额度', '选择额度类别',
        `${status}共 ${personal.buckets.length} 个独立额度类别，不合并数量或比例；打开主窗口选择查看。`, null, personal.fetchedAt);
    }
    return result(state, '个人当前周期额度', '各类别无固定上限',
      `${status}各额度类别独立且无固定上限；打开主窗口逐项查看，个人额度不代表组织总池。`, null, personal.fetchedAt);
  }

  const reason = error ? '个人额度同步失败；' : overview.refreshing ? '个人额度正在同步；' : '个人额度尚未取得；';
  const local = summary.local;
  const sameAccount = summary.githubAccount?.id === profile.id;
  const period = /^\d{4}-(?:0[1-9]|1[0-2])$/.test(summary.period) ? summary.period : null;
  if (sameAccount && period && local.period === period && Number.isSafeInteger(local.knownCalls) && local.knownCalls > 0) {
    const credits = local.unitVerified ? quantity(local.credits) : null;
    const raw = typeof local.nanoAiu === 'string' && /^\d{1,256}$/.test(local.nanoAiu) ? quantity(local.nanoAiu) : null;
    const used = credits ?? raw;
    if (used !== null) {
      unitLabel = credits === null ? null : 'AI Credits';
      unitUnspecified = credits === null;
      const retained = summary.retention.prunedSpans > 0 ? '仍保留的已知小计' : '已记录的已知小计';
      const incomplete = local.unknownCalls > 0 || local.pendingCalls > 0 ? '，另有待定调用' : '';
      const detail = `${reason}${period}（UTC）本机${retained}${incomplete}；${credits === null ? 'nano AIU，换算未确认' : 'AI Credits'}。`;
      const display = summary.display;
      const budget = display.mode === 'custom' && credits !== null && display.unit === 'ai-credits'
        && quantity(display.used) === credits ? quantity(display.limit) : null;
      if (budget !== null) {
        const computed = exactPercentageOf(credits!, budget);
        const percent = ratio(computed);
        return result(error ? 'error' : overview.refreshing ? 'waiting' : 'ready', '本机月度自定义预算',
          `${used} / ${budget}`,
          `${detail} 自定义预算 ${budget}，不代表个人官方额度${budget === '0' ? '；预算为 0' : compareDecimals(used, budget) > 0 ? '；已超预算' : ''}。`, percent?.number ?? null);
      }
      return result(error ? 'error' : overview.refreshing ? 'waiting' : 'ready', '本机月度记录', used, `${detail} 不代表个人完整用量。`);
    }
  }
  return result(error ? 'error' : 'waiting', '个人当前周期额度', '用量未知', `${reason}当前账号尚无可展示的已知用量；打开主窗口查看。`);
}
