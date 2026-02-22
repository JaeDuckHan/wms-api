# storage_snapshots MVP Smoke Check

## 1) Generate snapshots (today)
```bash
curl -X POST "http://localhost:3100/api/dashboard/storage/snapshots/generate" \\
  -H "Authorization: Bearer <JWT>"
```

## 2) Generate snapshots (specific date)
```bash
curl -X POST "http://localhost:3100/api/dashboard/storage/snapshots/generate?date=2026-02-21" \\
  -H "Authorization: Bearer <JWT>"
```

## 3) Get storage dashboard (today)
```bash
curl "http://localhost:3100/api/dashboard/storage" \\
  -H "Authorization: Bearer <JWT>"
```

## 4) Get storage dashboard with filters
```bash
curl "http://localhost:3100/api/dashboard/storage?date=2026-02-21&warehouseId=1&clientId=1" \\
  -H "Authorization: Bearer <JWT>"
```

## 5) SQL verification for one date
```sql
SELECT warehouse_id, client_id, snapshot_date, total_cbm, total_pallet, total_sku
FROM storage_snapshots
WHERE snapshot_date = '2026-02-21'
ORDER BY warehouse_id, client_id;
```
