# ADR 0002 — EWMA + z-score detector, not an LSTM

**Status:** accepted

## Context

The original concept called for an LSTM (or Isolation Forest) to classify traffic
bursts as "organic" vs "bot attack".

## Decision

Use a per-key **EWMA mean/variance with a z-score test**, not a learned model.

## Rationale

- **No labelled data.** Supervised anomaly detection needs labelled "attack" vs
  "organic" traffic. We don't have it, and manufacturing it would make the model
  a demo of the labels, not of the detector.
- **Explainability.** Every decision reduces to "this key's rate is N standard
  deviations above its own recent baseline." That is auditable and defensible —
  important when the output changes who gets rate limited.
- **Bounded, predictable behaviour.** A simple statistic with hard clamps on the
  resulting limit (see ADR 0004 / policy) cannot do anything surprising. An LSTM's
  failure modes are far harder to bound.
- **Cost.** No training pipeline, no model artefacts, no inference runtime.

## Consequences

- The detector won't capture complex seasonal patterns (e.g. daily cycles) that a
  richer model might. That is acceptable for a first version and noted as future
  work; a seasonality-aware baseline is a natural next step that stays explainable.
- Anomalous points are excluded from the baseline so a sustained attack can't
  slowly "train" the limiter into accepting it.
