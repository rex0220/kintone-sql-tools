# kSQL CLI Live E2E Checklist

- Updated: 2026-04-06
- Scope: CLI Ver.1

## 1. Pre-check

1. `npm run build:cli`
2. Use the exact app token for target app
3. Confirm base URL origin (`https://<subdomain>.cybozu.com` or `https://<subdomain>.kintone.com`)

## 2. Connectivity/Auth

Use diagnostic single-record API first:

```powershell
node dist-cli/ksql.js --debug-url --debug-headers `
  --base-url https://<subdomain>.cybozu.com `
  --token '<APP_TOKEN>' `
  --app 88 `
  --diag-record-id 1
```

Pass criteria:

1. No `CB_IL02`
2. JSON response is returned
3. Debug headers show masked auth and `Content-Type=(none)` for GET

## 3. Query Execution

```powershell
node dist-cli/ksql.js --debug `
  --base-url https://<subdomain>.cybozu.com `
  --token '<APP_TOKEN>' `
  -e "SELECT * FROM APP88 LIMIT 5"
```

Pass criteria:

1. Result rows are returned
2. Exit code is `0`
3. `rowCount=<n>` is printed

## 3.1 Query Execution (userpass)

```powershell
node dist-cli/ksql.js --debug `
  --base-url https://<subdomain>.cybozu.com `
  --auth userpass `
  --username '<user>' `
  --password '<pass>' `
  -e "SELECT * FROM APP88 LIMIT 5"
```

Pass criteria:

1. Result rows are returned
2. Exit code is `0`
3. Authentication works without token arguments

## 4. DML Safety Policy Check

```powershell
node dist-cli/ksql.js --base-url https://<subdomain>.cybozu.com --token '<APP_TOKEN>' -e "UPDATE APP88 SET 状態='完了' WHERE レコード番号=1"
```

Pass criteria:

1. Command fails with non-zero
2. Message indicates `--allow-dml` is required

## 4.1 DML Execution Check (`--allow-dml`)

```powershell
node dist-cli/ksql.js --base-url https://<subdomain>.cybozu.com --token '<APP_TOKEN>' --allow-dml --yes --dml-max-rows 1 -e "UPDATE APP88 SET 状態='完了' WHERE レコード番号=1"
```

Pass criteria:

1. Command succeeds (exit code `0`)
2. Affected rows are printed

## 4.2 WHERE Guard Check

```powershell
node dist-cli/ksql.js --base-url https://<subdomain>.cybozu.com --token '<APP_TOKEN>' --allow-dml -e "UPDATE APP88 SET 状態='完了'"
```

Pass criteria:

1. Command fails with non-zero
2. Message indicates `WHERE` guard rejection (or `--allow-without-where` required)

## 5. Output Modes Check

1. `--format table`
2. `--format json`
3. `--format csv`
4. `--output out.txt`

Pass criteria:

1. Each mode prints expected format
2. `--output` writes file correctly

## 5.1 Console Operation Log Sample

```text
ksql> :show config
profile=dev
format=(default)
dryrun=off
...
ksql> SELECT * FROM APP88 LIMIT 1;
...
ksql> :history
1. SELECT * FROM APP88 LIMIT 1
ksql> :last
SELECT * FROM APP88 LIMIT 1
ksql> :save out.txt
saved: out.txt
ksql> :save --append out.txt
saved (append): out.txt
ksql> :exit
```

## 6. Troubleshooting

If `CB_IL02` appears:

1. Run section 2 first (`--diag-record-id`)
2. Confirm token-app match
3. Confirm base URL origin
4. Attach debug logs (`--debug-url --debug-headers`) to issue
