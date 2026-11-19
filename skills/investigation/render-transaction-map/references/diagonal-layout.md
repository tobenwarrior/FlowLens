# Diagonal transaction map

Use this layout for an evidence map that highlights one or two wallets, a few material sources and a settlement route. All amounts, dates, labels and links come from the verified manifest selection.

## Place the nodes

Use a 1760 by 960 white SVG viewBox as a starting point. Place Wallet A around (720, 340) and Wallet B around (720, 610). Put funding sources left of the targets, shared direct recipients to their right, and the final destination farther right. Leave a separate lane above or below the targets for the important settlement path so the outgoing arrows and funding labels stay legible. These coordinates are starting points. Add space between nodes or grow the canvas when adding another route.

- Use circles of radius 36–38 for the traced wallets and 28–33 for most counterparties. Make the tracked wallet captions the largest. Use neutral wallet and bridge glyphs when branding would confuse the claim or the entities.
- For a suspected affiliation, use a segmented purple outline, a visible question mark and a “Possible [entity] link” caption. Use the exact provider label when one exists and cite it in the receipt companion. Separate a provider label from analyst wording about affiliation.
- Use straight or gently diagonal arrows for most edges. For two transfers in opposite directions between the same wallets, put one arc on either side of the pair and label each arrow separately.

## Use consistent marks and labels

| Role | Style |
| --- | --- |
| Funding or bridge | Teal `#008294` |
| Tracked-wallet flow or reciprocal transfer | Muted red `#c43c59` |
| Main evidenced settlement path | Navy `#3f4784`, about 4 px |
| Custody sweep | Muted plum `#b84c7e` |
| Supporting route and generic counterparty | Slate `#5b7187`, about 1.7–2.8 px |
| Uncertain affiliation | Violet `#7046b6` segmented ring |
| Text | Dark `#132431`, with muted secondary text `#4e6071` |

Line weight expresses investigative emphasis. Encode amounts as text and keep chain and asset subtotals separate, even on the same arrow between the same addresses. Give each caption its own space. Put the amount close to the straight segment and its date or range, chain and transfer count beside it. Mark rounding explicitly where the graphic needs it and retain the exact amount in the receipt index.

## Inspect the export

- Derive each directed arrow from its verified member IDs. Recompute all amounts and counts. Confirm the SVG arrowhead lands at the matching recipient and the label belongs to that edge.
- Keep the full copyable addresses and correct-chain receipt URLs in a companion table. The SVG node links can also carry full addresses. Each arrow links to its route or provides the member receipt list.
- Inspect the rendered SVG and PNG at intended viewing size. Check that arrowheads and amounts are visible, no label crosses a line or another label, and no edge looks connected to an unrelated node. Keep alternative layouts as separate previews.
- Export the graph with the approved composition. A terse scope note in the companion can explain selected routes, omitted evidence and label confidence. Keep narrative titles, legends and market-position figures off a graph-only image unless requested.
