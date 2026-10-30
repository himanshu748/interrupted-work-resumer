# Sponsor workflow and safe local setup

Interrupted Work Resumer uses the following product workflow:

Nemotron proposes a cited resume plan from explicitly selected local excerpts and context. Tavily retrieves public documentation for a blocker; selected passages feed a separate Nemotron next-step checklist.

The local watcher prepares continuation artifacts only while the server runs. Suggestions do not execute saved free-text actions or resolve blockers.

The application separates local observations, Tavily search receipts, Nemotron inference receipts and any remote execution receipts. A configured key or model catalog listing is not proof of successful inference. Injected test transports remain fixtures.

## Configure only after checking provider funding

The local product works with every value blank. Copy `.env.example` privately into this checkout's `.env` only when configuring it. Never copy another checkout's `.env` or a historical account allowance. `.gitignore` excludes environment files and `work/`.

Live paid-capable actions default to blocked. For each provider being used, the owner must verify sufficient free credits and the provider's actual stop-at-limit/no-payment-method setting. Only then set that provider's `*_FREE_ONLY_CONFIRMED`, canonical UTC `*_FREE_VERIFIED_AT`, and bounded `*_FREE_REQUEST_LIMIT`. Attestations expire after 24 hours. These local flags cannot inspect the provider balance or disable billing. Limits count attempts, not dollars; uncertain and failed outcomes consume slots without automatic refunds or retries.

When the four products share an account, configure the same **absolute** `FREE_USAGE_LEDGER_DIR` in each locally managed environment. Otherwise each fresh checkout has an independent empty ledger. Keep the shared directory private, preserve existing reservations, and do not reset an allowance by changing checkout or deleting the ledger. A blank value uses this checkout's `work/free-usage/` directory. Relative paths and symlink components are refused.

- `NEBIUS_API_KEY`: Token Factory inference. `NEBIUS_MODEL_ID` may select an exact available NVIDIA Nemotron model; otherwise discovery chooses from the actual account catalog. Only the official endpoint is accepted.
- `TAVILY_API_KEY`: one explicit basic search with up to five results and at most one reported search credit. Keep pay-as-you-go disabled in the account. No project files are automatically sent; only the reviewed query is disclosed.
- `DEEPGRAM_API_KEY`: separate narration funding and credentials, not Nebius credit coverage. The script uses Aura-2 Thalia and a reviewed text file of at most 2,000 characters.

## Explicit research journey

1. Enter a public documentation question without credentials or private client information.
2. Review the disclosure and authorize **Search with Tavily · 1 credit**.
3. Inspect the returned URLs/passages and choose up to three sources.
4. Review the selected-data disclosure, authorize **Draft cited checklist with Nemotron**, and inspect its citations.
5. Download the research JSON and cited checklist. Search and inference remain separate receipts. Literal quotation matching does not establish semantic correctness.

Saved searches and cited checklists reopen from this device after a reload. Use the saved-research selector to inspect an earlier record. Reopening checks its stored hashes and does not repeat a search or inference; original dates, provider receipts and fixture/live labels remain attached. Invalid or altered records are not presented as verified saved evidence. Failed checklist attempts retain sanitized diagnostics separately from successful results. Legacy records that cite a heading or bare list marker remain byte-for-byte preserved and show a derived warning when reopened. New requests filter those weak quotation choices before inference. These filters do not establish that a quoted passage supports the generated claim; review that relationship directly.

No quote changes, saved tasks or robot actions run automatically from research. Merely loading the page or opening provider status performs no search or inference.

## Preflight and narration

`npm run preflight:tokenfactory` lists the account model catalog; it does not claim inference. `npm run preflight:tokenfactory:chat` makes a bounded inference request only after the applicable free-only controls pass. These are explicit network actions, separate from local tests.

Prepare narration without network traffic:

```sh
npm run narration -- --input demo/narration.txt --output work/narration.mp3
```

After funding, script and generation authorization are confirmed, use a new output name in an existing directory and load the private environment explicitly:

```sh
node --env-file=.env scripts/deepgram_narration.mjs \
  --input demo/narration.txt --output work/narration.mp3 \
  --max-characters 2000 --generate
```

The narration CLI sends one bounded request, validates MP3 framing, refuses existing outputs and writes a hash/metadata receipt. It does not retry. Listen to the audio and measure the final video; fixtures do not establish voice quality or duration. `demo/storyboard.md` marks shots that still need actual runtime evidence.

The checked-in scripts and fixtures do not assert that this local checkout is funded, deployed, submitted or production-ready. See `RELEASE-VALIDATION.md` for the precise current test scope after preparation.

The separate [recorded proof status](demo/live-proof-status.md) distinguishes observed shared-workspace calls, unresolved semantic review and this checkout’s fixture tests.
