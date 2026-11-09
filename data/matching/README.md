# Labelled pairs for the same-product model

- `pairs.jsonl`: 1,200 listing/product pairs taken from the live catalogue on
  2026-11-09 (700 waiting for review, 500 linked automatically), with each
  side's store, title, brand, photo and last price.
- `labels.txt`: one line per pair, `<id> <1|0|u>`: same product, different,
  or can't tell from the titles (left out of training). "Same" means what a
  shopper compares prices on: same brand, model, size or pack, flavour, scent
  or shade; a colour alone doesn't make it different. Labelled by Claude from
  titles and prices; a person's decisions at `/review` should override them.

Retrain after adding labels or clues:

    node scripts/train-matcher.ts --dry --verbose   # measure, list the mistakes
    node scripts/train-matcher.ts                   # measure and write worker/pairWeights.ts
