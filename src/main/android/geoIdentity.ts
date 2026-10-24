// Country → mobile identity mapping for geo-consistent Android profiles.
//
// Why a table instead of an API: the guest must answer a plausible carrier for the
// proxy's country on EVERY boot, offline included. A network lookup would make the
// identity depend on connectivity, which is exactly what a proxy-less guest cannot
// rely on. The table covers the phone markets the preset pool targets and falls back
// to a neutral US identity — never throws, never blocks a launch.
//
// MCC/MNC reference: ITU-T E.212. The MNC is the dominant carrier per country, which
// is what a fingerprint-level check compares (country + operator family), not the
// exact SIM brand.

export interface GeoIdentity {
  /** BCP-47 locale, e.g. de-DE. */
  locale: string;
  /** `mcc` + `mnc`, e.g. 26201. */
  mccMnc: string;
  /** Carrier display name as the guest reports it. */
  operatorAlpha: string;
  /** IANA zone; only used when the profile/proxy has no explicit timezone. */
  timezone: string;
}

const FALLBACK: GeoIdentity = {
  locale: 'en-US',
  mccMnc: '310260',
  operatorAlpha: 'T-Mobile',
  timezone: 'America/New_York',
};

const TABLE: Readonly<Record<string, GeoIdentity>> = {
  US: FALLBACK,
  CA: { locale: 'en-CA', mccMnc: '302720', operatorAlpha: 'Rogers', timezone: 'America/Toronto' },
  GB: { locale: 'en-GB', mccMnc: '23415', operatorAlpha: 'Vodafone UK', timezone: 'Europe/London' },
  DE: { locale: 'de-DE', mccMnc: '26201', operatorAlpha: 'Telekom', timezone: 'Europe/Berlin' },
  FR: { locale: 'fr-FR', mccMnc: '20801', operatorAlpha: 'Orange', timezone: 'Europe/Paris' },
  ES: { locale: 'es-ES', mccMnc: '21401', operatorAlpha: 'Vodafone ES', timezone: 'Europe/Madrid' },
  IT: { locale: 'it-IT', mccMnc: '22201', operatorAlpha: 'TIM', timezone: 'Europe/Rome' },
  NL: { locale: 'nl-NL', mccMnc: '20404', operatorAlpha: 'Vodafone NL', timezone: 'Europe/Amsterdam' },
  PL: { locale: 'pl-PL', mccMnc: '26001', operatorAlpha: 'Plus', timezone: 'Europe/Warsaw' },
  SE: { locale: 'sv-SE', mccMnc: '24001', operatorAlpha: 'Telia', timezone: 'Europe/Stockholm' },
  CH: { locale: 'de-CH', mccMnc: '22801', operatorAlpha: 'Swisscom', timezone: 'Europe/Zurich' },
  AT: { locale: 'de-AT', mccMnc: '23201', operatorAlpha: 'A1', timezone: 'Europe/Vienna' },
  CZ: { locale: 'cs-CZ', mccMnc: '23001', operatorAlpha: 'T-Mobile CZ', timezone: 'Europe/Prague' },
  RO: { locale: 'ro-RO', mccMnc: '22601', operatorAlpha: 'Vodafone RO', timezone: 'Europe/Bucharest' },
  UA: { locale: 'uk-UA', mccMnc: '25501', operatorAlpha: 'Vodafone UA', timezone: 'Europe/Kyiv' },
  TR: { locale: 'tr-TR', mccMnc: '28601', operatorAlpha: 'Turkcell', timezone: 'Europe/Istanbul' },
  RU: { locale: 'ru-RU', mccMnc: '25001', operatorAlpha: 'MTS', timezone: 'Europe/Moscow' },
  KZ: { locale: 'ru-KZ', mccMnc: '40101', operatorAlpha: 'Beeline KZ', timezone: 'Asia/Almaty' },
  AE: { locale: 'ar-AE', mccMnc: '42402', operatorAlpha: 'Etisalat', timezone: 'Asia/Dubai' },
  IL: { locale: 'he-IL', mccMnc: '42501', operatorAlpha: 'Partner', timezone: 'Asia/Jerusalem' },
  IN: { locale: 'en-IN', mccMnc: '40445', operatorAlpha: 'Airtel', timezone: 'Asia/Kolkata' },
  SG: { locale: 'en-SG', mccMnc: '52501', operatorAlpha: 'Singtel', timezone: 'Asia/Singapore' },
  JP: { locale: 'ja-JP', mccMnc: '44010', operatorAlpha: 'docomo', timezone: 'Asia/Tokyo' },
  KR: { locale: 'ko-KR', mccMnc: '45005', operatorAlpha: 'SK Telecom', timezone: 'Asia/Seoul' },
  CN: { locale: 'zh-CN', mccMnc: '46000', operatorAlpha: 'China Mobile', timezone: 'Asia/Shanghai' },
  HK: { locale: 'zh-HK', mccMnc: '45400', operatorAlpha: 'CSL', timezone: 'Asia/Hong_Kong' },
  TW: { locale: 'zh-TW', mccMnc: '46692', operatorAlpha: 'Chunghwa', timezone: 'Asia/Taipei' },
  ID: { locale: 'id-ID', mccMnc: '51010', operatorAlpha: 'Telkomsel', timezone: 'Asia/Jakarta' },
  VN: { locale: 'vi-VN', mccMnc: '45201', operatorAlpha: 'Viettel', timezone: 'Asia/Ho_Chi_Minh' },
  TH: { locale: 'th-TH', mccMnc: '52003', operatorAlpha: 'AIS', timezone: 'Asia/Bangkok' },
  PH: { locale: 'en-PH', mccMnc: '51502', operatorAlpha: 'Globe', timezone: 'Asia/Manila' },
  AU: { locale: 'en-AU', mccMnc: '50501', operatorAlpha: 'Telstra', timezone: 'Australia/Sydney' },
  NZ: { locale: 'en-NZ', mccMnc: '53001', operatorAlpha: 'Vodafone NZ', timezone: 'Pacific/Auckland' },
  BR: { locale: 'pt-BR', mccMnc: '72402', operatorAlpha: 'TIM BR', timezone: 'America/Sao_Paulo' },
  MX: { locale: 'es-MX', mccMnc: '334020', operatorAlpha: 'Telcel', timezone: 'America/Mexico_City' },
  AR: { locale: 'es-AR', mccMnc: '722310', operatorAlpha: 'Claro', timezone: 'America/Argentina/Buenos_Aires' },
  CL: { locale: 'es-CL', mccMnc: '73001', operatorAlpha: 'Entel', timezone: 'America/Santiago' },
  CO: { locale: 'es-CO', mccMnc: '732101', operatorAlpha: 'Claro CO', timezone: 'America/Bogota' },
  ZA: { locale: 'en-ZA', mccMnc: '65501', operatorAlpha: 'Vodacom', timezone: 'Africa/Johannesburg' },
  EG: { locale: 'ar-EG', mccMnc: '60201', operatorAlpha: 'Vodafone EG', timezone: 'Africa/Cairo' },
  NG: { locale: 'en-NG', mccMnc: '62130', operatorAlpha: 'MTN NG', timezone: 'Africa/Lagos' },
};

/** ISO-3166-1 alpha-2 (any case) → mobile identity. Unknown/absent → neutral US. */
export function geoIdentityFor(countryCode: string | null | undefined): GeoIdentity {
  if (!countryCode) return FALLBACK;
  const key = countryCode.trim().toUpperCase();
  return TABLE[key] ?? FALLBACK;
}

/** Test seam: the mapping is data, so the suite pins its shape without network. */
export const GEO_IDENTITY_TABLE = TABLE;
