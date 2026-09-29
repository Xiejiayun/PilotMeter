export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing desktop element: ${id}`);
  return value as T;
}

/** Only fixed markup reaches innerHTML; every API string is escaped at the boundary. */
export function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function amount(value: string | null): string {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return '—';
  const [whole = '0', fraction] = value.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : `.${fraction}`);
}

export function timestamp(value: string | null, compact = false): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间待确认';
  return new Intl.DateTimeFormat('zh-CN', { ...(compact ? {} : { year: 'numeric' as const }), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '请求未完成，请重试。'; }

const paths: Record<string, string> = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5L20 2Z"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 11.6-2L20 8M4 16l2.4 3A7 7 0 0 0 18 17"/>',
  arrow: '<path d="M4 12h16m-5-5 5 5-5 5"/>',
  external: '<path d="M15 3h6v6m0-6L10 14"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  github: '<path d="M9 19c-4.3 1.3-4.3-2.1-6-2.5m12 5v-3.4a3 3 0 0 0-.8-2.3c2.7-.3 5.5-1.3 5.5-6A4.7 4.7 0 0 0 18.4 6 4.3 4.3 0 0 0 18.3 2S17.2 1.7 15 3.4a12.6 12.6 0 0 0-6 0C6.8 1.7 5.7 2 5.7 2A4.3 4.3 0 0 0 5.6 6a4.7 4.7 0 0 0-1.3 3.8c0 4.7 2.8 5.7 5.5 6A3 3 0 0 0 9 18v3.5"/>',
};

export function icon(name: string): string { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.sparkles}</svg>`; }
export function hydrateIcons(root: ParentNode = document): void { root.querySelectorAll<HTMLElement>('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon!); }); }
export function hostName(value: string): string { try { return new URL(value).hostname; } catch { return value; } }
export function emptyState(title: string, description: string, action = '', compact = false, glyph = 'sparkles'): string {
  return `<div class="empty-state${compact ? ' compact' : ''}"><span class="empty-symbol">${icon(glyph)}</span><h3>${escape(title)}</h3><p>${escape(description)}</p>${action}</div>`;
}
