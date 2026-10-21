# Project license options — decision pending

No license is selected by this document, and no `LICENSE` file has been added. The package remains private. The owner must choose the license and copyright holder before calling FlowLens open source or authorizing redistribution. See [LICENSE-DECISION.md](../LICENSE-DECISION.md).

Two plausible permissive choices are:

| Choice     | Why consider it                                                                                                                                           | Obligations to preserve                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIT        | Short, familiar terms for a small reusable application. A reasonable default if the owner values simplicity and does not require an express patent grant. | Preserve the copyright and permission notice in copies or substantial portions. The text disclaims warranty and liability.                                                         |
| Apache-2.0 | An alternative when an explicit contributor patent grant and its patent-litigation termination condition matter.                                          | Include the license, mark modified files, retain applicable notices, and preserve relevant upstream NOTICE attributions when present. The license does not grant trademark rights. |

These summaries follow the official [MIT text](https://opensource.org/license/mit) and [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), especially Apache sections 3, 4 and 6. The recommendation is nonbinding: MIT is the simpler candidate for this scope; Apache-2.0 is the stronger candidate when express patent terms are a requirement. Neither has been applied.

Before choosing, confirm authorship and rights to application code, synthetic fixtures, documentation, branding and assets. Keep dependency licenses and [required third-party notices](../THIRD_PARTY_NOTICES.md) separate from the project license. A permissive code license does not authorize redistribution of provider responses, proprietary labels, user notes, private investigations or someone else's source. Public availability of a blockchain record does not resolve a provider dataset's terms.

After an explicit owner decision, add the exact selected license text with the confirmed copyright holder, update package metadata and the pending-license documents, then update the release script's deliberate pending-license guard. Re-run the archive review. Do not infer authorization from this comparison.
