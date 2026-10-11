pnpm test:m10
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm test:e2e-p0-m1
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm test:e2e-p0-m2
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm test:e2e-p0-m3
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm test:e2e-p0-m4
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm test:e2e-p0-m5
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm test:m11
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm test:search-rank-policy
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm test:plugin
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm plugin:validate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
