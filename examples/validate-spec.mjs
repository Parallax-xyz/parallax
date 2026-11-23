// Build a strategy from a preset, validate it and compute its specHash (a fingerprint of the exact strategy).
// Run after `npm run build`:  node examples/validate-spec.mjs
import { modeSpecFields, PRESETS, presetDefaults, specHashOf, validateSpec } from "@parallax/strategy";

const trend = PRESETS.find((p) => p.key === "trend");
const { risk, params } = presetDefaults(trend, "conservative", "crypto-spot");

const spec = {
  version: 1,
  preset: "trend",
  name: "SOL + JUP trend",
  goal: "Ride confirmed uptrends in SOL and JUP, move to USDC on reversals. Preserve capital first.",
  markets: ["SOL", "JUP"],
  ...modeSpecFields("crypto-spot"), // venue "solana", quote "USDC"
  model: "example-model",
  intervalSec: 300,
  profile: "conservative",
  risk,
  params,
};

const env = {
  presets: PRESETS,
  marketSymbols: ["SOL", "JUP", "BONK", "WIF", "SPYx", "NVDAx"],
  models: [{ id: "example-model", label: "Example", provider: "primary", tier: "standard", enabled: true }],
  intervals: { min: 300, premiumMin: 60 },
  isPremium: false,
};

const ok = validateSpec(spec, env);
console.log("valid spec      ->", { ok: ok.ok, errors: ok.errors, specHash: ok.specHash, sameAsRaw: ok.specHash === specHashOf(spec) });

const broken = { ...spec, markets: ["SOL", "DOGE"], intervalSec: 60, risk: { ...spec.risk, maxTradeBps: 0 } };
const bad = validateSpec(broken, env);
console.log("broken spec     ->", { ok: bad.ok, errors: bad.errors });

const fixed = { ...broken, risk: spec.risk };
console.log("after one fix   ->", validateSpec(fixed, env).errors);
