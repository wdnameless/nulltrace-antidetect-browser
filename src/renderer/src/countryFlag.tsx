import React from 'react';

/**
 * Country flags as geometry.
 *
 * Windows renders the regional-indicator "flag emoji" as two letters, not as a flag — measured in
 * this app's own kernel: a `🇵🇱` span painted a single monochrome colour on a canvas and measured
 * 14px wide. So the PROXY column showed `PL GB US` where the operator expected flags, which is
 * exactly the complaint this module answers.
 *
 * Why geometry rather than a font or sprite sheet:
 *  - A bundled flag FONT would work, but the available ones carry Twemoji artwork under CC-BY-4.0.
 *    This application is AGPL-3.0, and shipping third-party art under a different licence into it is
 *    a question this file does not need to raise. Flag colours and stripe arrangements are facts
 *    about countries and are not anyone's copyright, so drawing them is unambiguous.
 *  - A sprite sheet for every country is megabytes; this app ships its icons as inline SVG already
 *    (see `icons.tsx`), so a flag made of rects costs a few hundred bytes and scales crisply.
 *
 * Coverage is deliberate: the countries a proxy pool realistically contains, plus every code the
 * geo provider has been seen to return. An unknown code renders as NOTHING here and the caller keeps
 * showing the two-letter code it already prints, so an uncovered country degrades to text rather
 * than to a wrong or broken flag.
 */

/** Horizontal bands, top to bottom. */
type HorizontalSpec = { readonly kind: 'h'; readonly bands: readonly string[] };
/** Vertical bands, left to right. */
type VerticalSpec = { readonly kind: 'v'; readonly bands: readonly string[] };
/**
 * A flag whose design is not bands. `custom` names a drawing in `renderCustom` below; these are
 * necessarily simplified — a fifty-star canton is not worth 50 paths — and each is recognisable by
 * its field, its stripes and its emblem's colour and rough position.
 */
type CustomSpec = { readonly kind: 'custom'; readonly name: string };

export type FlagSpec = HorizontalSpec | VerticalSpec | CustomSpec;

const h = (...bands: string[]): HorizontalSpec => ({ kind: 'h', bands });
const v = (...bands: string[]): VerticalSpec => ({ kind: 'v', bands });
const c = (name: string): CustomSpec => ({ kind: 'custom', name });

/**
 * The flag table. Band specs cover the great majority; `renderCustom` covers the rest.
 *
 * Colours are the official values where a flag defines them (Poland's crimson is #DC143C, Germany's
 * gold #FFCE00…) rather than approximations, because a wrong hue is the one error a viewer notices.
 */
export const COUNTRY_FLAGS: Readonly<Record<string, FlagSpec>> = {
  // ── Europe ────────────────────────────────────────────────────────────────────────────────
  DE: h('#000000', '#DD0000', '#FFCE00'),
  GB: c('uk'),
  FR: v('#002395', '#FFFFFF', '#ED2939'),
  IT: v('#008C45', '#F4F5F0', '#CD212A'),
  IE: v('#169B62', '#FFFFFF', '#FF883E'),
  BE: v('#000000', '#FDDA24', '#EF3340'),
  NL: h('#AE1C28', '#FFFFFF', '#21468B'),
  LU: h('#ED2939', '#FFFFFF', '#00A1DE'),
  AT: h('#ED2939', '#FFFFFF', '#ED2939'),
  ES: c('spain'),
  PT: c('portugal'),
  PL: h('#FFFFFF', '#DC143C'),
  CZ: c('czechia'),
  SK: c('slovakia'),
  HU: h('#C8102E', '#FFFFFF', '#00843D'),
  RO: v('#002B7F', '#FCD116', '#CE1126'),
  BG: h('#FFFFFF', '#00966E', '#D62612'),
  RU: h('#FFFFFF', '#0039A6', '#D52B1E'),
  UA: h('#0057B7', '#FFD700'),
  BY: h('#C8313E', '#C8313E', '#4AA657'),
  LT: h('#FDB913', '#006A44', '#C1272D'),
  LV: c('latvia'),
  EE: h('#0072CE', '#000000', '#FFFFFF'),
  FI: c('nordic'),
  SE: c('nordic'),
  NO: c('nordic'),
  DK: c('nordic'),
  IS: c('nordic'),
  CH: c('switzerland'),
  GR: c('greece'),
  TR: c('turkey'),
  MD: v('#003DA5', '#FFD200', '#C8102E'),
  RS: c('serbia'),
  HR: c('croatia'),
  SI: c('slovenia'),
  BA: c('bosnia'),
  MK: c('macedonia'),
  AL: h('#E41E20', '#E41E20'),
  ME: c('montenegro'),
  CY: h('#FFFFFF', '#D57800'),
  MT: v('#FFFFFF', '#CF142B', '#FFFFFF'),
  // ── Americas ──────────────────────────────────────────────────────────────────────────────
  US: c('usa'),
  CA: c('canada'),
  MX: c('mexico'),
  BR: c('brazil'),
  AR: h('#74ACDF', '#FFFFFF', '#74ACDF'),
  CL: c('chile'),
  CO: h('#FCD116', '#003893', '#CE1126'),
  PE: v('#D91023', '#FFFFFF', '#D91023'),
  VE: h('#FFCC00', '#00247D', '#CF142B'),
  EC: h('#FFDD00', '#FFDD00', '#034EA2'),
  UY: h('#FFFFFF', '#0038A8'),
  PY: h('#D52B1E', '#FFFFFF', '#0038A8'),
  BO: h('#D52B1E', '#F9E300', '#007934'),
  CR: h('#002B7F', '#FFFFFF', '#CE1126'),
  CU: c('cuba'),
  DO: c('dominican'),
  GT: v('#4997D0', '#FFFFFF', '#4997D0'),
  PA: c('panama'),
  // ── Asia & Middle East ───────────────────────────────────────────────────────────────────
  CN: c('china'),
  JP: c('japan'),
  KR: c('korea'),
  KP: c('korea-north'),
  TW: c('taiwan'),
  HK: c('hongkong'),
  SG: c('singapore'),
  MY: c('malaysia'),
  ID: h('#CE1126', '#FFFFFF'),
  TH: h('#A51931', '#F4F5F8', '#2D2A4A', '#F4F5F8', '#A51931'),
  VN: c('vietnam'),
  PH: h('#0038A8', '#CE1126'),
  IN: c('india'),
  PK: c('pakistan'),
  BD: c('bangladesh'),
  LK: c('srilanka'),
  NP: c('nepal'),
  KZ: c('kazakhstan'),
  UZ: h('#0099B5', '#FFFFFF', '#1EB53A'),
  AE: c('uae'),
  SA: c('saudi'),
  QA: c('qatar'),
  KW: h('#007A3D', '#FFFFFF', '#CE1126'),
  BH: c('bahrain'),
  OM: c('oman'),
  JO: h('#000000', '#FFFFFF', '#007A3D'),
  IL: c('israel'),
  LB: c('lebanon'),
  IR: h('#239F40', '#FFFFFF', '#DA0000'),
  IQ: h('#CE1126', '#FFFFFF', '#000000'),
  SY: h('#CE1126', '#FFFFFF', '#000000'),
  AM: h('#D90012', '#0033A0', '#F2A800'),
  GE: c('georgia'),
  AZ: h('#0092BC', '#E4002B', '#00AE65'),
  MN: c('mongolia'),
  // ── Oceania ──────────────────────────────────────────────────────────────────────────────
  AU: c('australia'),
  NZ: c('newzealand'),
  FJ: c('fiji'),
  // ── Africa ───────────────────────────────────────────────────────────────────────────────
  ZA: c('southafrica'),
  NG: v('#008751', '#FFFFFF', '#008751'),
  KE: h('#000000', '#BB0000', '#006600'),
  EG: h('#CE1126', '#FFFFFF', '#000000'),
  MA: c('morocco'),
  DZ: v('#006233', '#FFFFFF', '#D21034'),
  TN: c('tunisia'),
  GH: h('#CE1126', '#FCD116', '#006B3F'),
  SN: v('#00853F', '#FDEF42', '#E31B23'),
  CI: v('#F77F00', '#FFFFFF', '#009E60'),
  CM: v('#007A5E', '#CE1126', '#FCD116'),
  ET: h('#078930', '#FCDD09', '#DA121A'),
  TZ: h('#1EB53A', '#000000', '#00A3DD'),
  UG: h('#000000', '#FCDC04', '#D90000'),
  RW: h('#20603D', '#FAD201', '#00A1DE'),
  AO: h('#CE1126', '#000000'),
};

/** Nordic cross, shared by FI/SE/NO/DK/IS with each country's field and cross colours. */
const NORDIC: Readonly<Record<string, { field: string; cross: string; inner?: string }>> = {
  FI: { field: '#FFFFFF', cross: '#003580' },
  SE: { field: '#006AA7', cross: '#FECC00' },
  NO: { field: '#BA0C2F', cross: '#FFFFFF', inner: '#00205B' },
  DK: { field: '#C8102E', cross: '#FFFFFF' },
  IS: { field: '#02529C', cross: '#FFFFFF', inner: '#DC1E35' },
};

/** A five-pointed star path centred on (cx, cy) with outer radius r, as an SVG `d` string. */
function starPath(cx: number, cy: number, r: number): string {
  const inner = r * 0.382; // the correct ratio for a five-pointed star
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? r : inner;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `M ${pts.join(' L ')} Z`;
}

/**
 * The designs that are not bands.
 *
 * Every one is a simplification and is marked as such where it matters: the goal is a flag an
 * operator recognises at 16px in a table row, not a heraldic reproduction. Emblems that carry fine
 * detail (Brazil's globe, India's wheel, Mexico's eagle) are reduced to their dominant shape and
 * colour, which is what survives at this size anyway.
 */
function renderCustom(name: string): React.ReactNode {
  switch (name) {
    case 'uk':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#012169" />
          <path d="M0 0 L3 2 M3 0 L0 2" stroke="#FFFFFF" strokeWidth={0.42} />
          <path d="M0 0 L3 2 M3 0 L0 2" stroke="#C8102E" strokeWidth={0.2} />
          <rect x={1.25} y={0} width={0.5} height={2} fill="#FFFFFF" />
          <rect x={0} y={0.75} width={3} height={0.5} fill="#FFFFFF" />
          <rect x={1.4} y={0} width={0.2} height={2} fill="#C8102E" />
          <rect x={0} y={0.9} width={3} height={0.2} fill="#C8102E" />
        </>
      );
    case 'uae':
      return (
        <>
          <rect x={0.75} y={0} width={2.25} height={2 / 3} fill="#00732F" />
          <rect x={0.75} y={2 / 3} width={2.25} height={2 / 3} fill="#FFFFFF" />
          <rect x={0.75} y={4 / 3} width={2.25} height={2 / 3} fill="#000000" />
          <rect x={0} y={0} width={0.75} height={2} fill="#FF0000" />
        </>
      );
    case 'spain':
      return (
        <>
          <rect x={0} y={0} width={3} height={0.5} fill="#AA151B" />
          <rect x={0} y={0.5} width={3} height={1.0} fill="#F1BF00" />
          <rect x={0} y={1.5} width={3} height={0.5} fill="#AA151B" />
          <rect x={0.65} y={0.8} width={0.3} height={0.4} fill="#AA151B" rx={0.06} />
          <rect x={0.72} y={0.85} width={0.16} height={0.25} fill="#F1BF00" />
        </>
      );
    case 'portugal':
      return (
        <>
          <rect x={0} y={0} width={1.2} height={2} fill="#046A38" />
          <rect x={1.2} y={0} width={1.8} height={2} fill="#DA291C" />
          <circle cx={1.2} cy={1} r={0.36} fill="#FFD700" />
          <rect x={1.05} y={0.82} width={0.3} height={0.36} fill="#FFFFFF" stroke="#DA291C" strokeWidth={0.06} rx={0.05} />
          <circle cx={1.2} cy={1.0} r={0.08} fill="#002776" />
        </>
      );
    case 'slovakia':
      return (
        <>
          <rect x={0} y={0} width={3} height={2 / 3} fill="#FFFFFF" />
          <rect x={0} y={2 / 3} width={3} height={2 / 3} fill="#0B4EA2" />
          <rect x={0} y={4 / 3} width={3} height={2 / 3} fill="#EE1C25" />
          <path d="M0.55 0.65 L1.1 0.65 L1.1 1.05 Q1.1 1.45 0.825 1.55 Q0.55 1.45 0.55 1.05 Z" fill="#EE1C25" stroke="#FFFFFF" strokeWidth={0.04} />
          <ellipse cx={0.825} cy={1.32} rx={0.18} ry={0.12} fill="#0B4EA2" />
          <rect x={0.805} y={0.76} width={0.04} height={0.5} fill="#FFFFFF" />
          <rect x={0.72} y={0.9} width={0.21} height={0.04} fill="#FFFFFF" />
          <rect x={0.74} y={1.04} width={0.17} height={0.04} fill="#FFFFFF" />
        </>
      );
    case 'slovenia':
      return (
        <>
          <rect x={0} y={0} width={3} height={2 / 3} fill="#FFFFFF" />
          <rect x={0} y={2 / 3} width={3} height={2 / 3} fill="#005DA4" />
          <rect x={0} y={4 / 3} width={3} height={2 / 3} fill="#ED1C24" />
          <path d="M0.45 0.35 L0.95 0.35 L0.95 0.7 Q0.95 1.0 0.7 1.1 Q0.45 1.0 0.45 0.7 Z" fill="#005DA4" stroke="#ED1C24" strokeWidth={0.03} />
          <path d="M0.5 0.8 L0.6 0.62 L0.7 0.52 L0.8 0.62 L0.9 0.8 Z" fill="#FFFFFF" />
          <circle cx={0.7} cy={0.42} r={0.035} fill="#FFD700" />
        </>
      );
    case 'croatia':
      return (
        <>
          <rect x={0} y={0} width={3} height={2 / 3} fill="#FF0000" />
          <rect x={0} y={2 / 3} width={3} height={2 / 3} fill="#FFFFFF" />
          <rect x={0} y={4 / 3} width={3} height={2 / 3} fill="#171796" />
          <rect x={1.22} y={0.65} width={0.56} height={0.65} fill="#FF0000" stroke="#FFFFFF" strokeWidth={0.03} rx={0.04} />
          <rect x={1.33} y={0.65} width={0.11} height={0.13} fill="#FFFFFF" />
          <rect x={1.55} y={0.65} width={0.11} height={0.13} fill="#FFFFFF" />
          <rect x={1.22} y={0.78} width={0.11} height={0.13} fill="#FFFFFF" />
          <rect x={1.44} y={0.78} width={0.11} height={0.13} fill="#FFFFFF" />
          <rect x={1.67} y={0.78} width={0.11} height={0.13} fill="#FFFFFF" />
          <rect x={1.33} y={0.91} width={0.11} height={0.13} fill="#FFFFFF" />
          <rect x={1.55} y={0.91} width={0.11} height={0.13} fill="#FFFFFF" />
          <rect x={1.22} y={1.04} width={0.11} height={0.13} fill="#FFFFFF" />
          <rect x={1.44} y={1.04} width={0.11} height={0.13} fill="#FFFFFF" />
          <rect x={1.67} y={1.04} width={0.11} height={0.13} fill="#FFFFFF" />
          <path d="M1.22 0.65 L1.78 0.65 L1.68 0.53 L1.5 0.58 L1.32 0.53 Z" fill="#00A1DE" />
        </>
      );
    case 'serbia':
      return (
        <>
          <rect x={0} y={0} width={3} height={2 / 3} fill="#C6363C" />
          <rect x={0} y={2 / 3} width={3} height={2 / 3} fill="#0C4076" />
          <rect x={0} y={4 / 3} width={3} height={2 / 3} fill="#FFFFFF" />
          <rect x={0.7} y={0.5} width={0.6} height={0.85} fill="#C6363C" stroke="#FFD700" strokeWidth={0.04} rx={0.05} />
          <path d="M0.85 0.7 L1.0 0.85 L1.15 0.7 L1.0 1.15 Z" fill="#FFFFFF" />
          <circle cx={1.0} cy={0.44} r={0.08} fill="#FFD700" />
        </>
      );
    case 'mexico':
      return (
        <>
          <rect x={0} y={0} width={1} height={2} fill="#006847" />
          <rect x={1} y={0} width={1} height={2} fill="#FFFFFF" />
          <rect x={2} y={0} width={1} height={2} fill="#CE1126" />
          <ellipse cx={1.5} cy={1.0} rx={0.22} ry={0.25} fill="#7A4A28" />
          <ellipse cx={1.5} cy={1.16} rx={0.24} ry={0.07} fill="#006847" />
          <circle cx={1.5} cy={0.88} r={0.08} fill="#4A2E1B" />
        </>
      );
    case 'usa':
      return (
        <>
          {Array.from({ length: 13 }).map((_, i) => (
            <rect key={i} x={0} y={(i * 2) / 13} width={3} height={2 / 13}
              fill={i % 2 === 0 ? '#B31942' : '#FFFFFF'} />
          ))}
          <rect x={0} y={0} width={1.2} height={(2 * 7) / 13} fill="#0A3161" />
          {/* Not 50 stars at this size: a suggestion of the star field reads correctly. */}
          {Array.from({ length: 12 }).map((_, i) => (
            <circle key={i} cx={0.2 + (i % 4) * 0.27} cy={0.18 + Math.floor(i / 4) * 0.28} r={0.055} fill="#FFFFFF" />
          ))}
        </>
      );
    case 'canada':
      return (
        <>
          <rect x={0} y={0} width={0.75} height={2} fill="#D80621" />
          <rect x={2.25} y={0} width={0.75} height={2} fill="#D80621" />
          <rect x={0.75} y={0} width={1.5} height={2} fill="#FFFFFF" />
          <path d="M1.5 0.35 L1.72 0.78 L2.05 0.62 L1.9 1.0 L2.2 1.0 L1.75 1.3 L1.85 1.62 L1.5 1.5 L1.15 1.62 L1.25 1.3 L0.8 1.0 L1.1 1.0 L0.95 0.62 L1.28 0.78 Z" fill="#D80621" />
        </>
      );
    case 'brazil':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#009B3A" />
          <path d="M1.5 0.18 L2.85 1 L1.5 1.82 L0.15 1 Z" fill="#FEDF00" />
          <circle cx={1.5} cy={1} r={0.42} fill="#002776" />
          <path d="M1.12 0.86 Q1.5 1.12 1.88 0.86" stroke="#FFFFFF" strokeWidth={0.09} fill="none" />
        </>
      );
    case 'chile':
      return (
        <>
          <rect x={0} y={0} width={3} height={1} fill="#FFFFFF" />
          <rect x={0} y={1} width={3} height={1} fill="#D52B1E" />
          <rect x={0} y={0} width={1} height={1} fill="#0039A6" />
          <path d={starPath(0.5, 0.5, 0.3)} fill="#FFFFFF" />
        </>
      );
    case 'cuba':
      return (
        <>
          {Array.from({ length: 5 }).map((_, i) => (
            <rect key={i} x={0} y={(i * 2) / 5} width={3} height={2 / 5} fill={i % 2 === 0 ? '#002A8F' : '#FFFFFF'} />
          ))}
          <path d="M0 0 L1.15 1 L0 2 Z" fill="#CF142B" />
          <path d={starPath(0.34, 1, 0.2)} fill="#FFFFFF" />
        </>
      );
    case 'czechia':
      return (
        <>
          <rect x={0} y={0} width={3} height={1} fill="#FFFFFF" />
          <rect x={0} y={1} width={3} height={1} fill="#D7141A" />
          <path d="M0 0 L1.5 1 L0 2 Z" fill="#11457E" />
        </>
      );
    case 'latvia':
      return (
        <>
          <rect x={0} y={0} width={3} height={0.8} fill="#9E3039" />
          <rect x={0} y={0.8} width={3} height={0.4} fill="#FFFFFF" />
          <rect x={0} y={1.2} width={3} height={0.8} fill="#9E3039" />
        </>
      );
    case 'nordic':
      // Unreachable via `COUNTRY_FLAGS` (each Nordic code carries its own colours); kept so the
      // switch stays total if a code is added without colours.
      return <rect x={0} y={0} width={3} height={2} fill="#006AA7" />;
    case 'switzerland':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#D52B1E" />
          <rect x={1.25} y={0.4} width={0.5} height={1.2} fill="#FFFFFF" />
          <rect x={0.9} y={0.75} width={1.2} height={0.5} fill="#FFFFFF" />
        </>
      );
    case 'greece':
      return (
        <>
          {Array.from({ length: 9 }).map((_, i) => (
            <rect key={i} x={0} y={(i * 2) / 9} width={3} height={2 / 9} fill={i % 2 === 0 ? '#0D5EAF' : '#FFFFFF'} />
          ))}
          <rect x={0} y={0} width={1.11} height={(2 * 5) / 9} fill="#0D5EAF" />
          <rect x={0.44} y={0} width={0.22} height={(2 * 5) / 9} fill="#FFFFFF" />
          <rect x={0} y={0.44} width={1.11} height={0.22} fill="#FFFFFF" />
        </>
      );
    case 'turkey':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#E30A17" />
          <circle cx={1.25} cy={1} r={0.45} fill="#FFFFFF" />
          <circle cx={1.38} cy={1} r={0.36} fill="#E30A17" />
          <path d={starPath(1.9, 1, 0.24)} fill="#FFFFFF" />
        </>
      );
    case 'tunisia':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#E70013" />
          <circle cx={1.5} cy={1} r={0.5} fill="#FFFFFF" />
          <circle cx={1.58} cy={1} r={0.36} fill="#E70013" />
          <circle cx={1.62} cy={1} r={0.3} fill="#FFFFFF" />
          <path d={starPath(1.72, 1, 0.17)} fill="#E70013" />
        </>
      );
    case 'japan':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#FFFFFF" />
          <circle cx={1.5} cy={1} r={0.6} fill="#BC002D" />
        </>
      );
    case 'korea':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#FFFFFF" />
          <path d="M1.5 1 m-0.5 0 a0.5 0.5 0 0 1 1 0 a0.25 0.25 0 0 1 -0.5 0 a0.25 0.25 0 0 0 -0.5 0" fill="#CD2E3A" />
          <path d="M1.5 1 m-0.5 0 a0.5 0.5 0 0 0 1 0 a0.25 0.25 0 0 0 -0.5 0 a0.25 0.25 0 0 1 -0.5 0" fill="#0047A0" />
        </>
      );
    case 'korea-north':
      return (
        <>
          <rect x={0} y={0} width={3} height={0.4} fill="#024FA2" />
          <rect x={0} y={0.4} width={3} height={0.16} fill="#FFFFFF" />
          <rect x={0} y={0.56} width={3} height={0.88} fill="#ED1C27" />
          <rect x={0} y={1.44} width={3} height={0.16} fill="#FFFFFF" />
          <rect x={0} y={1.6} width={3} height={0.4} fill="#024FA2" />
          <circle cx={0.75} cy={0.78} r={0.3} fill="#FFFFFF" />
          <path d={starPath(0.75, 0.78, 0.3)} fill="#ED1C27" />
        </>
      );
    case 'china':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#DE2910" />
          <path d={starPath(0.5, 0.42, 0.3)} fill="#FFDE00" />
          {[[0.95, 0.2], [1.15, 0.42], [1.15, 0.68], [0.95, 0.9]].map(([x, y], i) => (
            <path key={i} d={starPath(x, y, 0.11)} fill="#FFDE00" />
          ))}
        </>
      );
    case 'taiwan':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#FE0000" />
          <rect x={0} y={0} width={1.5} height={1} fill="#000095" />
          <circle cx={0.75} cy={0.5} r={0.3} fill="#FFFFFF" />
        </>
      );
    case 'hongkong':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#DE2910" />
          <circle cx={1.5} cy={1} r={0.35} fill="#FFFFFF" />
        </>
      );
    case 'singapore':
      return (
        <>
          <rect x={0} y={0} width={3} height={1} fill="#ED2939" />
          <rect x={0} y={1} width={3} height={1} fill="#FFFFFF" />
          <circle cx={0.72} cy={0.5} r={0.34} fill="#FFFFFF" />
          <circle cx={0.84} cy={0.5} r={0.3} fill="#ED2939" />
          <path d={starPath(1.15, 0.34, 0.13)} fill="#FFFFFF" />
          <path d={starPath(1.35, 0.5, 0.13)} fill="#FFFFFF" />
          <path d={starPath(1.29, 0.75, 0.13)} fill="#FFFFFF" />
        </>
      );
    case 'malaysia':
      return (
        <>
          {Array.from({ length: 14 }).map((_, i) => (
            <rect key={i} x={0} y={(i * 2) / 14} width={3} height={2 / 14} fill={i % 2 === 0 ? '#CC0001' : '#FFFFFF'} />
          ))}
          <rect x={0} y={0} width={1.5} height={1} fill="#010066" />
          <circle cx={0.6} cy={0.5} r={0.28} fill="#FFCC00" />
          <circle cx={0.7} cy={0.5} r={0.24} fill="#010066" />
        </>
      );
    case 'vietnam':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#DA251D" />
          <path d={starPath(1.5, 1, 0.5)} fill="#FFFF00" />
        </>
      );
    case 'india':
      return (
        <>
          <rect x={0} y={0} width={3} height={2 / 3} fill="#FF9933" />
          <rect x={0} y={2 / 3} width={3} height={2 / 3} fill="#FFFFFF" />
          <rect x={0} y={4 / 3} width={3} height={2 / 3} fill="#138808" />
          <circle cx={1.5} cy={1} r={0.26} fill="none" stroke="#000080" strokeWidth={0.07} />
        </>
      );
    case 'pakistan':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#01411C" />
          <rect x={0} y={0} width={0.75} height={2} fill="#FFFFFF" />
          <circle cx={1.85} cy={1} r={0.4} fill="#FFFFFF" />
          <circle cx={2.0} cy={0.86} r={0.34} fill="#01411C" />
          <path d={starPath(2.2, 0.72, 0.18)} fill="#FFFFFF" />
        </>
      );
    case 'bangladesh':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#006A4E" />
          <circle cx={1.25} cy={1} r={0.55} fill="#F42A41" />
        </>
      );
    case 'srilanka':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#FFBE29" />
          <rect x={0} y={0} width={0.5} height={1} fill="#00534E" />
          <rect x={0} y={1} width={0.5} height={1} fill="#EB7400" />
          <rect x={0.55} y={0.1} width={2.35} height={1.8} fill="#8D2029" />
          <circle cx={1.9} cy={1} r={0.35} fill="#FFBE29" />
          <circle cx={2.05} cy={0.92} r={0.3} fill="#8D2029" />
        </>
      );
    case 'nepal':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#FFFFFF" />
          <path d="M0.6 0.05 L2.2 0.75 L1.3 0.75 L2.2 1.3 L1.1 1.95 L0.6 1.95 Z" fill="#DC143C" />
          <path d="M0.75 0.3 L1.8 0.72 L1.05 0.72 Z" fill="#FFFFFF" />
        </>
      );
    case 'kazakhstan':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#00AFCA" />
          <circle cx={1.5} cy={1} r={0.4} fill="#FEC50C" />
          <path d={starPath(1.5, 0.28, 0.16)} fill="#FEC50C" />
        </>
      );
    case 'mongolia':
      return (
        <>
          <rect x={0} y={0} width={3} height={2 / 3} fill="#C4272F" />
          <rect x={0} y={2 / 3} width={3} height={2 / 3} fill="#015197" />
          <rect x={0} y={4 / 3} width={3} height={2 / 3} fill="#C4272F" />
          <rect x={0} y={0} width={0.7} height={2} fill="#F9CF02" />
          <rect x={0.22} y={0.3} width={0.26} height={1.4} fill="#C4272F" />
        </>
      );
    case 'saudi':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#165D31" />
          <rect x={0.5} y={1.05} width={2} height={0.16} fill="#FFFFFF" />
          <rect x={0.7} y={0.62} width={1.6} height={0.12} fill="#FFFFFF" />
        </>
      );
    case 'qatar':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#8D1B3D" />
          <rect x={0} y={0} width={1.1} height={2} fill="#FFFFFF" />
          {Array.from({ length: 9 }).map((_, i) => (
            <path key={i} d={`M1.1 ${(i * 2) / 9} L1.3 ${(i * 2) / 9 + 1 / 9} L1.1 ${(i * 2) / 9 + 2 / 9} Z`} fill="#8D1B3D" />
          ))}
        </>
      );
    case 'bahrain':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#CE1126" />
          <rect x={0} y={0} width={0.9} height={2} fill="#FFFFFF" />
          {Array.from({ length: 5 }).map((_, i) => (
            <path key={i} d={`M0.9 ${(i * 2) / 5} L1.12 ${(i * 2) / 5 + 1 / 5} L0.9 ${(i * 2) / 5 + 2 / 5} Z`} fill="#CE1126" />
          ))}
        </>
      );
    case 'oman':
      return (
        <>
          <rect x={0} y={0} width={3} height={2 / 3} fill="#DB161B" />
          <rect x={0} y={2 / 3} width={3} height={2 / 3} fill="#FFFFFF" />
          <rect x={0} y={4 / 3} width={3} height={2 / 3} fill="#008000" />
          <rect x={0} y={0} width={0.75} height={2} fill="#DB161B" />
        </>
      );
    case 'israel':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#FFFFFF" />
          <rect x={0} y={0.22} width={3} height={0.28} fill="#0038B8" />
          <rect x={0} y={1.5} width={3} height={0.28} fill="#0038B8" />
          <path d="M1.5 0.62 L1.95 1.38 L1.05 1.38 Z" fill="none" stroke="#0038B8" strokeWidth={0.09} />
          <path d="M1.5 1.38 L1.05 0.62 L1.95 0.62 Z" fill="none" stroke="#0038B8" strokeWidth={0.09} />
        </>
      );
    case 'lebanon':
      return (
        <>
          <rect x={0} y={0} width={3} height={0.5} fill="#ED1C24" />
          <rect x={0} y={0.5} width={3} height={1} fill="#FFFFFF" />
          <rect x={0} y={1.5} width={3} height={0.5} fill="#ED1C24" />
          <path d="M1.5 0.6 L1.95 1.4 L1.05 1.4 Z" fill="#00A651" />
        </>
      );
    case 'georgia':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#FFFFFF" />
          <rect x={1.4} y={0} width={0.2} height={2} fill="#FF0000" />
          <rect x={0} y={0.9} width={3} height={0.2} fill="#FF0000" />
          <rect x={0.36} y={0.22} width={0.2} height={0.2} fill="#FF0000" />
          <rect x={0.36} y={1.58} width={0.2} height={0.2} fill="#FF0000" />
          <rect x={2.44} y={0.22} width={0.2} height={0.2} fill="#FF0000" />
          <rect x={2.44} y={1.58} width={0.2} height={0.2} fill="#FF0000" />
        </>
      );
    case 'bosnia':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#002F6C" />
          <path d="M0.9 0 L2.6 2 L0.9 2 Z" fill="#FECB00" />
          {[[1.05, 0.3], [1.35, 0.72], [1.65, 1.14], [1.95, 1.56]].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={0.1} fill="#FFFFFF" />
          ))}
        </>
      );
    case 'macedonia':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#D20000" />
          <circle cx={1.5} cy={1} r={0.34} fill="#FFE600" />
          <path d="M1.5 1 L0 0.35 L0 0 L1.5 0.72 Z" fill="#FFE600" />
          <path d="M1.5 1 L3 0.35 L3 0 L1.5 0.72 Z" fill="#FFE600" />
          <path d="M1.5 1 L0 1.65 L0 2 L1.5 1.28 Z" fill="#FFE600" />
          <path d="M1.5 1 L3 1.65 L3 2 L1.5 1.28 Z" fill="#FFE600" />
        </>
      );
    case 'montenegro':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#C40308" />
          <rect x={1.05} y={0.65} width={0.9} height={0.7} fill="#D4AF3A" stroke="#B08D2A" strokeWidth={0.05} />
        </>
      );
    case 'morocco':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#C1272D" />
          <path d={starPath(1.5, 1, 0.5)} fill="none" stroke="#006233" strokeWidth={0.07} />
        </>
      );
    case 'southafrica':
      return (
        <>
          <rect x={0} y={0} width={3} height={2 / 3} fill="#DE3831" />
          <rect x={0} y={1.34} width={3} height={2 / 3} fill="#002395" />
          <rect x={0} y={2 / 3} width={3} height={2 / 3} fill="#FFFFFF" />
          <path d="M0 0.45 L1.6 1 L0 1.55 Z" fill="#007A4D" />
          <path d="M0 0.78 L1.3 1 L0 1.22 Z" fill="#FFB612" />
          <path d="M0 0.95 L1.05 1 L0 1.05 Z" fill="#000000" />
        </>
      );
    case 'australia':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#00008B" />
          {/* Union canton, reduced to its crosses. */}
          <path d="M0 0 L1.5 0 L1.5 1 L0 1 Z" fill="#00008B" />
          <path d="M0 0 L1.5 1 M1.5 0 L0 1" stroke="#FFFFFF" strokeWidth={0.2} />
          <path d="M0 0 L1.5 1 M1.5 0 L0 1" stroke="#CF142B" strokeWidth={0.09} />
          <path d="M0.75 0 L0.75 1 M0 0.5 L1.5 0.5" stroke="#FFFFFF" strokeWidth={0.26} />
          <path d="M0.75 0 L0.75 1 M0 0.5 L1.5 0.5" stroke="#CF142B" strokeWidth={0.14} />
          <path d={starPath(2.3, 1.5, 0.2)} fill="#FFFFFF" />
          <path d={starPath(0.5, 1.45, 0.13)} fill="#FFFFFF" />
          <path d={starPath(1.9, 0.35, 0.12)} fill="#FFFFFF" />
          <path d={starPath(2.6, 0.6, 0.1)} fill="#FFFFFF" />
        </>
      );
    case 'newzealand':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#00247D" />
          <path d="M0 0 L1.5 1 M1.5 0 L0 1" stroke="#FFFFFF" strokeWidth={0.2} />
          <path d="M0 0 L1.5 1 M1.5 0 L0 1" stroke="#CC142B" strokeWidth={0.09} />
          <path d="M0.75 0 L0.75 1 M0 0.5 L1.5 0.5" stroke="#FFFFFF" strokeWidth={0.26} />
          <path d="M0.75 0 L0.75 1 M0 0.5 L1.5 0.5" stroke="#CC142B" strokeWidth={0.14} />
          <path d={starPath(2.3, 0.55, 0.16)} fill="#CC142B" stroke="#FFFFFF" strokeWidth={0.05} />
          <path d={starPath(1.95, 1.25, 0.16)} fill="#CC142B" stroke="#FFFFFF" strokeWidth={0.05} />
          <path d={starPath(2.7, 1.35, 0.16)} fill="#CC142B" stroke="#FFFFFF" strokeWidth={0.05} />
          <path d={starPath(2.25, 1.75, 0.14)} fill="#CC142B" stroke="#FFFFFF" strokeWidth={0.05} />
        </>
      );
    case 'fiji':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#68BFE5" />
          <path d="M0 0 L1.5 1 M1.5 0 L0 1" stroke="#FFFFFF" strokeWidth={0.18} />
          <path d="M0 0 L1.5 1 M1.5 0 L0 1" stroke="#CF142B" strokeWidth={0.08} />
          <path d="M0.75 0 L0.75 1 M0 0.5 L1.5 0.5" stroke="#FFFFFF" strokeWidth={0.24} />
          <path d="M0.75 0 L0.75 1 M0 0.5 L1.5 0.5" stroke="#CF142B" strokeWidth={0.12} />
          <path d="M1.5 0 L3 0 L3 1 L1.5 1 Z" fill="#68BFE5" />
          <rect x={2.1} y={0.85} width={0.5} height={0.35} fill="#FFFFFF" />
        </>
      );
    case 'dominican':
      return (
        <>
          <rect x={0} y={0} width={3} height={2} fill="#FFFFFF" />
          <rect x={0} y={0} width={1.4} height={0.9} fill="#002D62" />
          <rect x={1.6} y={0} width={1.4} height={0.9} fill="#CE1126" />
          <rect x={0} y={1.1} width={1.4} height={0.9} fill="#CE1126" />
          <rect x={1.6} y={1.1} width={1.4} height={0.9} fill="#002D62" />
        </>
      );
    case 'panama':
      return (
        <>
          <rect x={0} y={0} width={1.5} height={1} fill="#FFFFFF" />
          <rect x={1.5} y={0} width={1.5} height={1} fill="#DA121A" />
          <rect x={0} y={1} width={1.5} height={1} fill="#072357" />
          <rect x={1.5} y={1} width={1.5} height={1} fill="#FFFFFF" />
          <path d={starPath(0.75, 0.5, 0.28)} fill="#072357" />
          <path d={starPath(2.25, 1.5, 0.28)} fill="#DA121A" />
        </>
      );
    default:
      return null;
  }
}

/** Resolve a spec into the shapes for one flag. Shared by the component and its tests. */
export function flagShapes(code: string): React.ReactNode | null {
  const spec = COUNTRY_FLAGS[code];
  if (!spec) return null;

  if (spec.kind === 'h') {
    return spec.bands.map((fill, i) => (
      <rect key={i} x={0} y={(i * 2) / spec.bands.length} width={3} height={2 / spec.bands.length} fill={fill} />
    ));
  }
  if (spec.kind === 'v') {
    return spec.bands.map((fill, i) => (
      <rect key={i} x={(i * 3) / spec.bands.length} y={0} width={3 / spec.bands.length} height={2} fill={fill} />
    ));
  }
  // Nordic crosses are a custom design whose colours differ per country, so they are looked up here
  // rather than duplicated five times in the table above.
  if (spec.name === 'nordic') {
    const colours = NORDIC[code];
    if (colours) return renderNordic(colours);
  }
  return renderCustom(spec.name);
}

function renderNordic(colours: { field: string; cross: string; inner?: string }): React.ReactNode {
  return (
    <>
      <rect x={0} y={0} width={3} height={2} fill={colours.field} />
      <rect x={0} y={0.7} width={3} height={0.6} fill={colours.cross} />
      <rect x={0.85} y={0} width={0.6} height={2} fill={colours.cross} />
      {colours.inner ? (
        <>
          <rect x={0} y={0.85} width={3} height={0.3} fill={colours.inner} />
          <rect x={1.0} y={0} width={0.3} height={2} fill={colours.inner} />
        </>
      ) : null}
    </>
  );
}

export interface CountryFlagProps extends Omit<React.SVGProps<SVGSVGElement>, 'code'> {
  /** ISO 3166-1 alpha-2. Anything else renders nothing. */
  code: string | null | undefined;
  /** Height in px; the flag is 3:2. */
  height?: number;
}

/**
 * A country's flag, or nothing when the code is unknown.
 *
 * Rendering NOTHING for an uncovered or malformed code is the important behaviour: the caller keeps
 * showing the two-letter code beside it, so an unlisted country reads as `KZ` rather than as a wrong
 * flag or a broken glyph, and a name accidentally passed as a code cannot masquerade as one.
 */
export function CountryFlag({ code, height = 12, ...props }: CountryFlagProps) {
  if (!code) return null;
  const normalised = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalised)) return null;

  const shapes = flagShapes(normalised);
  if (!shapes) return null;

  const width = (height * 3) / 2;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 3 2"
      role="img"
      aria-label={normalised}
      style={{ display: 'inline-block', verticalAlign: '-1px', borderRadius: 1, flexShrink: 0 }}
      {...props}
    >
      {shapes}
    </svg>
  );
}

/** Whether a flag is available for this code — for callers that need to decide layout. */
export function hasFlag(code: string | null | undefined): boolean {
  if (!code) return false;
  const normalised = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalised) && Boolean(COUNTRY_FLAGS[normalised]);
}
