# Changelog

## 0.1.0

First packaged release. Previously, consumers `cp`'d `probity.config.ts` +
`rules/` + `scripts/` into their project; rule fixes in this fork never
reached them. Rules and scripts are now a versioned npm package
(`@jjchill/probity-rules`); the config stays project-owned and imports
preset factories from the package.

Migrating from the copied-templates layout:

- `./rules/<x>.js` imports → `@jjchill/probity-rules/rules/<x>`
- `npx tsx scripts/scope-report.ts` → `npx probity-scope-report`
- `node scripts/spec-parity.mjs` → `npx probity-spec-parity`

Or run `/probity-update`, which detects the legacy layout and offers to
migrate it for you.
