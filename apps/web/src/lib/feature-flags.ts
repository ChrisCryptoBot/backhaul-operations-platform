function isEnabled(name: string): boolean {
  return process.env[name] === "true";
}

export const featureFlags = {
  semanticParityReady: isEnabled("FF_SEMANTIC_PARITY_READY"),
  enableBehavioralUxContracts: isEnabled("FF_BEHAVIORAL_UX_CONTRACTS")
};

