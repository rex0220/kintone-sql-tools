---
name: CLI Live E2E
about: kSQL CLI の実接続確認結果を報告する
title: "[CLI-E2E] "
labels: ["cli", "e2e"]
assignees: []
---

## Environment

- Date:
- Base URL:
- Auth mode: token / userpass
- App ID:
- CLI command:

## Checklist

- [ ] `--diag-record-id` が成功した
- [ ] `SELECT * FROM APPxx LIMIT 5` が成功した
- [ ] 非SELECTが拒否された
- [ ] `--format json` が期待どおり
- [ ] `--console` で `;` 実行できた

## Logs (masked)

```text
paste debug-url/debug-headers logs
```

## Notes

- 
