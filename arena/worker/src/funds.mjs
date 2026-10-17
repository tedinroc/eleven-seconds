// Fuel gate: a new attack card is accepted only while every wallet can still pay its part of a round
// (admin: propose + execute; each sentinel: its veto, sentinel 1 also attachReason). Without it, a
// proposal could be sent that no sentinel can afford to veto, and execute() is open to anyone once the
// cooldown ends. Unknown balances do not block (the tick refreshes them every 10–30 s).
export const monToWei = (mon) => BigInt(Math.round(Number(mon) * 1e6)) * 10n ** 12n

export function fundsCheck(balances, { minAdminWei, minSentinelWei }) {
  if (!balances?.admin) return { ok: true, unknown: true, low: [] }
  const low = []
  if (BigInt(balances.admin.wei ?? 0) < minAdminWei) low.push({ who: 'admin', mon: balances.admin.mon })
  for (const s of balances.sentinels ?? []) if (BigInt(s.wei ?? 0) < minSentinelWei) low.push({ who: `sentinel${s.index}`, mon: s.mon })
  return { ok: low.length === 0, low }
}
