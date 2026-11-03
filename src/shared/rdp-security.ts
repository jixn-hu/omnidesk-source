export type RdpLegacyRetryResult = 'accepted' | 'declined' | 'not-required' | 'unavailable'

export function canProbeLegacyRdp(detail: string): boolean {
  return /\bERRCONNECT_(?:SECURITY_NEGO_CONNECT_FAILED|TLS_CONNECT_FAILED)\b/.test(detail)
}
