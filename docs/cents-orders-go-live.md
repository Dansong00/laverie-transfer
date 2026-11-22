# First Cents Orders import

## Verify the export before merge

Use the original Cents file in an approved private workspace. Keep the raw file out of Git, Board messages, and PR comments. Record only the field mappings and aggregate counts.

- Confirm file type, delimiter, encoding, headers, and whether the report contains title or footer rows. The importer accepts comma-separated UTF-8 with an optional BOM.
- Match both location labels to the configured store IDs. Compare ticket codes with the same orders in webhook receipts. Verify that numeric padding is formatting within a store and that the report has one row per order. Use the original export to preserve ticket spelling.
- Compare every status label with its webhook value and transfer eligibility. The provisional allowlist covers Submitted, In Progress, Ready for Pickup, Completed/Complete, and Cancelled/Canceled. Unmapped labels stop the import. Confirm the treatment of picked-up, refunded, and voided orders before adding any mapping.
- Check date-only values, local times, explicit offsets, and any updated-at or export-time field. Record the snapshot time separately. The import writes a null source timestamp.
- Run the dry run with the intended store allowlist. It prints record counts by store and status and reports invalid records without printing their contents. Compare totals with the export and investigate repeated order codes or multiple service rows. A syntax or encoding error can make the rest of the file unreadable.

```bash
pnpm cents:backfill --dry-run /private/path/orders.csv
```

## Production sequence

1. Enable the production webhook and verify intake for the intended stores.
2. Generate a **fresh** Orders export after intake is working. An older export can list an order as open even though it completed before the webhook started.
3. Dry-run that exact file. Check the counts against Cents and verify the configured destination database.
4. Import promptly with `pnpm cents:backfill /private/path/orders.csv`. Check inserted and already-present counts against the validated report. A retry skips existing snapshots.

If the order-identity migration finds two stored codes with the same normalized value in one store, the unique index fails to build. Inspect the matching orders, receipt IDs, and batch references before deciding how to reconcile them. The migration preserves existing ticket spellings and memberships.
